// Venue pons v2 (Robinhood Chain). Regra da casa: este processo NUNCA assina
// nada em nome do usuario. Ele le a chain, monta calldata, simula com eth_call
// e devolve a transacao crua para a carteira assinar no navegador. As unicas
// chaves que existem aqui sao as dos agentes (carteiras dos tokens).
//
// Todo venue exporta a mesma interface (ver chain.js). Valores "quote" sao a
// unidade em que o usuario fala: aqui, ETH em wei.
import {
  createPublicClient, createWalletClient, http, defineChain, encodeFunctionData, decodeFunctionResult, decodeErrorResult,
  parseEther, formatEther, formatUnits, getAddress, parseEventLogs, verifyMessage,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CHAIN, CONTRACTS, ZERO_ADDRESS, LIMITS, V, TOKEN_URL, QUOTE } from '../config.js';
import { FACTORY_ABI, ROUTER_ABI, CURVE_ABI, ERC20_ABI, ESCROW_ABI, ALL_ERRORS, DEAD_ADDRESS } from '../abi.js';

export const VENUE = 'pons';
export const NAME = V.name;
export const SHORT = V.short;
export const MARKET = V.market;
export const DOCS_URL = V.docsUrl;
export const supportsHandover = true;   // criador pode passar as taxas ao agente (transferCreatorFeeRecipient)
export const agentMustLaunch = false;   // o agente pode ser ligado a um token ja existente

export const chain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.native,
  rpcUrls: { default: { http: [CHAIN.rpc] } },
  blockExplorers: { default: { name: 'Blockscout', url: CHAIN.explorer } },
});

export const client = createPublicClient({
  chain,
  transport: http(CHAIN.rpc, { timeout: 20_000, retryCount: 2 }),
});

const factory = { address: CONTRACTS.factory, abi: FACTORY_ABI };

// Unidades: o usuario fala em ETH; internamente, wei.
export const parseAmount = (s) => parseEther(String(s));
export const formatAmount = (wei) => formatEther(wei);
export const quoteSymbol = QUOTE.symbol;

export const links = ({ token, curve, txHash }) => ({
  venue: token ? TOKEN_URL.replace('{token}', token) : null,
  pons: token ? TOKEN_URL.replace('{token}', token) : null,
  explorerToken: token ? `${CHAIN.explorer}/token/${token}` : null,
  explorerCurve: curve ? `${CHAIN.explorer}/address/${curve}` : null,
  explorerTx: txHash ? `${CHAIN.explorer}/tx/${txHash}` : null,
});

// ---------------------------------------------------------------------------
// Termos do protocolo (taxa, supply, teto de creator tax). Cache curto: a pons
// pode mudar isso pelo owner, e o expectedEconomics pina o que foi cotado.
let termsCache = { at: 0, value: null };
export async function protocolTerms({ fresh = false } = {}) {
  if (!fresh && termsCache.value && Date.now() - termsCache.at < 60_000) return termsCache.value;
  const configId = LIMITS.launchConfigId;
  const [launchFee, maxCreatorTaxBps, launchEnabled, config, economics] = await Promise.all([
    client.readContract({ ...factory, functionName: 'launchFee' }),
    client.readContract({ ...factory, functionName: 'maxCreatorTaxBps' }),
    client.readContract({ ...factory, functionName: 'launchEnabled' }),
    client.readContract({ ...factory, functionName: 'getLaunchConfig', args: [configId] }),
    client.readContract({ ...factory, functionName: 'previewLaunchEconomics', args: [configId, ZERO_ADDRESS] }),
  ]);
  const value = {
    venue: VENUE,
    configId,
    launchFee,
    launchFeeEth: formatEther(launchFee),
    launchFeeQuote: formatEther(launchFee),
    maxCreatorTaxBps: Number(maxCreatorTaxBps),
    launchEnabled,
    supply: config.supply,
    supplyTokens: formatUnits(config.supply, 18),
    curveFeeBps: Number(config.curveFeeBps),
    phantomQuote: config.phantomQuote,
    graduationThreshold: config.graduationThreshold,
    graduationThresholdEth: formatEther(config.graduationThreshold),
    configEnabled: config.enabled,
    economics,
    // Assinatura dos termos: se mudar entre a previa e a assinatura, avisamos.
    pin: economics,
    fetchedAt: new Date().toISOString(),
  };
  termsCache = { at: Date.now(), value };
  return value;
}

