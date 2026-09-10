// Camada de chain do Pronto (viem). Regra da casa: este processo NUNCA assina
// nada. Ele le a chain, monta calldata, simula com eth_call e devolve a
// transacao crua para a carteira do usuario assinar no navegador.
import {
  createPublicClient, createWalletClient, http, defineChain, encodeFunctionData, decodeFunctionResult, decodeErrorResult,
  parseEther, formatEther, formatUnits, getAddress, parseEventLogs, verifyMessage,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { CHAIN, CONTRACTS, ZERO_ADDRESS, LIMITS } from './config.js';
import { FACTORY_ABI, ROUTER_ABI, CURVE_ABI, ERC20_ABI, ESCROW_ABI, ALL_ERRORS } from './abi.js';

export const chain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [CHAIN.rpc] } },
  blockExplorers: { default: { name: 'Blockscout', url: CHAIN.explorer } },
});

export const client = createPublicClient({
  chain,
  transport: http(CHAIN.rpc, { timeout: 20_000, retryCount: 2 }),
});

const factory = { address: CONTRACTS.factory, abi: FACTORY_ABI };

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
    configId,
    launchFee,
    launchFeeEth: formatEther(launchFee),
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
    fetchedAt: new Date().toISOString(),
  };
  termsCache = { at: Date.now(), value };
  return value;
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
  return {
    token, name, symbol,
    curve: launched.curve,
    deployer: launched.deployer,
    creatorFeeRecipient: launched.creatorFeeRecipient,
    creatorTaxBps: Number(launched.creatorTaxBps),
    buybackEnabled: launched.buybackEnabled,
    phase: phases[Number(launched.phase)] ?? String(launched.phase),
    graduated, readyToGraduate,
    totalSupply: formatUnits(totalSupply, 18),
    sellableTokens: formatUnits(sellable, 18),
    priceEth,
    marketCapEth: priceEth * Number(formatUnits(totalSupply, 18)),
    raisedEth: formatEther(realQuote),
    graduationThresholdEth: formatEther(threshold),
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

// Compradores recentes na curva, pelos eventos CurveBuy (so chain, sem explorer).
export async function recentBuyers(curve, { blocks = 20_000n, max = 20, exclude = [] } = {}) {
  const latest = await client.getBlockNumber();
  const fromBlock = latest > blocks ? latest - blocks : 0n;
  const event = CURVE_ABI.find((i) => i.type === 'event' && i.name === 'CurveBuy');
  let logs = [];
  try { logs = await client.getLogs({ address: curve, event, fromBlock, toBlock: latest }); } catch { return []; }
  const skip = new Set(exclude.map((a) => a.toLowerCase()));
  const totals = new Map();
  for (const l of logs) {
    const r = l.args?.recipient; if (!r || skip.has(r.toLowerCase())) continue;
    totals.set(r, (totals.get(r) || 0n) + (l.args.tokensOut || 0n));
  }
  return [...totals.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, max).map(([address, bought]) => ({ address, bought }));
}

export const verifySignedMessage = ({ address, message, signature }) => verifyMessage({ address, message, signature }).catch(() => false);

export { formatEther, parseEther, formatUnits, getAddress, ESCROW_ABI, CURVE_ABI, ERC20_ABI };
