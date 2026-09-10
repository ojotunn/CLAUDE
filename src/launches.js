// Regras do produto: validar o pedido, cotar, preparar, vincular a carteira e
// acompanhar um lancamento (ou uma compra na curva). Nada aqui assina.
import crypto from 'node:crypto';
import { z } from 'zod';
import { isAddress } from 'viem';
import { LIMITS, PUBLIC_URL, CHAIN, PONS_TOKEN_URL } from './config.js';
import { Store } from './store.js';
import * as chain from './chain.js';

const { parseEther, formatEther, formatUnits, getAddress } = chain;

export const launches = new Store('launches');

export class UserError extends Error {
  constructor(message, code = 'BAD_REQUEST') { super(message); this.code = code; }
}

// ---------------------------------------------------------------------------
// Validacao do pedido de lancamento.
// Texto que vai para a chain e volta para o chat: sem caracteres de controle.
// (montada por codigo de caractere de proposito: controles C0/C1, zero-width,
// marcas bidi e BOM; sem escapes no fonte)
const ch = (c) => String.fromCharCode(c);
export const CONTROL_CHARS = new RegExp(
  '[' + ch(0) + '-' + ch(31) + ch(127) + '-' + ch(159) + ch(0x200b) + '-' + ch(0x200f)
  + ch(0x2028) + '-' + ch(0x202e) + ch(0x2060) + '-' + ch(0x2064) + ch(0xfeff) + ']', 'g');
const clean = (s) => String(s).replace(CONTROL_CHARS, '').trim();
const address = z.string().trim().refine((v) => isAddress(v), 'invalid EVM address').transform((v) => getAddress(v));
const ethAmount = z.union([z.string(), z.number()])
  .transform((v) => String(v).trim().replace(/\s*eth$/i, ''))
  .refine((v) => /^\d+(\.\d{1,18})?$/.test(v), 'ETH amount must be a decimal number like 0.05')
  .refine((v) => Number(v) <= 1000, 'ETH amount is too large');
const text = (max) => z.string().transform(clean).pipe(z.string().max(max)).default('');

export const LaunchInput = z.object({
  name: z.string().transform(clean).pipe(z.string().min(1, 'name is required').max(40)),
  symbol: z.string().transform(clean).pipe(z.string().min(1, 'ticker is required').max(12)).transform((s) => s.replace(/^\$/, '').toUpperCase()),
  description: text(600),
  logo: text(300),
  socials: z.object({
    twitter: text(200), telegram: text(200), discord: text(200), website: text(200), farcaster: text(200),
  }).default({}),
  creatorTaxBps: z.number().int().min(0).max(10_000).default(LIMITS.defaultCreatorTaxBps),
  buybackEnabled: z.boolean().default(false),
  devBuyEth: ethAmount.default('0'),
  creatorFeeRecipient: address.optional(),
  wallet: address.optional(),
});

export const BuyInput = z.object({
  token: address,
  ethAmount: ethAmount.refine((v) => Number(v) > 0, 'ETH amount must be above zero'),
  wallet: address.optional(),
});

// ---------------------------------------------------------------------------
// Utilidades.
const randomSalt = () => `0x${crypto.randomBytes(32).toString('hex')}`;
const throwaway = () => getAddress(`0x${crypto.randomBytes(20).toString('hex')}`);
const bpsOf = (part, whole) => (whole > 0n ? Number((part * 10_000n) / whole) : 0);
const pct = (bps) => `${(bps / 100).toFixed(2)}%`;
const hex = (n) => `0x${n.toString(16)}`;
const tokensStr = (wei) => Number(formatUnits(wei, 18)).toLocaleString('en-US', { maximumFractionDigits: 0 });

export const links = ({ token, curve, txHash }) => ({
  pons: token ? PONS_TOKEN_URL.replace('{token}', token) : null,
  explorerToken: token ? `${CHAIN.explorer}/token/${token}` : null,
  explorerCurve: curve ? `${CHAIN.explorer}/address/${curve}` : null,
  explorerTx: txHash ? `${CHAIN.explorer}/tx/${txHash}` : null,
});