// Resumo em texto para o conector e para /api/terms.
export function termsSummary(t) {
  return {
    venue: NAME, network: CHAIN.name, chainId: CHAIN.id, unit: quoteSymbol,
    launchFee: t.launchFeeEth, supply: t.supplyTokens, maxCreatorTax: `${t.maxCreatorTaxBps / 100}%`, maxCreatorTaxBps: t.maxCreatorTaxBps,
    curveTradeFee: `${t.curveFeeBps / 100}%`, graduatesAt: `${t.graduationThresholdEth} ETH raised on the curve`, graduatesAtValue: t.graduationThresholdEth,
    launchesOpenToEveryone: t.launchEnabled, devBuyCap: `${LIMITS.maxDevBuyBps / 100}% of supply`,
    launchAndBuyInOneTransaction: true, market: MARKET,
    contracts: { factory: CONTRACTS.factory, router: CONTRACTS.router, feeEscrow: CONTRACTS.feeEscrow },
  };
}

export const canLaunch = (address) => client.readContract({ ...factory, functionName: 'canLaunch', args: [address] });

// ---------------------------------------------------------------------------
// Montagem da transacao. Com dev buy vai pelo router (lanca + compra na mesma
// transacao, sem janela para sniper); sem dev buy vai direto na factory.
export function buildLaunchTx({ params, devBuyWei, recipient, launchFee, minTokensOut = 0n, configId = LIMITS.launchConfigId }) {
  const tuple = {
    name: params.name,
    symbol: params.symbol,
    logo: params.logo || '',
    description: params.description || '',
    socials: {
      twitter: params.socials?.twitter || '',
      telegram: params.socials?.telegram || '',
      discord: params.socials?.discord || '',
      website: params.socials?.website || '',
      farcaster: params.socials?.farcaster || '',
    },
    creatorFeeRecipient: params.creatorFeeRecipient,
    creatorTaxBps: params.creatorTaxBps,
    buybackEnabled: !!params.buybackEnabled,
    expectedEconomics: params.expectedEconomics,
    salt: params.salt,
  };
  if (devBuyWei > 0n) {
    return {
      via: 'router',
      to: CONTRACTS.router,
      data: encodeFunctionData({
        abi: ROUTER_ABI, functionName: 'launchAndBuy',
        args: [tuple, configId, ZERO_ADDRESS, devBuyWei, minTokensOut, recipient, []],
      }),
      value: launchFee + devBuyWei,
    };
  }
  return {
    via: 'factory',
    to: CONTRACTS.factory,
    data: encodeFunctionData({ abi: FACTORY_ABI, functionName: 'launchToken', args: [tuple, configId, ZERO_ADDRESS] }),
    value: launchFee,
  };
}

export function buildBuyTx({ curve, quoteInWei, minTokensOut, recipient }) {
  return {
    via: 'curve',
    to: curve,
    data: encodeFunctionData({ abi: CURVE_ABI, functionName: 'buy', args: [quoteInWei, minTokensOut, recipient] }),
    value: quoteInWei,
  };
}

// ---------------------------------------------------------------------------
// Simulacao. `fund: true` usa state override para dar saldo ao remetente, o que
// permite simular antes de saber se a carteira tem ETH (e com um endereco
// descartavel, para a previa no chat). A RPC publica da Robinhood aceita.
export async function simulate({ from, to, data, value, fund = true }) {
  const opts = { account: from, to, data, value };
  if (fund) opts.stateOverride = [{ address: from, balance: value + parseEther('0.05') }];
  const res = await client.call(opts);
  return res.data;
}

export function decodeLaunchResult(via, data) {
  if (via === 'router') {
    const [token, curve, tokensOut] = decodeFunctionResult({ abi: ROUTER_ABI, functionName: 'launchAndBuy', data });
    return { token, curve, tokensOut };
  }
  const [token, curve] = decodeFunctionResult({ abi: FACTORY_ABI, functionName: 'launchToken', data });
  return { token, curve, tokensOut: 0n };
}

export function decodeBuyResult(data) {
  return { tokensOut: decodeFunctionResult({ abi: CURVE_ABI, functionName: 'buy', data }) };
}

