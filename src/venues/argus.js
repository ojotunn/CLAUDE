// Venue Argus (Arc, chain da Circle). Sem bonding curve: o portal da Argus
// cria o token, um hook de taxa, um splitter e uma posicao Uniswap v4 com o
// supply inteiro acima do preco de abertura, tudo numa transacao. O gas da
// Arc e USDC; o USDC tambem existe como ERC-20 em 0x3600... (mesmo saldo).
//
// O que este modulo sabe da Argus foi lido da chain (bytecode, storage e
// transacoes reais), porque o fonte nao esta verificado e a doc do site fica
// atras de um captcha. Cada derivacao abaixo foi conferida contra um
// lancamento real antes de virar codigo:
//  - token   = CREATE2(portal, keccak(abi.encode(criador, tokenSalt)), clone EIP-1167 do tokenImpl)
//  - splitter= portal.predictSplitter(criador, tokenSalt)
//  - hook    = CREATE2(portal, keccak(abi.encode(criador, hookSalt)), creationCode(cofre) ++ args)
//              e o endereco PRECISA terminar com os bits 0x2044 (flags do v4):
//              quem lanca minera o hookSalt; fazemos isso aqui em ~250 ms.
//  - dev buy = swap de USDC na pool recem-criada (fee 1% + taxa de compra).
// Unidades "quote" sao USDC com 6 casas; saldo nativo tem 18 casas (x1e12).
import {
  createPublicClient, createWalletClient, http, defineChain, encodeFunctionData, decodeFunctionResult, decodeErrorResult,
  encodeAbiParameters, keccak256, concat, pad, numberToHex, getAddress, parseEventLogs, verifyMessage, formatUnits, parseUnits, formatEther,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import crypto from 'node:crypto';
import { CHAIN, CONTRACTS, LIMITS, V, TOKEN_URL, QUOTE } from '../config.js';
import { PORTAL_ABI, HOOK_ABI, LAUNCH_CONFIG_ABI, SPLITTER_ABI, STATE_VIEW_ABI, ERC20_ABI, PERMIT2_ABI, UR_ABI, V4_SWAP_PARAMS, TRANSFER_EVENT, SWAP_EVENT, ALL_ERRORS, DEAD_ADDRESS } from './argus-abi.js';

export const VENUE = 'argus';
export const NAME = V.name;
export const SHORT = V.short;
export const MARKET = V.market;
export const DOCS_URL = V.docsUrl;
// Na Argus o criador e quem assina o launch e nao existe funcao para trocar o
// criador depois. Um agente com acesso as taxas precisa ser o proprio criador:
// o agente lanca o token com a carteira dele (financiada pelo dono).
export const supportsHandover = false;
export const agentMustLaunch = true;

export const chain = defineChain({
  id: CHAIN.id,
  name: CHAIN.name,
  nativeCurrency: CHAIN.native,
  rpcUrls: { default: { http: [CHAIN.rpc] } },
  blockExplorers: { default: { name: 'Arc explorer', url: CHAIN.explorer } },
});

export const client = createPublicClient({ chain, transport: http(CHAIN.rpc, { timeout: 20_000, retryCount: 2 }) });

const portal = { address: CONTRACTS.portal, abi: PORTAL_ABI };
const USDC = CONTRACTS.usdc;
const PM = CONTRACTS.poolManager;
const UR = CONTRACTS.universalRouter;
const PERMIT2 = CONTRACTS.permit2;
const Q96 = 2n ** 96n;
const Q12 = 10n ** 12n;             // nativo (18 casas) -> USDC (6 casas)
const POOL_FEE = 10000;             // 1% (pips)
const TICK_SPACING = 200;
const MAX_TICK = 887200, MIN_TICK = -887200;
const HOOK_FLAGS = 0x2044;          // BEFORE_INITIALIZE | AFTER_SWAP | AFTER_SWAP_RETURNS_DELTA
const LAUNCH_MODE = 1;              // valor visto em 1147 de 1148 lancamentos
const USDC_ALLOWANCE_SLOT = 10n;    // mapping allowance[owner][spender] no proxy do USDC (achado por state override)
const PERMIT2_ALLOWANCE_SLOT = 1n;  // mapping allowance[owner][token][spender] do Permit2

// Unidades: o usuario fala em USDC; internamente, 6 casas.
export const parseAmount = (s) => parseUnits(String(s), 6);
export const formatAmount = (q) => formatUnits(q, 6);
export const quoteSymbol = QUOTE.symbol;
const nativeToQuote = (wei) => wei / Q12;
const quoteToNative = (q) => q * Q12;

export const links = ({ token, curve, txHash }) => ({
  venue: token ? TOKEN_URL.replace('{token}', token) : null,
  pons: token ? TOKEN_URL.replace('{token}', token) : null, // nome antigo, usado pelas paginas
  explorerToken: token ? `${CHAIN.explorer}/token/${token}` : null,
  explorerCurve: curve ? `${CHAIN.explorer}/address/${curve}` : null,
  explorerTx: txHash ? `${CHAIN.explorer}/tx/${txHash}` : null,
});

class QuoteError extends Error { constructor(message, code) { super(message); this.code = code; } }

// ---------------------------------------------------------------------------
// Matematica do Uniswap (TickMath e swap numa faixa unica), em BigInt.
function sqrtAtTick(t) {
  const tick = BigInt(t); const abs = tick < 0n ? -tick : tick;
  let ratio = (abs & 0x1n) ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const M = [[0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn], [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10n, 0xffcb9843d60f6159c9db58835c926644n], [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n], [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n], [0x200n, 0xf987a7253ac413176f2b074cf7815e54n], [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n], [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n], [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n], [0x8000n, 0x31be135f97d08fd981231505542fcfa6n], [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n], [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n], [0x80000n, 0x48a170391f7dc42444e8fa2n]];
  for (const [b, m] of M) if (abs & b) ratio = (ratio * m) >> 128n;
  if (tick > 0n) ratio = (2n ** 256n - 1n) / ratio;
  return (ratio >> 32n) + ((ratio % (1n << 32n)) === 0n ? 0n : 1n);
}
// Tick de abertura: o preco de currency1 por currency0 que da o mcap inicial,
// alinhado ao espacamento para o lado que deixa o token mais barato (o que a
// Argus faz: -405400 quando o token e currency0, +405400 quando e currency1).
function startTickFor(tokenIsCurrency0, supply = LIMITS.argusSupply, startMcap = LIMITS.argusStartMcap) {
  const p = tokenIsCurrency0 ? Number(startMcap) / Number(supply) : Number(supply) / Number(startMcap);
  const raw = Math.log(p) / Math.log(1.0001);
  return tokenIsCurrency0 ? Math.floor(raw / TICK_SPACING) * TICK_SPACING : Math.ceil(raw / TICK_SPACING) * TICK_SPACING;
}
// Liquidez da posicao que recebe o supply inteiro acima do preco de abertura.
function initialLiquidity(tokenIsCurrency0, supply = LIMITS.argusSupply) {
  const start = startTickFor(tokenIsCurrency0, supply);
  if (tokenIsCurrency0) { const sa = sqrtAtTick(start), sb = sqrtAtTick(MAX_TICK); return { L: (supply * sa * sb) / (Q96 * (sb - sa)), sqrtP: sa, tick: start }; }
  const sa = sqrtAtTick(MIN_TICK), sb = sqrtAtTick(start); return { L: (supply * Q96) / (sb - sa), sqrtP: sb, tick: start };
}
// Compra de token com `amountIn` de USDC numa faixa unica: 1% de fee no
// input, depois a taxa de compra do hook sobre os tokens que saem.
function swapOut({ sqrtP, L, amountIn, tokenIsCurrency0, buyTaxBps }) {
  if (L === 0n || amountIn <= 0n) return 0n;
  const inAfterFee = (amountIn * BigInt(1_000_000 - POOL_FEE)) / 1_000_000n;
  let out;
  if (tokenIsCurrency0) { const sqrtP2 = sqrtP + (inAfterFee * Q96) / L; out = (L * Q96 * (sqrtP2 - sqrtP)) / (sqrtP * sqrtP2); }
  else { const sqrtP2 = (L * sqrtP * Q96) / (L * Q96 + inAfterFee * sqrtP); out = (L * (sqrtP - sqrtP2)) / Q96; }
  return (out * BigInt(10_000 - buyTaxBps)) / 10_000n;
}
// Preco em USD por token a partir do sqrtPrice da pool.
function priceUsd(sqrtP, tokenIsCurrency0) {
  const r = Number(sqrtP) / Number(Q96); const p = r * r; // currency1 por currency0 (unidades cruas)
  return tokenIsCurrency0 ? p * 1e12 : (p > 0 ? (1 / p) * 1e12 : 0);
}

// ---------------------------------------------------------------------------
// Enderecos previstos.
const proxyInit = (impl) => keccak256('0x3d602d80600a3d3981f3363d3d373d3d3d363d73' + impl.slice(2).toLowerCase() + '5af43d82803e903d91602b57fd5bf3');
const create2 = (deployer, salt, initHash) => getAddress('0x' + keccak256(concat(['0xff', deployer, salt, initHash])).slice(26));
const saltFor = (sender, salt) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [sender, salt]));
const predictToken = (sender, tokenSalt, tokenImpl) => create2(CONTRACTS.portal, saltFor(sender, tokenSalt), proxyInit(tokenImpl));
const predictSplitter = (sender, tokenSalt) => client.readContract({ ...portal, functionName: 'predictSplitter', args: [sender, tokenSalt] });
const hookInitHash = (t, splitter, buyTaxBps, sellTaxBps) => keccak256(t.hookCreation + encodeAbiParameters(
  [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'uint16' }, { type: 'uint16' }],
  [PM, CONTRACTS.portal, splitter, t.treasury, USDC, POOL_FEE, TICK_SPACING, buyTaxBps, sellTaxBps]).slice(2));