function mapZodError(e) {
  const issues = e.issues?.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`) ?? [String(e)];
  return new UserError(issues.join('; '), 'INVALID_INPUT');
}

async function simulateLaunch({ terms, params, devBuyWei, recipient, from, minTokensOut = 0n }) {
  const tx = chain.buildLaunchTx({ params, devBuyWei, recipient, launchFee: terms.launchFee, minTokensOut });
  try {
    const data = await chain.simulate({ from, to: tx.to, data: tx.data, value: tx.value, fund: true });
    return { tx, ...chain.decodeLaunchResult(tx.via, data) };
  } catch (e) {
    const r = chain.explainRevert(e);
    throw new UserError(`launch simulation failed: ${r.message}`, r.code);
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

// ---------------------------------------------------------------------------
// Previa (usada pelo preview_launch e pelo prepare_launch).
async function quoteLaunch(raw) {
  let input;
  try { input = LaunchInput.parse(raw); } catch (e) { throw mapZodError(e); }

  const terms = await chain.protocolTerms();
  const warnings = [];
  if (!terms.configEnabled) throw new UserError('pons has this launch config disabled right now', 'CONFIG_DISABLED');
  if (input.creatorTaxBps > terms.maxCreatorTaxBps) {
    throw new UserError(`creator tax ${pct(input.creatorTaxBps)} is above the pons maximum of ${pct(terms.maxCreatorTaxBps)}`, 'CREATOR_TAX_TOO_HIGH');
  }
  if (input.wallet) {
    if (!(await chain.canLaunch(input.wallet))) throw new UserError('pons is only accepting launches from whitelisted wallets and this wallet is not on the list', 'NOT_WHITELISTED');
  } else if (!terms.launchEnabled) {
    warnings.push('pons launches are currently whitelisted; the signing wallet must be on the pons list');
  }

  const from = input.wallet || throwaway();
  const salt = randomSalt();
  const params = {
    ...input,
    creatorFeeRecipient: input.creatorFeeRecipient || from,
    expectedEconomics: terms.economics,
    salt,
  };
  let devBuyWei = parseEther(input.devBuyEth);
  let sim = await simulateLaunch({ terms, params, devBuyWei, recipient: from, from });

  if (devBuyWei > 0n) {
    const bps = bpsOf(sim.tokensOut, terms.supply);
    if (bps > LIMITS.maxDevBuyBps) {
      const clamped = await clampDevBuy({ terms, params, recipient: from, from, requestedWei: devBuyWei, capBps: LIMITS.maxDevBuyBps });
      if (!clamped) throw new UserError(`even the smallest dev buy exceeds the ${pct(LIMITS.maxDevBuyBps)} cap`, 'DEV_BUY_CAP');
      warnings.push(`dev buy reduced from ${input.devBuyEth} to ${formatEther(clamped.wei)} ETH so it stays under ${pct(LIMITS.maxDevBuyBps)} of supply`);
      devBuyWei = clamped.wei;
      sim = clamped.sim;
    }
  }

  const devBuyBps = bpsOf(sim.tokensOut, terms.supply);
  return {
    input, terms, salt, devBuyWei, sim, warnings,
    summary: {
      network: CHAIN.name,
      name: input.name,
      symbol: input.symbol,
      description: input.description,
      logo: input.logo || null,
      socials: input.socials,
      supply: terms.supplyTokens,
      creatorTax: pct(input.creatorTaxBps),
      creatorTaxBps: input.creatorTaxBps,
      buybackEnabled: input.buybackEnabled,
      creatorFeeRecipient: input.creatorFeeRecipient || 'the wallet that signs',
      devBuy: devBuyWei > 0n ? {
        eth: formatEther(devBuyWei),
        tokens: tokensStr(sim.tokensOut),
        shareOfSupply: pct(devBuyBps),
        capShareOfSupply: pct(LIMITS.maxDevBuyBps),
      } : null,
      cost: {
        launchFeeEth: terms.launchFeeEth,
        devBuyEth: formatEther(devBuyWei),
        totalEth: formatEther(terms.launchFee + devBuyWei),
        plusGas: 'network gas is paid by the signing wallet on top',
      },
      graduatesAtEth: terms.graduationThresholdEth,
      route: sim.tx.via === 'router' ? 'pons launch-and-buy router (launch and dev buy in one transaction)' : 'pons factory',
      predicted: input.wallet ? { token: sim.token, curve: sim.curve } : null,
      warnings,
    },
  };
}

export async function preview(raw) {
  const q = await quoteLaunch(raw);
  return q.summary;
}

// ---------------------------------------------------------------------------
// Prepara: guarda o pedido e devolve o link de assinatura.
export async function prepare(raw) {
  const q = await quoteLaunch(raw);
  const now = Date.now();
  const rec = launches.put({
    id: launches.newId(),
    kind: 'launch',
    status: 'awaiting_wallet',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LIMITS.launchTtlMs).toISOString(),
    network: CHAIN.network,
    chainId: CHAIN.id,
    input: {
      name: q.input.name, symbol: q.input.symbol, description: q.input.description, logo: q.input.logo,
      socials: q.input.socials, creatorTaxBps: q.input.creatorTaxBps, buybackEnabled: q.input.buybackEnabled,
      creatorFeeRecipient: q.input.creatorFeeRecipient || null,
    },
    devBuyEth: formatEther(q.devBuyWei),
    salt: q.salt,
    terms: { launchFeeEth: q.terms.launchFeeEth, supply: q.terms.supplyTokens, economics: q.terms.economics },
    summary: q.summary,
    warnings: q.warnings,
    wallet: null, tx: null, predicted: null, funding: null, txHash: null, token: null, curve: null, tokensOut: null, error: null,
  });
  return publicRecord(rec);
}

// ---------------------------------------------------------------------------
// Compra na curva de um token ja lancado.
export async function prepareBuy(raw) {
  let input;
  try { input = BuyInput.parse(raw); } catch (e) { throw mapZodError(e); }
  const info = await chain.tokenInfo(input.token);
  if (!info) throw new UserError('this address is not a pons v2 launch on this network', 'NOT_PONS_TOKEN');
  if (info.graduated || info.phase !== 'bonding curve') {
    throw new UserError(`${info.symbol} has left the bonding curve (${info.phase}); Claudeploy only buys on the curve`, 'GRADUATED');
  }
  const from = input.wallet || throwaway();
  const quoteInWei = parseEther(input.ethAmount);
  const sim = await simulateBuy({ curve: info.curve, quoteInWei, recipient: from, from });
  const now = Date.now();
  const rec = launches.put({
    id: launches.newId(),
    kind: 'buy',
    status: 'awaiting_wallet',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LIMITS.launchTtlMs).toISOString(),
    network: CHAIN.network,
    chainId: CHAIN.id,
    token: info.token, curve: info.curve, symbol: info.symbol, name: info.name,
    ethAmount: input.ethAmount,
    summary: {
      network: CHAIN.name,
      token: info.token, name: info.name, symbol: info.symbol,
      spend: { eth: input.ethAmount, tokens: tokensStr(sim.tokensOut) },
      priceEth: info.priceEth,
      graduationProgress: info.graduationProgress,
      plusGas: 'network gas is paid by the signing wallet on top',
    },
    warnings: [],
    wallet: null, tx: null, predicted: null, funding: null, txHash: null, tokensOut: null, error: null,
  });
  return publicRecord(rec);
}

async function simulateBuy({ curve, quoteInWei, recipient, from, minTokensOut = 0n }) {
  const tx = chain.buildBuyTx({ curve, quoteInWei, minTokensOut, recipient });
  try {
    const data = await chain.simulate({ from, to: tx.to, data: tx.data, value: tx.value, fund: true });
    return { tx, ...chain.decodeBuyResult(data) };
  } catch (e) {
    const r = chain.explainRevert(e);
    throw new UserError(`buy simulation failed: ${r.message}`, r.code);
  }
}

// ---------------------------------------------------------------------------
// Vincula a carteira que vai assinar: simula de verdade a partir dela (o
// endereco do token depende de quem lanca), estima gas e confere saldo.
export async function bind(id, walletRaw) {
  const rec = getOrThrow(id);
  if (!isAddress(walletRaw || '')) throw new UserError('invalid wallet address', 'INVALID_WALLET');
  const wallet = getAddress(walletRaw);
  if (['submitted', 'live', 'done'].includes(rec.status)) throw new UserError('this transaction was already signed', 'ALREADY_SIGNED');
  if (Date.parse(rec.expiresAt) < Date.now()) { rec.status = 'expired'; launches.put(rec); throw new UserError('this link expired; ask Claude to prepare it again', 'EXPIRED'); }

  let sim, tx, predicted;
  if (rec.kind === 'launch') {
    const terms = await chain.protocolTerms({ fresh: true });
    if (!(await chain.canLaunch(wallet))) throw new UserError('pons is only accepting launches from whitelisted wallets and this wallet is not on the list', 'NOT_WHITELISTED');
    if (terms.economics !== rec.terms.economics) {
      const note = 'pons updated its launch terms since the preview; this launch is pinned to the current terms';
      if (!(rec.warnings || []).includes(note)) rec.warnings = [...(rec.warnings || []), note];
      rec.terms = { launchFeeEth: terms.launchFeeEth, supply: terms.supplyTokens, economics: terms.economics };
    }
    const params = {
      ...rec.input,
      creatorFeeRecipient: rec.input.creatorFeeRecipient || wallet,
      expectedEconomics: terms.economics,
      salt: rec.salt,
    };
    const devBuyWei = parseEther(rec.devBuyEth);
    sim = await simulateLaunch({ terms, params, devBuyWei, recipient: wallet, from: wallet });
    // Recompoe com o piso de slippage: a curva nasce na mesma transacao, entao
    // 1% de folga cobre so o arredondamento.
    const minTokensOut = (sim.tokensOut * 99n) / 100n;
    tx = chain.buildLaunchTx({ params, devBuyWei, recipient: wallet, launchFee: terms.launchFee, minTokensOut });
    predicted = { token: sim.token, curve: sim.curve, tokensOut: tokensStr(sim.tokensOut) };
    rec.creatorFeeRecipient = params.creatorFeeRecipient;
  } else {
    const quoteInWei = parseEther(rec.ethAmount);
    sim = await simulateBuy({ curve: rec.curve, quoteInWei, recipient: wallet, from: wallet });
    // Outros podem negociar antes de a transacao entrar: 3% de folga.
    const minTokensOut = (sim.tokensOut * 97n) / 100n;
    tx = chain.buildBuyTx({ curve: rec.curve, quoteInWei, minTokensOut, recipient: wallet });
    predicted = { token: rec.token, curve: rec.curve, tokensOut: tokensStr(sim.tokensOut) };
  }

  const balance = await chain.getBalance(wallet);
  let gas = null, funding;
  try {
    gas = await chain.estimateGas({ from: wallet, to: tx.to, data: tx.data, value: tx.value });
    funding = { ok: true, balanceEth: formatEther(balance), requiredEth: formatEther(tx.value), message: null };
  } catch (e) {
    const r = chain.explainRevert(e);
    const short = balance < tx.value;
    funding = {
      ok: false,
      balanceEth: formatEther(balance),
      requiredEth: formatEther(tx.value),
      message: short
        ? `this wallet holds ${formatEther(balance)} ETH and needs at least ${formatEther(tx.value)} ETH plus gas on ${CHAIN.name}`
        : r.message,
    };
  }

  rec.wallet = wallet;
  rec.tx = { to: tx.to, data: tx.data, value: hex(tx.value), gas: gas ? hex((gas * 120n) / 100n) : null, chainId: hex(BigInt(CHAIN.id)) };
  rec.predicted = predicted;
  rec.funding = funding;
  rec.status = funding.ok ? 'ready' : 'needs_funds';
  rec.boundAt = new Date().toISOString();
  launches.put(rec);
  return publicRecord(rec);
}

// ---------------------------------------------------------------------------
// A carteira assinou e devolveu o hash: acompanhar ate o recibo.
export async function submitted(id, hash) {
  const rec = getOrThrow(id);
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash || '')) throw new UserError('invalid transaction hash', 'INVALID_HASH');
  if (!rec.tx) throw new UserError('connect a wallet before submitting', 'NOT_BOUND');
  if (rec.txHash && rec.txHash !== hash) throw new UserError('a different transaction was already submitted for this link', 'ALREADY_SIGNED');
  rec.txHash = hash;
  rec.status = 'submitted';
  rec.submittedAt = new Date().toISOString();
  launches.put(rec);
  watch(rec);
  return publicRecord(rec);
}

// O hash chega de quem tem o link, sem autenticacao. Antes de acreditar nele,
// o observador confere que a transacao e EXATAMENTE a que este servidor montou
// (mesmo remetente, destino, calldata e valor). Sem isso, qualquer um poderia
// colar o hash do lancamento de outra pessoa e aparecer no feed como criador.
const watching = new Set();
const MAX_WATCHERS = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eq = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();

function fail(rec, error) {
  rec.status = 'failed';
  rec.error = error;
  launches.put(rec);
  console.log(`[launch] ${rec.id} failed: ${error}`);
}

function watch(rec) {
  if (watching.has(rec.id)) return;
  if (watching.size >= MAX_WATCHERS) return; // resumeWatchers volta a tentar depois
  watching.add(rec.id);
  (async () => {
    // 1) localizar a transacao (a carteira acabou de transmitir; pode levar segundos)
    let tx = null;
    for (let i = 0; i < 45 && !tx; i++) {
      tx = await chain.getTransaction(rec.txHash);
      if (!tx) await sleep(4_000);
    }
    if (!tx) {
      rec.error = 'the transaction has not been seen on the network yet';
      if (Date.parse(rec.expiresAt) < Date.now()) return fail(rec, 'the transaction never reached the network');
      launches.put(rec);
      return;
    }
    // 2) conferir que e a nossa
    const same = eq(tx.from, rec.wallet) && eq(tx.to, rec.tx.to)
      && eq(tx.input, rec.tx.data) && BigInt(tx.value ?? 0) === BigInt(rec.tx.value);
    if (!same) return fail(rec, 'the submitted transaction is not the one prepared for this link');
    // 3) esperar o recibo
    const r = await chain.waitForReceipt(rec.txHash);
    if (!r.ok) return fail(rec, 'the transaction reverted on-chain');
    if (rec.kind === 'launch') {
      if (!r.token) return fail(rec, 'the transaction confirmed but no pons launch event was found');
      rec.status = 'live';
      rec.token = r.token;
      rec.curve = r.curve;
      rec.tokensOut = tokensStr(r.tokensOut);
    } else {
      rec.status = 'done';
      rec.tokensOut = tokensStr(r.tokensOut);
    }
    rec.error = null;
    rec.confirmedAt = new Date().toISOString();
    rec.blockNumber = r.blockNumber.toString();
    launches.put(rec);
    console.log(`[launch] ${rec.id} ${rec.status}${rec.token ? ` token=${rec.token}` : ''}`);
  })().catch((e) => {
    rec.error = `still waiting for confirmation: ${String(e.shortMessage || e.message).split('\n')[0].slice(0, 160)}`;
    launches.put(rec);
    console.error(`[launch] ${rec.id} watch error: ${rec.error}`);
  }).finally(() => watching.delete(rec.id));
}

export function resumeWatchers() {
  for (const rec of launches.list((r) => r.status === 'submitted' && r.txHash)) watch(rec);
}

// Poda: pedidos nunca assinados somem um dia depois de expirar; o total de
// pedidos abertos tem teto, para ninguem encher o disco criando links.
const OPEN = new Set(['awaiting_wallet', 'needs_funds', 'ready', 'expired']);
const MAX_OPEN = Number(process.env.MAX_OPEN_LAUNCHES || 1000);
export function prune() {
  const now = Date.now();
  let removed = 0;
  for (const r of launches.list()) {
    const age = now - Date.parse(r.createdAt);
    if (OPEN.has(r.status) && age > LIMITS.launchTtlMs + 24 * 3600 * 1000) { launches.remove(r.id); removed++; }
    else if (r.status === 'submitted' && age > 3 * 24 * 3600 * 1000) { r.status = 'failed'; r.error = 'never confirmed'; }
  }
  const open = launches.list((r) => OPEN.has(r.status)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  while (open.length > MAX_OPEN) { launches.remove(open.shift().id); removed++; }
  if (removed) launches.save();
  return removed;
}

// ---------------------------------------------------------------------------
// Leitura.
function getOrThrow(id) {
  const rec = launches.get(String(id || ''));
  if (!rec) throw new UserError('no launch with this id', 'NOT_FOUND');
  return rec;
}

export function status(id) { return publicRecord(getOrThrow(id)); }

export function recent(limit = 20) {
  return launches
    .list((r) => r.kind === 'launch' && r.status === 'live')
    .sort((a, b) => Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
    .map((r) => ({
      id: r.id, name: r.input.name, symbol: r.input.symbol, token: r.token, curve: r.curve,
      deployer: r.wallet, confirmedAt: r.confirmedAt, links: links({ token: r.token, curve: r.curve, txHash: r.txHash }),
    }));
}

export function publicRecord(rec) {
  const { salt, ...rest } = rec; // o salt nao e segredo, mas tambem nao e util fora daqui
  return {
    ...rest,
    url: `${PUBLIC_URL}/l/${rec.id}`,
    links: links({ token: rec.token || rec.predicted?.token, curve: rec.curve || rec.predicted?.curve, txHash: rec.txHash }),
    explorer: CHAIN.explorer,
  };
}