export async function estimateGas({ from, to, data, value }) {
  return client.estimateGas({ account: from, to, data, value });
}

export const getBalance = (address) => client.getBalance({ address });

// Traduz o revert do viem em algo que o chat consegue explicar.
const HUMAN = {
  NotWhitelisted: 'pons is only accepting launches from whitelisted wallets right now',
  NotApprovedLauncher: 'pons is only accepting launches from whitelisted wallets right now',
  LaunchFeeNotPaid: 'the launch fee sent does not match what pons charges now; preview again',
  NativeValueMismatch: 'the ETH sent does not match launch fee + dev buy; preview again',
  LaunchEconomicsMismatch: 'pons changed its launch terms since this preview; preview again',
  CreatorTaxTooHigh: 'creator tax is above the maximum pons allows',
  InvalidTokenParams: 'name and ticker cannot be empty',
  LaunchConfigDisabled: 'this pons launch config is disabled',
  ExemptionListTooLong: 'too many snipe-tax exemptions',
};

function revertData(error) {
  let e = error;
  for (let i = 0; e && i < 8; i++) {
    if (typeof e.data === 'string' && e.data.startsWith('0x') && e.data.length > 2) return e.data;
    if (e.data && typeof e.data.data === 'string') return e.data.data;
    e = e.cause;
  }
  return null;
}