// Mineracao do hookSalt: 8 bytes zero + 24 aleatorios (o formato que a Argus usa),
// ate o endereco cair nos bits 0x2044. Em media 16k tentativas, ~250 ms.
function mineHookSalt({ sender, initHash }) {
  for (let i = 0; i < 2_000_000; i++) {
    const salt = '0x' + '0'.repeat(16) + crypto.randomBytes(24).toString('hex');
    const a = create2(CONTRACTS.portal, saltFor(sender, salt), initHash);
    if ((parseInt(a.slice(-4), 16) & 0x3fff) === HOOK_FLAGS) return { hookSalt: salt, hook: a };
  }
  throw new QuoteError('could not mine a hook salt', 'MINING_FAILED');
}

// ---------------------------------------------------------------------------
// Termos do protocolo. O creation code do hook vive num contrato-cofre cujo
// endereco fica no slot 4 do portal; lemos o slot para nao ficar preso a um
// endereco velho se a Argus trocar o hook.
let termsCache = { at: 0, value: null };
export async function protocolTerms({ fresh = false } = {}) {
  if (!fresh && termsCache.value && Date.now() - termsCache.at < 60_000) return termsCache.value;
  const [maxTaxBps, treasuryBps, treasury, devBuyMaxBps, tokenCount, tokenImpl, poolFee, tickSpacing, slot4, gasPrice] = await Promise.all([
    client.readContract({ ...portal, functionName: 'MAX_TAX_BPS' }),
    client.readContract({ ...portal, functionName: 'treasuryBps' }),
    client.readContract({ ...portal, functionName: 'treasury' }),
    client.readContract({ ...portal, functionName: 'devBuyMaxBps' }),
    client.readContract({ ...portal, functionName: 'tokenCount' }),
    client.readContract({ ...portal, functionName: 'tokenImpl' }),
    client.readContract({ ...portal, functionName: 'POOL_FEE' }),
    client.readContract({ ...portal, functionName: 'TICK_SPACING' }),
    client.getStorageAt({ address: CONTRACTS.portal, slot: '0x4' }),
    client.getGasPrice(),
  ]);
  const launchConfig = await client.readContract({ address: getAddress(tokenImpl), abi: PORTAL_ABI, functionName: 'launchConfig' }).catch(() => null);
  if (Number(poolFee) !== POOL_FEE || Number(tickSpacing) !== TICK_SPACING) throw new Error(`Argus pool parameters changed (fee ${poolFee}, spacing ${tickSpacing}); update the venue module`);
  const holder = getAddress('0x' + slot4.slice(26));
  let hookCreation = termsCache.value?.hookHolder === holder ? termsCache.value.hookCreation : null;
  if (!hookCreation) {
    const code = await client.getCode({ address: holder });
    if (!code || !code.startsWith('0x00')) throw new Error(`Argus hook code holder ${holder} does not look like a code vault`);
    hookCreation = '0x' + code.slice(4); // tira o 0x00 que impede o cofre de ser executado
  }
  const value = {
    venue: VENUE,
    launchFee: 0n, launchFeeQuote: '0',
    maxTaxBps: Number(maxTaxBps), maxCreatorTaxBps: Number(maxTaxBps),
    treasuryBps: Number(treasuryBps), treasury: getAddress(treasury),
    devBuyMaxBps: Number(devBuyMaxBps),
    tokenCount: Number(tokenCount),
    tokenImpl: getAddress(tokenImpl), launchConfig: launchConfig ? getAddress(launchConfig) : null, hookHolder: holder, hookCreation,
    supply: LIMITS.argusSupply, supplyTokens: formatUnits(LIMITS.argusSupply, 18),
    startMcapUsd: Number(LIMITS.argusStartMcap) / 1e6, bondMcapUsd: Number(LIMITS.argusBondMcap) / 1e6,
    launchEnabled: true, configEnabled: true,
    gasPrice,
    pin: keccak256(concat([pad(numberToHex(maxTaxBps)), pad(numberToHex(treasuryBps)), pad(treasury), pad(tokenImpl), pad(holder), keccak256(hookCreation)])),
    fetchedAt: new Date().toISOString(),
  };
  termsCache = { at: Date.now(), value };
  return value;
}