export function explainRevert(error) {
  const data = revertData(error);
  if (data) {
    try {
      const d = decodeErrorResult({ abi: ALL_ERRORS, data });
      const args = (d.args || []).map(String).join(', ');
      return { code: d.errorName, message: HUMAN[d.errorName] || `${d.errorName}${args ? ` (${args})` : ''}` };
    } catch { /* erro desconhecido: cai no texto */ }
  }
  const msg = String(error?.shortMessage || error?.message || error);
  if (/insufficient funds/i.test(msg)) return { code: 'INSUFFICIENT_FUNDS', message: 'the wallet does not hold enough ETH for this transaction' };
  return { code: 'REVERT', message: msg.split('\n')[0].slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Cotacao de um lancamento (previa no chat e bind na pagina). Recebe o pedido
// ja validado. Devolve a transacao, o que ela deve produzir e o custo.
class QuoteError extends Error { constructor(message, code) { super(message); this.code = code; } }
const bpsOf = (part, whole) => (whole > 0n ? Number((part * 10_000n) / whole) : 0);
const pct = (bps) => `${(bps / 100).toFixed(2)}%`;

async function simulateLaunch({ terms, params, devBuyWei, recipient, from, minTokensOut = 0n }) {
  const tx = buildLaunchTx({ params, devBuyWei, recipient, launchFee: terms.launchFee, minTokensOut });
  try {
    const data = await simulate({ from, to: tx.to, data: tx.data, value: tx.value, fund: true });
    return { tx, ...decodeLaunchResult(tx.via, data) };
  } catch (e) {
    const r = explainRevert(e);
    throw new QuoteError(`launch simulation failed: ${r.message}`, r.code);
  }
}

// Busca binaria pela maior dev buy que fica abaixo do teto. So roda quando o
// pedido passou do teto; cada passo e um eth_call.
async function clampDevBuy({ terms, params, recipient, from, requestedWei, capBps }) {
  let lo = 0n, hi = requestedWei, best = null;
  const floor = parseEther('0.00001');
  for (let i = 0; i < 16 && hi - lo > floor; i++) {
    const mid = (lo + hi) / 2n;
    if (mid === 0n) break;
    const sim = await simulateLaunch({ terms, params, devBuyWei: mid, recipient, from });
    if (bpsOf(sim.tokensOut, terms.supply) <= capBps) { best = { wei: mid, sim }; lo = mid; } else hi = mid;
  }
  return best;
}

export async function quoteLaunch({ input, devBuy, salt, from, terms, exact = false }) {
  const warnings = [];
  if (!terms.configEnabled) throw new QuoteError('pons has this launch config disabled right now', 'CONFIG_DISABLED');
  if (input.creatorTaxBps > terms.maxCreatorTaxBps) {
    throw new QuoteError(`creator tax ${pct(input.creatorTaxBps)} is above the pons maximum of ${pct(terms.maxCreatorTaxBps)}`, 'CREATOR_TAX_TOO_HIGH');
  }
  const params = { ...input, creatorFeeRecipient: input.creatorFeeRecipient || from, expectedEconomics: terms.economics, salt };
  let devBuyWei = devBuy;
  let sim = await simulateLaunch({ terms, params, devBuyWei, recipient: from, from });
  if (devBuyWei > 0n) {
    const bps = bpsOf(sim.tokensOut, terms.supply);
    if (bps > LIMITS.maxDevBuyBps) {
      const clamped = await clampDevBuy({ terms, params, recipient: from, from, requestedWei: devBuyWei, capBps: LIMITS.maxDevBuyBps });
      if (!clamped) throw new QuoteError(`even the smallest dev buy exceeds the ${pct(LIMITS.maxDevBuyBps)} cap`, 'DEV_BUY_CAP');
      warnings.push(`dev buy reduced from ${formatEther(devBuyWei)} to ${formatEther(clamped.wei)} ETH so it stays under ${pct(LIMITS.maxDevBuyBps)} of supply`);
      devBuyWei = clamped.wei;
      sim = clamped.sim;
    }
  }
  let tx = sim.tx;
  if (exact && devBuyWei > 0n) {
    // Piso de slippage: a curva nasce na mesma transacao, 1% cobre o arredondamento.
    tx = buildLaunchTx({ params, devBuyWei, recipient: from, launchFee: terms.launchFee, minTokensOut: (sim.tokensOut * 99n) / 100n });
  }
  return {
    tx: { to: tx.to, data: tx.data, value: tx.value },
    pre: [],
    predicted: { token: sim.token, curve: sim.curve },
    tokensOut: sim.tokensOut,
    devBuy: devBuyWei,
    devBuyBps: bpsOf(sim.tokensOut, terms.supply),
    creatorFeeRecipient: params.creatorFeeRecipient,
    warnings,
    route: tx.via === 'router' ? 'pons launch-and-buy router (launch and dev buy in one transaction)' : 'pons factory',
    cost: { launchFee: terms.launchFeeEth, devBuy: formatEther(devBuyWei), total: formatEther(terms.launchFee + devBuyWei), unit: quoteSymbol },
    terms: { launchFee: terms.launchFeeEth, supply: terms.supplyTokens, pin: terms.economics, economics: terms.economics },
    extra: { creatorTax: pct(input.creatorTaxBps), buybackEnabled: !!input.buybackEnabled },
  };
}

// Compra na curva.
export async function quoteBuy({ token, amount, from, exact = false }) {
  const info = await tokenInfo(token);
  if (!info) throw new QuoteError('this address is not a pons v2 launch on this network', 'NOT_VENUE_TOKEN');
  if (!info.canBuy) throw new QuoteError(`${info.symbol} has left the bonding curve (${info.phase}); the connector only buys on the curve`, 'GRADUATED');
  const sim = await simulateBuy({ curve: info.curve, quoteInWei: amount, recipient: from, from });
  // Outros podem negociar antes de a transacao entrar: 3% de folga.
  const minTokensOut = exact ? (sim.tokensOut * 97n) / 100n : 0n;
  const tx = buildBuyTx({ curve: info.curve, quoteInWei: amount, minTokensOut, recipient: from });
  return { tx: { to: tx.to, data: tx.data, value: tx.value }, pre: [], tokensOut: sim.tokensOut, info };
}

async function simulateBuy({ curve, quoteInWei, recipient, from, minTokensOut = 0n }) {
  const tx = buildBuyTx({ curve, quoteInWei, minTokensOut, recipient });
  try {
    const data = await simulate({ from, to: tx.to, data: tx.data, value: tx.value, fund: true });
    return { tx, ...decodeBuyResult(data) };
  } catch (e) {
    const r = explainRevert(e);
    throw new QuoteError(`buy simulation failed: ${r.message}`, r.code);
  }
}

// Saldo x custo, e estimativa de gas a partir da carteira real.
export async function fundingCheck({ wallet, tx, pre = [] }) {
  const balance = await getBalance(wallet);
  const value = tx.value + pre.reduce((s, p) => s + (p.value || 0n), 0n);
  try {
    const gas = await estimateGas({ from: wallet, to: tx.to, data: tx.data, value: tx.value });
    return { ok: true, balance: formatEther(balance), required: formatEther(value), unit: quoteSymbol, message: null, gas };
  } catch (e) {
    const r = explainRevert(e);
    const short = balance < value;
    return {
      ok: false, balance: formatEther(balance), required: formatEther(value), unit: quoteSymbol, gas: null,
      message: short ? `this wallet holds ${formatEther(balance)} ETH and needs at least ${formatEther(value)} ETH plus gas on ${CHAIN.name}` : r.message,
    };
  }
}

// ---------------------------------------------------------------------------
// Acompanhamento da transacao assinada.
export const getTransaction = (hash) => client.getTransaction({ hash }).catch(() => null);

export async function waitForReceipt(hash) {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 15 * 60_000, pollingInterval: 2_000 });
  const launched = parseEventLogs({ abi: FACTORY_ABI, eventName: 'TokenLaunched', logs: receipt.logs, strict: false })[0];
  const buys = parseEventLogs({ abi: CURVE_ABI, eventName: 'CurveBuy', logs: receipt.logs, strict: false });
  const tokensOut = buys.reduce((acc, l) => acc + (l.args?.tokensOut ?? 0n), 0n);
  return {
    ok: receipt.status === 'success',
    blockNumber: receipt.blockNumber,
    token: launched?.args?.token ?? null,
    curve: launched?.args?.curve ?? null,
    tokensOut,
  };
}

// ---------------------------------------------------------------------------
// Estado de um token lancado na pons v2.
export async function tokenInfo(address) {
  const token = getAddress(address);
  const launched = await client.readContract({ ...factory, functionName: 'getLaunchedToken', args: [token] }).catch(() => null);
  if (!launched?.exists) return null;
  const curve = { address: launched.curve, abi: CURVE_ABI };
  const erc20 = { address: token, abi: ERC20_ABI };
  const [name, symbol, totalSupply, reserves, realQuote, sellable, graduated, readyToGraduate] = await Promise.all([
    client.readContract({ ...erc20, functionName: 'name' }),
    client.readContract({ ...erc20, functionName: 'symbol' }),
    client.readContract({ ...erc20, functionName: 'totalSupply' }),
    client.readContract({ ...curve, functionName: 'getReserves' }),
    client.readContract({ ...curve, functionName: 'realQuoteReserve' }),
    client.readContract({ ...curve, functionName: 'sellableTokens' }),
    client.readContract({ ...curve, functionName: 'graduated' }),
    client.readContract({ ...curve, functionName: 'readyToGraduate' }),
  ]);
  const [quoteReserve, tokenReserve] = reserves;
  const priceEth = tokenReserve > 0n ? Number(quoteReserve) / Number(tokenReserve) : 0;
  const threshold = launched.graduationThreshold;
  const phases = ['bonding curve', 'swept', 'uniswap v4 pool', 'rescued'];
  const phase = phases[Number(launched.phase)] ?? String(launched.phase);
  const supplyTokens = Number(formatUnits(totalSupply, 18));
  return {
    venue: VENUE, unit: quoteSymbol,
    token, name, symbol,
    curve: launched.curve,
    deployer: launched.deployer,
    creator: launched.deployer,
    creatorFeeRecipient: launched.creatorFeeRecipient,
    creatorTaxBps: Number(launched.creatorTaxBps),
    buyTaxBps: Number(launched.creatorTaxBps), sellTaxBps: Number(launched.creatorTaxBps),
    buybackEnabled: launched.buybackEnabled,
    phase,
    graduated, readyToGraduate,
    canBuy: !graduated && phase === 'bonding curve',
    totalSupply: formatUnits(totalSupply, 18),
    sellableTokens: formatUnits(sellable, 18),
    // Nomes genericos (unidade = quote) e os antigos, para quem ja consome.
    price: priceEth, priceEth,
    marketCap: priceEth * supplyTokens, marketCapEth: priceEth * supplyTokens,
    raised: formatEther(realQuote), raisedEth: formatEther(realQuote),
    graduatesAt: formatEther(threshold), graduationThresholdEth: formatEther(threshold),
    graduationLabel: 'graduation (curve to Uniswap v4)',
    graduationProgress: threshold > 0n ? Number((realQuote * 10_000n) / threshold) / 100 : null,
  };
}