export function termsSummary(t) {
  return {
    venue: NAME, network: CHAIN.name, chainId: CHAIN.id, unit: quoteSymbol,
    launchFee: '0', supply: t.supplyTokens, maxCreatorTax: `${t.maxTaxBps / 100}%`, maxCreatorTaxBps: t.maxTaxBps,
    curveTradeFee: `${POOL_FEE / 10000}% pool fee`, taxNote: 'buy and sell tax set separately (0-10% each, at least one above 0), fixed forever; the tax is split between creator, buy back & burn, holders (paid in USDC) and liquidity; Argus keeps 10% of the tax',
    opensAt: `$${t.startMcapUsd.toLocaleString('en-US')} market cap`, graduatesAt: `$${t.bondMcapUsd.toLocaleString('en-US')} market cap (liquidity locks for good; trading continues in the same Uniswap v4 pool)`, graduatesAtValue: String(t.bondMcapUsd),
    launchesOpenToEveryone: true, devBuyCap: `${LIMITS.maxDevBuyBps / 100}% of supply`,
    launchAndBuyInOneTransaction: true, market: MARKET, tokensLaunchedOnArgus: t.tokenCount,
    contracts: { portal: CONTRACTS.portal, poolManager: PM, universalRouter: UR, permit2: PERMIT2, usdc: USDC, hookCode: t.hookHolder, tokenImpl: t.tokenImpl },
  };
}

export const canLaunch = async () => true;

// A fatia para holders (dividendos em USDC) exige que o lancador esteja
// cadastrado no launchConfig da Argus (rewardMode 1). Em 16/09/2026 so o
// lancador da ubi.fun estava; carteiras comuns recebem 0 e o portal reverte.
export async function holdersShareAllowed(wallet, terms) {
  const cfg = terms?.launchConfig; if (!cfg) return false;
  try { const [mode] = await client.readContract({ address: cfg, abi: LAUNCH_CONFIG_ABI, functionName: 'configFor', args: [wallet] }); return Number(mode) > 0; } catch { return false; }
}
const HOLDERS_MSG = 'the holders share (USDC dividends) is only available to launchers registered by Argus, and this wallet is not registered; split the tax between creator, burn and liquidity instead';

// ---------------------------------------------------------------------------
// State overrides para simular sem saldo e sem aprovacao.
const usdcAllowanceSlot = (owner, spender) => keccak256(concat([pad(spender), keccak256(concat([pad(owner), pad(numberToHex(USDC_ALLOWANCE_SLOT))]))]));
const permit2AllowanceSlot = (owner, token, spender) => keccak256(concat([pad(spender), keccak256(concat([pad(token), keccak256(concat([pad(owner), pad(numberToHex(PERMIT2_ALLOWANCE_SLOT))]))]))]));
const permit2Packed = (amount, expiration) => pad(numberToHex((BigInt(expiration) << 160n) | BigInt(amount)));
const MAX_UINT160 = 2n ** 160n - 1n, MAX_UINT48 = 2n ** 48n - 1n;

function overridesFor({ from, fund, usdcSpender, usdcAmount, permit2 }) {
  const ov = [];
  if (fund) ov.push({ address: from, balance: 10n ** 24n });
  if (usdcSpender && usdcAmount > 0n) ov.push({ address: USDC, stateDiff: [{ slot: usdcAllowanceSlot(from, usdcSpender), value: pad(numberToHex(usdcAmount)) }] });
  if (permit2) ov.push({ address: PERMIT2, stateDiff: [{ slot: permit2AllowanceSlot(from, USDC, UR), value: permit2Packed(MAX_UINT160, MAX_UINT48) }] });
  return ov;
}

export async function simulate({ from, to, data, value = 0n, fund = true, overrides = null }) {
  const res = await client.call({ account: from, to, data, value, stateOverride: overrides ?? (fund ? overridesFor({ from, fund: true }) : undefined) });
  return res.data;
}

export async function estimateGas({ from, to, data, value = 0n, overrides }) {
  return client.estimateGas({ account: from, to, data, value, stateOverride: overrides });
}

export const getBalance = (address) => client.getBalance({ address });

const HUMAN = {
  HookAddressMismatch: 'the mined hook salt no longer matches (Argus changed its hook); preview again',
  TaxTooHigh: 'tax above the Argus maximum (10% per leg)',
  NoTax: 'Argus requires at least one of buy tax or sell tax above 0',
  QuoteNotApproved: 'this quote asset is not approved on Argus',
  SupplyTooLarge: 'supply above what Argus allows',
  V4TooLittleReceived: 'the price moved more than the slippage allowance; prepare the buy again',
  TransactionDeadlinePassed: 'this buy expired; prepare it again',
  NothingToClaim: 'nothing to claim yet',
  AllowanceExpired: 'the Permit2 approval expired; approve again',
  InsufficientAllowance: 'USDC is not approved for this amount yet',
  SafeERC20FailedOperation: 'the USDC transfer failed: approve the portal for the dev buy first, or lower it',
  InsufficientBalance: 'the wallet does not hold enough USDC',
  RewardTrackerMissing_0xf44fdf02: 'the holders share (USDC dividends) is only available to launchers registered by Argus; split the tax between creator, burn and liquidity instead',
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
    } catch { return { code: 'REVERT', message: `reverted with ${data.slice(0, 10)}` }; }
  }
  const msg = String(error?.shortMessage || error?.message || error);
  if (/insufficient funds/i.test(msg)) return { code: 'INSUFFICIENT_FUNDS', message: 'the wallet does not hold enough USDC for this transaction' };
  return { code: 'REVERT', message: msg.split('\n')[0].slice(0, 200) };
}

// ---------------------------------------------------------------------------
// Lancamento.
const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
const bpsOf = (part, whole) => (whole > 0n ? Number((part * 10_000n) / whole) : 0);

function launchCalldata({ input, buyTaxBps, sellTaxBps, split, devBuy, tokenSalt, hookSalt }) {
  const p = {
    name: input.name, symbol: input.symbol, supply: LIMITS.argusSupply, startMcap: LIMITS.argusStartMcap, bondMcap: LIMITS.argusBondMcap,
    buyTaxBps, sellTaxBps, creatorBps: split.creatorBps, burnBps: split.burnBps, holdersBps: split.holdersBps, liquidityBps: split.liquidityBps,
    devBuy, quote: USDC, mode: LAUNCH_MODE,
  };
  const m = { image: input.logo || '', website: input.socials?.website || '', twitter: input.socials?.twitter || '', telegram: input.socials?.telegram || '', description: input.description || '' };
  return encodeFunctionData({ abi: PORTAL_ABI, functionName: 'launch', args: [p, m, tokenSalt, hookSalt] });
}

const approveTx = (spender, amount, label) => ({ label, to: USDC, data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [spender, amount] }), value: 0n });

export function resolveTaxes(input, terms) {
  const buy = input.buyTaxBps ?? input.creatorTaxBps;
  const sell = input.sellTaxBps ?? input.creatorTaxBps;
  if (buy > terms.maxTaxBps || sell > terms.maxTaxBps) throw new QuoteError(`tax ${pct(Math.max(buy, sell))} is above the Argus maximum of ${pct(terms.maxTaxBps)} per leg`, 'CREATOR_TAX_TOO_HIGH');
  if (buy === 0 && sell === 0) throw new QuoteError('Argus requires at least one tax leg above 0 (buy tax or sell tax); 3% each is the usual choice', 'NO_TAX');
  const split = { creatorBps: input.split?.creatorBps ?? 10_000, burnBps: input.split?.burnBps ?? 0, holdersBps: input.split?.holdersBps ?? 0, liquidityBps: input.split?.liquidityBps ?? 0 };
  const sum = split.creatorBps + split.burnBps + split.holdersBps + split.liquidityBps;
  if (sum !== 10_000) throw new QuoteError(`the tax split must add up to 100% (creator + burn + holders + liquidity); got ${sum / 100}%`, 'BAD_SPLIT');
  return { buy, sell, split };
}

export async function quoteLaunch({ input, devBuy, salt, from, terms, exact = false }) {
  const warnings = [];
  const { buy, sell, split } = resolveTaxes(input, terms);
  if (input.socials?.discord || input.socials?.farcaster) warnings.push('Argus stores website, X and Telegram links only; discord and farcaster were dropped');
  if (input.creatorFeeRecipient && input.creatorFeeRecipient.toLowerCase() !== from.toLowerCase()) warnings.push('on Argus the creator fees always go to the wallet that signs the launch; the fee recipient you gave was ignored');
  if (input.buybackEnabled) warnings.push('on Argus buy backs are part of the tax split (burn share), not a switch; buybackEnabled was ignored');

  if (split.holdersBps > 0 && !(await holdersShareAllowed(from, terms))) throw new QuoteError(HOLDERS_MSG, 'HOLDERS_NOT_ALLOWED');
  const token = predictToken(from, salt, terms.tokenImpl);
  const tokenIsCurrency0 = token.toLowerCase() < USDC.toLowerCase();
  const pool = initialLiquidity(tokenIsCurrency0);
  let devBuyQ = devBuy;
  let tokensOut = devBuyQ > 0n ? swapOut({ sqrtP: pool.sqrtP, L: pool.L, amountIn: devBuyQ, tokenIsCurrency0, buyTaxBps: buy }) : 0n;
  const cap = (LIMITS.argusSupply * BigInt(LIMITS.maxDevBuyBps)) / 10_000n;
  if (tokensOut > cap) {
    // Busca binaria pela maior compra sob o teto (so matematica, sem RPC).
    let lo = 0n, hi = devBuyQ;
    for (let i = 0; i < 48 && hi - lo > 1n; i++) { const mid = (lo + hi) / 2n; if (swapOut({ sqrtP: pool.sqrtP, L: pool.L, amountIn: mid, tokenIsCurrency0, buyTaxBps: buy }) <= cap) lo = mid; else hi = mid; }
    if (lo === 0n) throw new QuoteError(`even the smallest dev buy exceeds the ${pct(LIMITS.maxDevBuyBps)} cap`, 'DEV_BUY_CAP');
    warnings.push(`dev buy reduced from ${formatAmount(devBuyQ)} to ${formatAmount(lo)} USDC so it stays under ${pct(LIMITS.maxDevBuyBps)} of supply`);
    devBuyQ = lo;
    tokensOut = swapOut({ sqrtP: pool.sqrtP, L: pool.L, amountIn: devBuyQ, tokenIsCurrency0, buyTaxBps: buy });
  }
  if (devBuyQ > 0n && bpsOf(devBuyQ, 10n ** 6n * 10_000n) === 0 && devBuyQ < 100_000n) warnings.push('a dev buy under 0.10 USDC is mostly eaten by rounding');

  const splitter = getAddress(await predictSplitter(from, salt));
  const { hookSalt, hook } = mineHookSalt({ sender: from, initHash: hookInitHash(terms, splitter, buy, sell) });
  const data = launchCalldata({ input, buyTaxBps: buy, sellTaxBps: sell, split, devBuy: devBuyQ, tokenSalt: salt, hookSalt });
  const tx = { to: CONTRACTS.portal, data, value: 0n };

  // Simula com saldo e aprovacao fingidos: o que interessa e se o portal aceita.
  let simulated;
  try {
    simulated = await simulate({ from, to: tx.to, data: tx.data, overrides: overridesFor({ from, fund: true, usdcSpender: CONTRACTS.portal, usdcAmount: devBuyQ }) });
  } catch (e) {
    const r = explainRevert(e);
    throw new QuoteError(`launch simulation failed: ${r.message}`, r.code);
  }
  const returned = getAddress(decodeFunctionResult({ abi: PORTAL_ABI, functionName: 'launch', data: simulated }));
  if (returned !== token) throw new QuoteError(`the portal would deploy at ${returned}, not at the predicted ${token}; Argus changed its token deployment`, 'PREDICTION_MISMATCH');

  const pre = [];
  if (exact && devBuyQ > 0n) {
    const allowance = await client.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'allowance', args: [from, CONTRACTS.portal] });
    if (allowance < devBuyQ) pre.push(approveTx(CONTRACTS.portal, devBuyQ, `Approve ${formatAmount(devBuyQ)} USDC for the dev buy`));
  }
  return {
    tx, pre,
    predicted: { token, curve: splitter, hook, tokenIsCurrency0 },
    tokensOut, devBuy: devBuyQ, devBuyBps: bpsOf(tokensOut, LIMITS.argusSupply),
    creatorFeeRecipient: from,
    warnings,
    route: 'Argus portal (token, tax hook, Uniswap v4 pool and dev buy in one transaction)',
    cost: { launchFee: '0', devBuy: formatAmount(devBuyQ), total: formatAmount(devBuyQ), unit: quoteSymbol },
    terms: { launchFee: '0', supply: terms.supplyTokens, pin: terms.pin },
    extra: { buyTax: pct(buy), sellTax: pct(sell), buyTaxBps: buy, sellTaxBps: sell, split, hookSalt, opensAt: `$${terms.startMcapUsd}`, bondsAt: `$${terms.bondMcapUsd.toLocaleString('en-US')}` },
  };
}