// ---------------------------------------------------------------------------
// Handover das taxas de criador para o agente (assinado pelo recebedor atual).
export function buildHandoverTx({ token, newRecipient }) {
  return {
    via: 'factory',
    to: CONTRACTS.factory,
    data: encodeFunctionData({ abi: FACTORY_ABI, functionName: 'transferCreatorFeeRecipient', args: [token, newRecipient] }),
    value: 0n,
  };
}

export const launchedToken = (token) => client.readContract({ ...factory, functionName: 'getLaunchedToken', args: [token] }).catch(() => null);
export const feeRecipient = async (token) => (await launchedToken(token))?.creatorFeeRecipient ?? null;

// ---------------------------------------------------------------------------
// Carteira do agente. A chave nasce aqui, vive cifrada no disco e so assina
// pelas funcoes abaixo: contratos da pons, queima e transferencias do token.
export function newAgentKey() {
  const pk = generatePrivateKey();
  return { pk, address: privateKeyToAccount(pk).address };
}

const walletFor = (pk) => createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(CHAIN.rpc, { timeout: 20_000 }) });

async function confirm(hash) {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 2_000 });
  return { hash, ok: receipt.status === 'success', receipt };
}

export async function agentWrite(pk, { address, abi, functionName, args = [], value = 0n }) {
  const w = walletFor(pk);
  const hash = await w.writeContract({ address, abi, functionName, args, value });
  return confirm(hash);
}

export async function agentSendEth(pk, to, value) {
  const w = walletFor(pk);
  const hash = await w.sendTransaction({ to, value });
  return confirm(hash);
}
// Nomes genericos: "native" aqui e ETH, em wei (a mesma unidade do quote).
export const agentSendNative = agentSendEth;
export const agentBalance = (address) => client.getBalance({ address });
export const agentTransferTokens = (pk, token, to, amount) => agentWrite(pk, { address: token, abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] });
export const burnAddress = DEAD_ADDRESS;

export const escrowBalance = (recipient) => client.readContract({ address: CONTRACTS.feeEscrow, abi: ESCROW_ABI, functionName: 'balanceOf', args: [recipient] });
export const tokenBalance = (token, owner) => client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });

// Taxas ainda paradas na curva (antes de varrer): saldo da curva menos a reserva real.
export async function curveUnswept(curve) {
  const [bal, real] = await Promise.all([client.getBalance({ address: curve }), client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'realQuoteReserve' })]);
  return bal > real ? bal - real : 0n;
}

export const curveFlags = async (curve) => {
  const [deployer, buybackEnabled, graduated] = await Promise.all([
    client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'deployer' }),
    client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'buybackEnabled' }),
    client.readContract({ address: curve, abi: CURVE_ABI, functionName: 'graduated' }),
  ]);
  return { deployer, buybackEnabled, graduated };
};

// Estado do mercado do token para o ciclo do agente.
export async function marketFlags(rec) {
  const f = await curveFlags(rec.curve);
  return { graduated: f.graduated, canBuy: !f.graduated, deployer: f.deployer, buybackEnabled: f.buybackEnabled };
}

const MIN_SWEEP = parseEther('0.0005');

// Coleta: varre a curva (se o agente for o deployer e nao houver buyback da
// pons) e saca o escrow. Devolve quanto entrou na carteira.
export async function collectFees(pk, rec, { tx }) {
  const flags = await curveFlags(rec.curve);
  let collected = 0n;
  if (!flags.graduated && !flags.buybackEnabled && flags.deployer.toLowerCase() === rec.agent.toLowerCase()) {
    const unswept = await curveUnswept(rec.curve);
    if (unswept >= MIN_SWEEP) await tx('sweep', () => agentWrite(pk, { address: rec.curve, abi: CURVE_ABI, functionName: 'sweepFees', args: [0n] }));
  }
  const escrow = await escrowBalance(rec.agent);
  if (escrow > 0n) {
    const r = await tx('claim', () => agentWrite(pk, { address: CONTRACTS.feeEscrow, abi: ESCROW_ABI, functionName: 'claim' }));
    if (r?.ok) collected = escrow;
  }
  return collected;
}

// Quanto ainda ha para coletar (para a pagina).
export async function pendingFees(rec) {
  const [escrow, unswept] = await Promise.all([escrowBalance(rec.agent).catch(() => 0n), rec.status === 'active' ? curveUnswept(rec.curve).catch(() => 0n) : 0n]);
  return escrow + unswept;
}