// Saldo x custo. O gas e cobrado em USDC (saldo nativo, 18 casas).
export async function fundingCheck({ wallet, tx, pre = [], devBuy = 0n }) {
  const balanceQ = nativeToQuote(await getBalance(wallet));
  const gasPrice = await client.getGasPrice();
  let gas;
  try {
    // Estima com saldo e aprovacoes fingidos: a pergunta aqui e "quanto custa",
    // nao "essa carteira consegue" (isso e a comparacao logo abaixo).
    gas = await estimateGas({ from: wallet, to: tx.to, data: tx.data, value: tx.value, overrides: overridesFor({ from: wallet, fund: true, usdcSpender: tx.to === UR ? PERMIT2 : CONTRACTS.portal, usdcAmount: devBuy, permit2: true }) });
  } catch (e) {
    const r = explainRevert(e);
    return { ok: false, balance: formatAmount(balanceQ), required: formatAmount(devBuy), unit: quoteSymbol, gas: null, message: r.message };
  }
  const gasQ = nativeToQuote((gas + 60_000n * BigInt(pre.length)) * gasPrice * 13n / 10n);
  const required = devBuy + gasQ;
  if (balanceQ < required) {
    return { ok: false, balance: formatAmount(balanceQ), required: formatAmount(required), unit: quoteSymbol, gas: null, message: `this wallet holds ${formatAmount(balanceQ)} USDC and needs about ${formatAmount(required)} USDC on ${CHAIN.name} (${devBuy > 0n ? 'the amount plus gas' : 'gas'}; gas on Arc is paid in USDC)` };
  }
  return { ok: true, balance: formatAmount(balanceQ), required: formatAmount(required), unit: quoteSymbol, gas, message: null };
}

export const getTransaction = (hash) => client.getTransaction({ hash }).catch(() => null);

// Recibo de um lancamento ou de uma compra.
export async function waitForReceipt(hash, { kind = 'launch', wallet = null, token = null } = {}) {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 15 * 60_000, pollingInterval: 1_000 });
  if (receipt.status !== 'success') return { ok: false, blockNumber: receipt.blockNumber, token: null, curve: null, tokensOut: 0n };
  if (kind === 'launch') {
    const launched = parseEventLogs({ abi: PORTAL_ABI, eventName: 'TokenLaunched', logs: receipt.logs, strict: false })[0];
    const devBuys = parseEventLogs({ abi: PORTAL_ABI, eventName: 'DevBuy', logs: receipt.logs, strict: false });
    const tokensOut = devBuys.reduce((s, l) => s + (l.args?.tokensOut ?? 0n), 0n);
    const t = launched?.args?.token ?? null;
    const l = t ? await client.readContract({ ...portal, functionName: 'launches', args: [t] }).catch(() => null) : null;
    return { ok: true, blockNumber: receipt.blockNumber, token: t, curve: l ? getAddress(l[5]) : null, tokensOut };
  }
  // compra: tokens que sairam do PoolManager para a carteira
  const transfers = parseEventLogs({ abi: [TRANSFER_EVENT], eventName: 'Transfer', logs: receipt.logs.filter((l) => !token || l.address.toLowerCase() === token.toLowerCase()), strict: false });
  const tokensOut = transfers.filter((l) => l.args?.from?.toLowerCase() === PM.toLowerCase() && (!wallet || l.args?.to?.toLowerCase() === wallet.toLowerCase())).reduce((s, l) => s + (l.args?.value ?? 0n), 0n);
  return { ok: true, blockNumber: receipt.blockNumber, token, curve: null, tokensOut };
}

// ---------------------------------------------------------------------------
// Estado de um token da Argus.
async function launchOf(token) {
  const l = await client.readContract({ ...portal, functionName: 'launches', args: [token] }).catch(() => null);
  if (!l || /^0x0{40}$/i.test(l[0])) return null;
  return { creator: getAddress(l[0]), startTick: Number(l[1]), tokenIsCurrency0: !!l[2], locker: getAddress(l[3]), hook: getAddress(l[4]), splitter: getAddress(l[5]), buyTaxBps: Number(l[6]), sellTaxBps: Number(l[7]), positionId: l[8], bondTick: Number(l[9]), quote: getAddress(l[10]) };
}

async function poolState(splitter, tokenIsCurrency0 = null) {
  const poolId = await client.readContract({ address: splitter, abi: SPLITTER_ABI, functionName: 'poolId' });
  const [slot0, liquidity] = await Promise.all([
    client.readContract({ address: CONTRACTS.stateView, abi: STATE_VIEW_ABI, functionName: 'getSlot0', args: [poolId] }),
    client.readContract({ address: CONTRACTS.stateView, abi: STATE_VIEW_ABI, functionName: 'getLiquidity', args: [poolId] }),
  ]);
  const tick = Number(slot0[1]);
  // Pool nova com o token como currency1: o preco esta exatamente no tick de
  // cima da posicao e a liquidez "ativa" le 0. A primeira compra cruza o tick
  // e encontra a posicao inteira; para cotar, usamos a liquidez inicial.
  let effective = liquidity;
  if (effective === 0n && tokenIsCurrency0 === false) { const init = initialLiquidity(false); if (tick >= init.tick) effective = init.L; }
  return { poolId, sqrtP: slot0[0], tick, liquidity, effectiveLiquidity: effective };
}

export async function tokenInfo(address) {
  const token = getAddress(address);
  const l = await launchOf(token);
  if (!l) return null;
  const erc20 = { address: token, abi: ERC20_ABI };
  const spl = { address: l.splitter, abi: SPLITTER_ABI };
  const [name, symbol, totalSupply, bonded, snipe, creatorBps, burnBps, dividendBps, liquidityBps, pool] = await Promise.all([
    client.readContract({ ...erc20, functionName: 'name' }),
    client.readContract({ ...erc20, functionName: 'symbol' }),
    client.readContract({ ...erc20, functionName: 'totalSupply' }),
    client.readContract({ address: l.hook, abi: HOOK_ABI, functionName: 'bonded' }),
    client.readContract({ address: l.hook, abi: HOOK_ABI, functionName: 'currentSnipeTaxBps' }).catch(() => 0n),
    client.readContract({ ...spl, functionName: 'creatorBps' }),
    client.readContract({ ...spl, functionName: 'burnBps' }),
    client.readContract({ ...spl, functionName: 'dividendBps' }),
    client.readContract({ ...spl, functionName: 'liquidityBps' }),
    poolState(l.splitter, l.tokenIsCurrency0),
  ]);
  const supplyTokens = Number(formatUnits(totalSupply, 18));
  const price = priceUsd(pool.sqrtP, l.tokenIsCurrency0);
  const marketCap = price * supplyTokens;
  const bondUsd = Number(LIMITS.argusBondMcap) / 1e6;
  return {
    venue: VENUE, unit: quoteSymbol,
    token, name, symbol,
    curve: l.splitter, splitter: l.splitter, hook: l.hook, locker: l.locker, poolId: pool.poolId, tokenIsCurrency0: l.tokenIsCurrency0,
    deployer: l.creator, creator: l.creator, creatorFeeRecipient: l.creator,
    creatorTaxBps: l.buyTaxBps, buyTaxBps: l.buyTaxBps, sellTaxBps: l.sellTaxBps,
    split: { creatorBps: Number(creatorBps), burnBps: Number(burnBps), holdersBps: Number(dividendBps), liquidityBps: Number(liquidityBps) },
    buybackEnabled: Number(burnBps) > 0,
    phase: bonded ? 'bonded (liquidity locked, Uniswap v4)' : 'Uniswap v4 pool',
    graduated: bonded, readyToGraduate: false, bonded,
    openingTaxBps: Number(snipe),
    canBuy: true,
    totalSupply: formatUnits(totalSupply, 18),
    price, priceEth: price, priceUsd: price,
    marketCap, marketCapEth: marketCap, marketCapUsd: marketCap,
    raised: null, raisedEth: null,
    graduatesAt: String(bondUsd), graduationThresholdEth: String(bondUsd),
    graduationLabel: 'bond (liquidity locks at $45,000 market cap)',
    graduationProgress: bonded ? 100 : Math.min(100, Math.round((marketCap / bondUsd) * 10000) / 100),
    liquidity: pool.liquidity.toString(),
  };
}

// ---------------------------------------------------------------------------
// Compra pelo Universal Router (V4_SWAP: SWAP_EXACT_IN_SINGLE, SETTLE_ALL, TAKE_ALL).
function poolKeyFor(info) {
  return { currency0: info.tokenIsCurrency0 ? info.token : USDC, currency1: info.tokenIsCurrency0 ? USDC : info.token, fee: POOL_FEE, tickSpacing: TICK_SPACING, hooks: info.hook };
}

function buildSwapTx({ info, amountIn, minTokensOut, deadline }) {
  const params = encodeAbiParameters(V4_SWAP_PARAMS, [{ poolKey: poolKeyFor(info), zeroForOne: !info.tokenIsCurrency0, amountIn, amountOutMinimum: minTokensOut, sqrtPriceLimitX96: 0n, hookData: '0x' }]);
  const settle = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [USDC, amountIn]);
  const take = encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [info.token, minTokensOut]);
  const v4 = encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x060c0f', [params, settle, take]]);
  return { to: UR, data: encodeFunctionData({ abi: UR_ABI, functionName: 'execute', args: ['0x10', [v4], deadline] }), value: 0n };
}

async function allowancePre(from, amount) {
  const pre = [];
  const [usdcAllowance, p2] = await Promise.all([
    client.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'allowance', args: [from, PERMIT2] }),
    client.readContract({ address: PERMIT2, abi: PERMIT2_ABI, functionName: 'allowance', args: [from, USDC, UR] }),
  ]);
  if (usdcAllowance < amount) pre.push(approveTx(PERMIT2, 2n ** 256n - 1n, 'Approve USDC for Permit2 (once)'));
  const now = BigInt(Math.floor(Date.now() / 1000));
  if (p2[0] < amount || BigInt(p2[1]) < now + 3600n) pre.push({ label: 'Approve the Uniswap router on Permit2 (once)', to: PERMIT2, data: encodeFunctionData({ abi: PERMIT2_ABI, functionName: 'approve', args: [USDC, UR, MAX_UINT160, Number(MAX_UINT48)] }), value: 0n });
  return pre;
}