// Compra do agente na curva. Devolve quantos tokens entraram.
export async function buyTokens(pk, rec, amount, { tx }) {
  const before = await tokenBalance(rec.token, rec.agent);
  const r = await tx('buy', () => agentWrite(pk, { address: rec.curve, abi: CURVE_ABI, functionName: 'buy', args: [amount, 0n, rec.agent], value: amount }));
  if (!r?.ok) return 0n;
  return (await tokenBalance(rec.token, rec.agent)) - before;
}

// Compradores recentes na curva, pelos eventos CurveBuy (so chain, sem explorer).
export async function recentBuyers(rec, { blocks = 20_000n, max = 20, exclude = [] } = {}) {
  const latest = await client.getBlockNumber();
  const fromBlock = latest > blocks ? latest - blocks : 0n;
  const event = CURVE_ABI.find((i) => i.type === 'event' && i.name === 'CurveBuy');
  let logs = [];
  try { logs = await client.getLogs({ address: rec.curve, event, fromBlock, toBlock: latest }); } catch { return []; }
  const skip = new Set(exclude.map((a) => a.toLowerCase()));
  const totals = new Map();
  for (const l of logs) {
    const r = l.args?.recipient; if (!r || skip.has(r.toLowerCase())) continue;
    totals.set(r, (totals.get(r) || 0n) + (l.args.tokensOut || 0n));
  }
  return [...totals.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, max).map(([address, bought]) => ({ address, bought }));
}

export const blockNumber = () => client.getBlockNumber();
export const blockHash = async (n) => (await client.getBlock({ blockNumber: n })).hash;

// Compras na curva entre dois blocos (para reagir a eventos).
export async function buysBetween(rec, fromBlock, toBlock) {
  if (toBlock < fromBlock) return [];
  const event = CURVE_ABI.find((i) => i.type === 'event' && i.name === 'CurveBuy');
  try {
    const logs = await client.getLogs({ address: rec.curve, event, fromBlock, toBlock });
    return logs.map((l) => ({ recipient: l.args?.recipient, quoteIn: l.args?.quoteIn ?? 0n, tokensOut: l.args?.tokensOut ?? 0n, block: l.blockNumber }));
  } catch { return []; }
}

// Quem vendeu recentemente = mandou token de volta para a curva (Transfer -> curve).
export async function sellersSince(rec, blocks = 20_000n) {
  const latest = await client.getBlockNumber();
  const fromBlock = latest > blocks ? latest - blocks : 0n;
  const event = { type: 'event', name: 'Transfer', inputs: [{ indexed: true, name: 'from', type: 'address' }, { indexed: true, name: 'to', type: 'address' }, { indexed: false, name: 'value', type: 'uint256' }] };
  try {
    const logs = await client.getLogs({ address: rec.token, event, args: { to: rec.curve }, fromBlock, toBlock: latest });
    return new Set(logs.map((l) => String(l.args?.from || '').toLowerCase()));
  } catch { return new Set(); }
}

// Saida do agente: devolve o papel de recebedor ao criador. Aqui e reversivel.
export async function releaseToOwner(pk, rec) {
  const back = await agentWrite(pk, { address: CONTRACTS.factory, abi: FACTORY_ABI, functionName: 'transferCreatorFeeRecipient', args: [rec.token, rec.creator] });
  return { txs: [{ label: 'handback', hash: back.hash, ok: back.ok }], ok: back.ok, permanent: false };
}

// Na pons o agente nao lanca token; ele recebe as taxas de um token existente.
export const agentLaunch = null;

export const verifySignedMessage = ({ address, message, signature }) => verifyMessage({ address, message, signature }).catch(() => false);

export { formatEther, parseEther, formatUnits, getAddress, ESCROW_ABI, CURVE_ABI, ERC20_ABI, DEAD_ADDRESS, QuoteError };

// Valores padrao do agente nesta chain (ETH).
export const AGENT_DEFAULTS = { reserve: '0.001', minAction: '0.002', minGas: '0.0005', kickstart: '0.002', whale: '0.05' };
export const fundingCheckBuy = ({ wallet, tx, pre }) => fundingCheck({ wallet, tx, pre });
// Transferencia simples (o dono financia a carteira do agente).
export const fundingTx = (to, amount) => ({ to, data: '0x', value: amount });
export const holdersShareAllowed = async () => false;