export async function quoteBuy({ token, amount, from, exact = false }) {
  const info = await tokenInfo(token);
  if (!info) throw new QuoteError('this address is not an Argus launch on Arc', 'NOT_VENUE_TOKEN');
  const pool = await poolState(info.splitter, info.tokenIsCurrency0);
  const tokensOut = swapOut({ sqrtP: pool.sqrtP, L: pool.effectiveLiquidity, amountIn: amount, tokenIsCurrency0: info.tokenIsCurrency0, buyTaxBps: info.buyTaxBps });
  if (tokensOut <= 0n) throw new QuoteError('this pool has no liquidity at the current price', 'NO_LIQUIDITY');
  const minTokensOut = exact ? (tokensOut * 97n) / 100n : 0n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + Math.floor(LIMITS.launchTtlMs / 1000));
  const tx = buildSwapTx({ info, amountIn: amount, minTokensOut, deadline });
  try {
    await simulate({ from, to: tx.to, data: tx.data, overrides: overridesFor({ from, fund: true, usdcSpender: PERMIT2, usdcAmount: amount, permit2: true }) });
  } catch (e) {
    const r = explainRevert(e);
    throw new QuoteError(`buy simulation failed: ${r.message}`, r.code);
  }
  const pre = exact ? await allowancePre(from, amount) : [];
  return { tx, pre, tokensOut, info, deadline: Number(deadline) };
}

export async function fundingCheckBuy({ wallet, tx, pre = [], amount = 0n }) {
  return fundingCheck({ wallet, tx, pre, devBuy: amount });
}

// Na Argus nao ha handover: quem assinou o launch e o criador para sempre.
export const buildHandoverTx = null;
export const launchedToken = launchOf;
export const feeRecipient = async (token) => (await launchOf(token))?.creator ?? null;

// ---------------------------------------------------------------------------
// Carteira do agente.
export function newAgentKey() {
  const pk = generatePrivateKey();
  return { pk, address: privateKeyToAccount(pk).address };
}
const walletFor = (pk) => createWalletClient({ account: privateKeyToAccount(pk), chain, transport: http(CHAIN.rpc, { timeout: 20_000 }) });
async function confirm(hash) {
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 180_000, pollingInterval: 1_000 });
  return { hash, ok: receipt.status === 'success', receipt };
}
export async function agentWrite(pk, { address, abi, functionName, args = [], value = 0n }) {
  const w = walletFor(pk);
  const hash = await w.writeContract({ address, abi, functionName, args, value });
  return confirm(hash);
}
// "Nativo" e USDC: a quantia chega em 6 casas e sai como valor de 18.
export async function agentSendNative(pk, to, amountQ) {
  const w = walletFor(pk);
  const hash = await w.sendTransaction({ to, value: quoteToNative(amountQ) });
  return confirm(hash);
}
export const agentSendEth = agentSendNative;
export const agentBalance = async (address) => nativeToQuote(await client.getBalance({ address }));
export const agentTransferTokens = (pk, token, to, amount) => agentWrite(pk, { address: token, abi: ERC20_ABI, functionName: 'transfer', args: [to, amount] });
export const tokenBalance = (token, owner) => client.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] });
export const burnAddress = DEAD_ADDRESS;
export const escrowBalance = async () => 0n;

// Valores padrao do agente nesta chain (USDC): o gas de um ciclo custa
// centavos, entao a reserva pode ser pequena, mas nao microscopica.
export const AGENT_DEFAULTS = { reserve: '1', minAction: '2', minGas: '0.3', kickstart: '3', whale: '50' };

export async function marketFlags(rec) {
  const l = await launchOf(rec.token);
  const bonded = l ? await client.readContract({ address: l.hook, abi: HOOK_ABI, functionName: 'bonded' }).catch(() => false) : false;
  return { graduated: false, bonded, canBuy: true, deployer: l?.creator ?? null };
}

// Coleta: reparte o que o splitter acumulou e saca a parte do criador (= agente).
export async function collectFees(pk, rec, { tx }) {
  const spl = { address: rec.curve, abi: SPLITTER_ABI };
  let collected = 0n;
  let due = null;
  try { due = await client.simulateContract({ ...spl, functionName: 'distribute', account: rec.agent }); } catch { due = null; }
  const [dq, dt] = due?.result ?? [0n, 0n];
  if (dq > 0n || dt > 0n) await tx('distribute', () => agentWrite(pk, { ...spl, functionName: 'distribute' }));
  let claimable = false;
  try { await client.simulateContract({ ...spl, functionName: 'claim', args: [rec.agent], account: rec.agent }); claimable = true; } catch { claimable = false; }
  if (claimable) {
    const before = await client.getBalance({ address: rec.agent });
    const r = await tx('claim', () => agentWrite(pk, { ...spl, functionName: 'claim', args: [rec.agent] }));
    if (r?.ok) {
      const after = await client.getBalance({ address: rec.agent });
      const gasWei = (r.receipt?.gasUsed ?? 0n) * (r.receipt?.effectiveGasPrice ?? 0n);
      collected = nativeToQuote(after - before + gasWei);
      if (collected < 0n) collected = 0n;
    }
  }
  return collected;
}

// Estimativa do que ainda vai pingar para o criador (o splitter guarda USDC e
// tokens de taxa ainda nao repartidos): (USDC + tokens a preco) x (1 - tesouro) x fatia do criador.
export async function pendingFees(rec) {
  try {
    const info = await tokenInfo(rec.token);
    if (!info) return 0n;
    const [usdc, toks, creatorBps, treasuryBps] = await Promise.all([
      client.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [rec.curve] }),
      tokenBalance(rec.token, rec.curve),
      client.readContract({ address: rec.curve, abi: SPLITTER_ABI, functionName: 'creatorBps' }),
      client.readContract({ address: rec.curve, abi: SPLITTER_ABI, functionName: 'treasuryBps' }),
    ]);
    const tokensUsd = Number(formatUnits(toks, 18)) * info.price;
    const gross = Number(usdc) / 1e6 + tokensUsd;
    const net = gross * (1 - Number(treasuryBps) / 10_000) * (Number(creatorBps) / 10_000);
    return BigInt(Math.floor(net * 1e6));
  } catch { return 0n; }
}

// Compra do agente: aprova uma vez (USDC -> Permit2, Permit2 -> router) e troca.
export async function buyTokens(pk, rec, amountQ, { tx }) {
  const info = await tokenInfo(rec.token);
  if (!info) return 0n;
  for (const p of await allowancePre(rec.agent, amountQ)) {
    const r = await tx(p.label.toLowerCase().includes('permit2') && p.to === USDC ? 'approve usdc' : 'approve permit2', () => agentWrite(pk, p.to === USDC ? { address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [PERMIT2, 2n ** 256n - 1n] } : { address: PERMIT2, abi: PERMIT2_ABI, functionName: 'approve', args: [USDC, UR, MAX_UINT160, Number(MAX_UINT48)] }));
    if (!r?.ok) return 0n;
  }
  const pool = await poolState(info.splitter, info.tokenIsCurrency0);
  const expected = swapOut({ sqrtP: pool.sqrtP, L: pool.effectiveLiquidity, amountIn: amountQ, tokenIsCurrency0: info.tokenIsCurrency0, buyTaxBps: info.buyTaxBps });
  const swap = buildSwapTx({ info, amountIn: amountQ, minTokensOut: (expected * 95n) / 100n, deadline: BigInt(Math.floor(Date.now() / 1000) + 900) });
  const before = await tokenBalance(rec.token, rec.agent);
  const w = walletFor(pk);
  const r = await tx('buy', async () => confirm(await w.sendTransaction({ to: swap.to, data: swap.data, value: 0n })));
  if (!r?.ok) return 0n;
  return (await tokenBalance(rec.token, rec.agent)) - before;
}

// Compradores recentes: tokens que sairam do PoolManager para alguem.
const SYSTEM = (rec) => new Set([PM, UR, CONTRACTS.portal, rec.curve, rec.hook, rec.locker, DEAD_ADDRESS].filter(Boolean).map((a) => a.toLowerCase()));
export async function recentBuyers(rec, { blocks = 20_000n, max = 20, exclude = [] } = {}) {
  const latest = await client.getBlockNumber();
  const fromBlock = latest > blocks ? latest - blocks : 0n;
  let logs = [];
  try { logs = await client.getLogs({ address: rec.token, event: TRANSFER_EVENT, args: { from: PM }, fromBlock, toBlock: latest }); } catch { return []; }
  const skip = new Set([...exclude.map((a) => a.toLowerCase()), ...SYSTEM(rec)]);
  const totals = new Map();
  for (const l of logs) {
    const to = l.args?.to; if (!to || skip.has(to.toLowerCase())) continue;
    totals.set(to, (totals.get(to) || 0n) + (l.args.value || 0n));
  }
  return [...totals.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, max).map(([address, bought]) => ({ address, bought }));
}

export const blockNumber = () => client.getBlockNumber();
export const blockHash = async (n) => (await client.getBlock({ blockNumber: n })).hash;

// Compras entre dois blocos: Swap da pool + Transfer PoolManager -> comprador, casados por transacao.
export async function buysBetween(rec, fromBlock, toBlock) {
  if (toBlock < fromBlock) return [];
  try {
    const info = rec.poolId ? { poolId: rec.poolId, tokenIsCurrency0: rec.tokenIsCurrency0 } : await launchOf(rec.token).then(async (l) => ({ poolId: await client.readContract({ address: l.splitter, abi: SPLITTER_ABI, functionName: 'poolId' }), tokenIsCurrency0: l.tokenIsCurrency0 }));
    const [swaps, transfers] = await Promise.all([
      client.getLogs({ address: PM, event: SWAP_EVENT, args: { id: info.poolId }, fromBlock, toBlock }),
      client.getLogs({ address: rec.token, event: TRANSFER_EVENT, args: { from: PM }, fromBlock, toBlock }),
    ]);
    const skip = SYSTEM(rec);
    const byTx = new Map();
    for (const t of transfers) { const to = t.args?.to; if (!to || skip.has(to.toLowerCase())) continue; const cur = byTx.get(t.transactionHash); if (!cur || (t.args.value || 0n) > cur.tokensOut) byTx.set(t.transactionHash, { recipient: to, tokensOut: t.args.value || 0n }); }
    const out = [];
    for (const s of swaps) {
      const usdcLeg = info.tokenIsCurrency0 ? s.args.amount1 : s.args.amount0;
      if (usdcLeg >= 0n) continue; // venda (USDC saiu para o vendedor): so contamos compras
      const t = byTx.get(s.transactionHash); if (!t) continue;
      out.push({ recipient: t.recipient, quoteIn: -usdcLeg, tokensOut: t.tokensOut, block: s.blockNumber });
    }
    return out;
  } catch { return []; }
}

// Quem vendeu = mandou token para o PoolManager.
export async function sellersSince(rec, blocks = 20_000n) {
  const latest = await client.getBlockNumber();
  const fromBlock = latest > blocks ? latest - blocks : 0n;
  try {
    const logs = await client.getLogs({ address: rec.token, event: TRANSFER_EVENT, args: { to: PM }, fromBlock, toBlock: latest });
    return new Set(logs.map((l) => String(l.args?.from || '').toLowerCase()));
  } catch { return new Set(); }
}

// Saida: nao ha papel para devolver. O agente continua criador; o que muda e
// que passa a repassar tudo ao dono (agent.js cuida disso). Permanente.
export async function releaseToOwner() {
  return { txs: [], ok: true, permanent: true };
}

// O agente lanca o token com a propria carteira (financiada pelo dono):
// aprova o dev buy, chama o portal, espera o recibo.
export async function agentLaunch(pk, { rec, quote }) {
  const txs = [];
  if (quote.devBuy > 0n) {
    const allowance = await client.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'allowance', args: [rec.agent, CONTRACTS.portal] });
    if (allowance < quote.devBuy) {
      const a = await agentWrite(pk, { address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [CONTRACTS.portal, quote.devBuy] });
      txs.push({ label: 'approve', hash: a.hash, ok: a.ok });
      if (!a.ok) return { ok: false, txs, error: 'the USDC approval reverted' };
    }
  }
  const w = walletFor(pk);
  const hash = await w.sendTransaction({ to: quote.tx.to, data: quote.tx.data, value: 0n });
  const r = await waitForReceipt(hash, { kind: 'launch' });
  txs.push({ label: 'launch', hash, ok: r.ok });
  return { ...r, hash, txs, error: r.ok ? null : 'the launch reverted on-chain' };
}

export const verifySignedMessage = ({ address, message, signature }) => verifyMessage({ address, message, signature }).catch(() => false);

// Expostos para testes.
export const _math = { sqrtAtTick, startTickFor, initialLiquidity, swapOut, priceUsd, predictToken, mineHookSalt, hookInitHash, saltFor };
export { formatEther, formatUnits, getAddress, ERC20_ABI, DEAD_ADDRESS, QuoteError };
// Transferencia simples de USDC nativo (o dono financia a carteira do agente).
export const fundingTx = (to, amountQ) => ({ to, data: '0x', value: quoteToNative(amountQ) });
