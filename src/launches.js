// Regras do produto: validar o pedido, cotar, preparar, vincular a carteira e
// acompanhar um lancamento (ou uma compra). Nada aqui assina em nome do
// usuario. O que e especifico da chain mora no venue (chain.js).
import crypto from 'node:crypto';
import { z } from 'zod';
import { isAddress } from 'viem';
import { LIMITS, PUBLIC_URL, CHAIN, VENUE } from './config.js';
import { Store } from './store.js';
import * as chain from './chain.js';

const { formatUnits, getAddress } = chain;

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
const unit = chain.quoteSymbol;
const amountStr = z.union([z.string(), z.number()])
  .transform((v) => String(v).trim().replace(new RegExp(`\\s*(${unit}|eth|usdc)$`, 'i'), ''))
  .refine((v) => /^\d+(\.\d{1,18})?$/.test(v), `${unit} amount must be a decimal number like 0.05`)
  .refine((v) => Number(v) <= (VENUE === 'argus' ? 1_000_000 : 1000), `${unit} amount is too large`);
const text = (max) => z.string().transform(clean).pipe(z.string().max(max)).default('');
const bps = z.number().int().min(0).max(10_000);
const pctToBps = (v) => Math.round(Number(v) * 100);

export const LaunchInput = z.object({
  name: z.string().transform(clean).pipe(z.string().min(1, 'name is required').max(40)),
  symbol: z.string().transform(clean).pipe(z.string().min(1, 'ticker is required').max(12)).transform((s) => s.replace(/^\$/, '').toUpperCase()),
  description: text(600),
  logo: text(300),
  socials: z.object({
    twitter: text(200), telegram: text(200), discord: text(200), website: text(200), farcaster: text(200),
  }).default({}),
  creatorTaxBps: bps.default(LIMITS.defaultCreatorTaxBps),
  // Argus: taxas separadas e o split da taxa (soma 100%).
  buyTaxBps: bps.optional(),
  sellTaxBps: bps.optional(),
  split: z.object({ creatorBps: bps, burnBps: bps, holdersBps: bps, liquidityBps: bps }).optional(),
  buybackEnabled: z.boolean().default(false),
  devBuy: amountStr.default('0'),
  creatorFeeRecipient: address.optional(),
  wallet: address.optional(),
  // Lancamento pelo agente (o agente e o criador; o dono financia a carteira dele).
  agent: z.object({
    vibe: text(200), avatar: text(300),
    rules: z.record(z.string(), z.any()).optional(),
  }).optional(),
});

export const BuyInput = z.object({
  token: address,
  amount: amountStr.refine((v) => Number(v) > 0, `${unit} amount must be above zero`),
  wallet: address.optional(),
});

// Percentuais que o chat manda (split, taxas) viram pontos-base aqui.
export function normalizeLaunchRequest(a = {}) {
  const out = {
    name: a.name, symbol: a.symbol, description: a.description, logo: a.logo,
    socials: { twitter: a.twitter, telegram: a.telegram, discord: a.discord, website: a.website, farcaster: a.farcaster },
    devBuy: a.devBuy ?? a.devBuyEth ?? a.devBuyUsdc,
    creatorTaxBps: a.creatorTaxBps, buybackEnabled: a.buybackEnabled,
    creatorFeeRecipient: a.creatorFeeRecipient, wallet: a.wallet,
  };
  if (a.buyTaxPct != null) out.buyTaxBps = pctToBps(a.buyTaxPct);
  if (a.sellTaxPct != null) out.sellTaxBps = pctToBps(a.sellTaxPct);
  if (a.buyTaxBps != null) out.buyTaxBps = a.buyTaxBps;
  if (a.sellTaxBps != null) out.sellTaxBps = a.sellTaxBps;
  if (a.creatorShare != null || a.burnShare != null || a.holdersShare != null || a.liquidityShare != null) {
    out.split = { creatorBps: pctToBps(a.creatorShare ?? 0), burnBps: pctToBps(a.burnShare ?? 0), holdersBps: pctToBps(a.holdersShare ?? 0), liquidityBps: pctToBps(a.liquidityShare ?? 0) };
  }
  if (a.withAgent || a.agent) {
    const rules = {};
    for (const k of ['preset', 'buybackPct', 'airdropPct', 'salaryPct', 'rafflePct', 'loyaltyOnly', 'dipBuyPct', 'milestones', 'collectOnly', 'quietHours', 'minPostMin', 'whaleAmount', 'whaleEth']) if (a[k] !== undefined) rules[k] = a[k];
    out.agent = { vibe: a.vibe, avatar: a.avatar, rules };
  }
  return JSON.parse(JSON.stringify(out));
}

// ---------------------------------------------------------------------------
// Utilidades.
const randomSalt = () => `0x${crypto.randomBytes(32).toString('hex')}`;
const throwaway = () => getAddress(`0x${crypto.randomBytes(20).toString('hex')}`);
const pct = (b) => `${(b / 100).toFixed(2)}%`;
const hex = (n) => `0x${n.toString(16)}`;
const tokensStr = (wei) => Number(formatUnits(wei, 18)).toLocaleString('en-US', { maximumFractionDigits: 0 });

export const links = chain.links;

function mapZodError(e) {
  const issues = e.issues?.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`) ?? [String(e)];
  return new UserError(issues.join('; '), 'INVALID_INPUT');
}

const asUser = (e) => (e instanceof chain.QuoteError ? new UserError(e.message, e.code) : e);

// ---------------------------------------------------------------------------
// Previa (usada pelo preview_launch e pelo prepare_launch).
async function quoteLaunch(raw, { from: forced = null } = {}) {
  let input;
  try { input = LaunchInput.parse(raw); } catch (e) { throw mapZodError(e); }
  if (input.agent && !chain.agentMustLaunch) throw new UserError(`on ${chain.NAME} launch first, then give the token an agent with attach_agent`, 'INVALID_INPUT');
  const terms = await chain.protocolTerms();
  const warnings = [];
  if (input.wallet && !input.agent) {
    if (!(await chain.canLaunch(input.wallet))) throw new UserError(`${chain.SHORT} is only accepting launches from whitelisted wallets and this wallet is not on the list`, 'NOT_WHITELISTED');
  } else if (!terms.launchEnabled) {
    warnings.push(`${chain.SHORT} launches are currently whitelisted; the signing wallet must be on the list`);
  }
  const from = forced || (input.agent ? throwaway() : (input.wallet || throwaway()));
  const salt = randomSalt();
  let q;
  try { q = await chain.quoteLaunch({ input, devBuy: chain.parseAmount(input.devBuy), salt, from, terms, exact: false }); } catch (e) { throw asUser(e); }
  warnings.push(...q.warnings);
  const devBuyStr = chain.formatAmount(q.devBuy);
  const summary = {
    venue: chain.NAME, network: CHAIN.name, unit,
    name: input.name, symbol: input.symbol, description: input.description, logo: input.logo || null, socials: input.socials,
    supply: terms.supplyTokens,
    creatorTax: q.extra?.creatorTax ?? null,
    creatorTaxBps: input.creatorTaxBps,
    taxes: q.extra ?? null,
    buybackEnabled: input.buybackEnabled,
    creatorFeeRecipient: input.agent ? 'the agent wallet (it launches the token)' : (input.creatorFeeRecipient || 'the wallet that signs'),
    devBuy: q.devBuy > 0n ? { amount: devBuyStr, unit, tokens: tokensStr(q.tokensOut), shareOfSupply: pct(q.devBuyBps), capShareOfSupply: pct(LIMITS.maxDevBuyBps) } : null,
    cost: { ...q.cost, plusGas: `network gas is paid by the signing wallet on top${VENUE === 'argus' ? ' (in USDC on Arc)' : ''}` },
    graduatesAt: chain.termsSummary(terms).graduatesAt,
    route: q.route,
    predicted: (input.wallet && !input.agent) ? { token: q.predicted.token, curve: q.predicted.curve } : null,
    agent: input.agent ? { vibe: input.agent.vibe || '', howItWorks: `the agent gets a wallet of its own and launches the token from it, so it is the creator on ${chain.NAME} and receives the creator share of the tax; you send the launch money to the agent wallet on the signing page` } : null,
    warnings,
  };
  return { input, terms, salt, q, warnings, summary };
}

export async function preview(raw) {
  const { summary } = await quoteLaunch(raw);
  return summary;
}

// ---------------------------------------------------------------------------
// Prepara: guarda o pedido e devolve o link de assinatura.
export async function prepare(raw) {
  const { input, terms, salt, q, warnings, summary } = await quoteLaunch(raw);
  const now = Date.now();
  const rec = {
    id: launches.newId(),
    kind: input.agent ? 'agent-launch' : 'launch',
    status: 'awaiting_wallet',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LIMITS.launchTtlMs).toISOString(),
    network: CHAIN.network,
    chainId: CHAIN.id,
    venue: VENUE,
    input: {
      name: input.name, symbol: input.symbol, description: input.description, logo: input.logo,
      socials: input.socials, creatorTaxBps: input.creatorTaxBps, buyTaxBps: input.buyTaxBps ?? null, sellTaxBps: input.sellTaxBps ?? null, split: input.split ?? null,
      buybackEnabled: input.buybackEnabled, creatorFeeRecipient: input.creatorFeeRecipient || null,
    },
    devBuy: chain.formatAmount(q.devBuy),
    salt,
    terms: q.terms,
    summary,
    warnings,
    agent: null,
    wallet: null, tx: null, pre: [], predicted: null, funding: null, txHash: null, token: null, curve: null, tokensOut: null, error: null,
  };
  if (input.agent) {
    // O agente nasce agora, com carteira propria; o token e previsto a partir dela.
    const a = await hooks.createAgentForLaunch?.({ rec, agent: input.agent, terms });
    if (!a) throw new UserError('agents are not enabled on this server', 'AGENTS_DISABLED');
    rec.agent = { address: a.address, page: a.page, predictedToken: a.predictedToken, vibe: input.agent.vibe || '' };
    rec.summary.agent = { ...rec.summary.agent, wallet: a.address, predictedToken: a.predictedToken, page: a.page };
  }
  launches.put(rec);
  return publicRecord(rec);
}

// ---------------------------------------------------------------------------
// Compra de um token ja lancado.
export async function prepareBuy(raw) {
  let input;
  try { input = BuyInput.parse({ ...raw, amount: raw.amount ?? raw.ethAmount ?? raw.usdcAmount }); } catch (e) { throw mapZodError(e); }
  const from = input.wallet || throwaway();
  const amount = chain.parseAmount(input.amount);
  let q;
  try { q = await chain.quoteBuy({ token: input.token, amount, from, exact: false }); } catch (e) { throw asUser(e); }
  const info = q.info;
  const now = Date.now();
  const rec = launches.put({
    id: launches.newId(),
    kind: 'buy',
    status: 'awaiting_wallet',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LIMITS.launchTtlMs).toISOString(),
    network: CHAIN.network,
    chainId: CHAIN.id,
    venue: VENUE,
    token: info.token, curve: info.curve, symbol: info.symbol, name: info.name,
    amount: input.amount,
    summary: {
      venue: chain.NAME, network: CHAIN.name, unit,
      token: info.token, name: info.name, symbol: info.symbol,
      spend: { amount: input.amount, unit, tokens: tokensStr(q.tokensOut) },
      price: info.price, priceUnit: VENUE === 'argus' ? 'USD' : unit,
      graduationProgress: info.graduationProgress, graduationLabel: info.graduationLabel,
      plusGas: 'network gas is paid by the signing wallet on top',
      steps: VENUE === 'argus' ? 'the first buy from a wallet takes up to three signatures: approve USDC for Permit2, approve the Uniswap router, then the swap; later buys take one' : 'one signature',
    },
    warnings: [],
    wallet: null, tx: null, pre: [], predicted: null, funding: null, txHash: null, tokensOut: null, error: null,
  });
  return publicRecord(rec);
}

// ---------------------------------------------------------------------------
// Handover das taxas de criador para a carteira de um agente (so onde o
// protocolo permite trocar o recebedor). Quem assina e o recebedor atual.
export async function prepareHandover({ token, name, symbol, agent, currentRecipient }) {
  if (!chain.supportsHandover) throw new UserError(`${chain.NAME} has no way to hand creator fees to another wallet; on ${chain.NAME} the agent launches the token itself (prepare_launch with withAgent)`, 'NO_HANDOVER');
  const now = Date.now();
  const rec = launches.put({
    id: launches.newId(),
    kind: 'handover',
    status: 'awaiting_wallet',
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + LIMITS.launchTtlMs).toISOString(),
    network: CHAIN.network,
    chainId: CHAIN.id,
    venue: VENUE,
    token, name, symbol, agent, currentRecipient,
    summary: {
      venue: chain.NAME, network: CHAIN.name, unit, token, name, symbol, agent, currentRecipient,
      whatHappens: `${symbol}'s creator fees will be paid to the agent wallet from now on. The agent uses them to buy back, burn, airdrop and keep a gas reserve. You can take them back any time from the agent page.`,
      plusGas: 'network gas is paid by the signing wallet',
    },
    warnings: [],
    wallet: null, tx: null, pre: [], predicted: null, funding: null, txHash: null, error: null,
  });
  return publicRecord(rec);
}

// Quem quiser reagir a eventos registra aqui (evita import circular).
export const hooks = { handoverConfirmed: null, agentInfo: null, createAgentForLaunch: null, agentLaunch: null };

const toHexTx = (t) => ({ label: t.label || null, to: t.to, data: t.data, value: hex(t.value || 0n) });

// ---------------------------------------------------------------------------
// Vincula a carteira que vai assinar: simula de verdade a partir dela (o
// endereco do token depende de quem lanca), estima gas e confere saldo.
export async function bind(id, walletRaw) {
  const rec = getOrThrow(id);
  if (!isAddress(walletRaw || '')) throw new UserError('invalid wallet address', 'INVALID_WALLET');
  const wallet = getAddress(walletRaw);
  if (['submitted', 'live', 'done', 'launching'].includes(rec.status)) throw new UserError('this transaction was already signed', 'ALREADY_SIGNED');
  if (Date.parse(rec.expiresAt) < Date.now()) { rec.status = 'expired'; launches.put(rec); throw new UserError('this link expired; ask Claude to prepare it again', 'EXPIRED'); }

  let tx, pre = [], predicted, funding;
  try {
    if (rec.kind === 'launch') {
      const terms = await chain.protocolTerms({ fresh: true });
      if (!(await chain.canLaunch(wallet))) throw new UserError(`${chain.SHORT} is only accepting launches from whitelisted wallets and this wallet is not on the list`, 'NOT_WHITELISTED');
      if (rec.terms?.pin && terms.pin !== rec.terms.pin) {
        const note = `${chain.SHORT} updated its launch terms since the preview; this launch is pinned to the current terms`;
        if (!(rec.warnings || []).includes(note)) rec.warnings = [...(rec.warnings || []), note];
      }
      const q = await chain.quoteLaunch({ input: rec.input, devBuy: chain.parseAmount(rec.devBuy), salt: rec.salt, from: wallet, terms, exact: true });
      rec.terms = q.terms;
      tx = q.tx; pre = q.pre;
      predicted = { token: q.predicted.token, curve: q.predicted.curve, tokensOut: tokensStr(q.tokensOut) };
      rec.creatorFeeRecipient = q.creatorFeeRecipient;
      funding = await chain.fundingCheck({ wallet, tx, pre, devBuy: q.devBuy });
    } else if (rec.kind === 'agent-launch') {
      // O dono nao lanca: ele manda o dinheiro do lancamento para a carteira do agente.
      const terms = await chain.protocolTerms({ fresh: true });
      const q = await chain.quoteLaunch({ input: rec.input, devBuy: chain.parseAmount(rec.devBuy), salt: rec.salt, from: rec.agent.address, terms, exact: false });
      const need = hooks.agentLaunchBudget ? hooks.agentLaunchBudget(q) : q.devBuy;
      tx = chain.fundingTx ? chain.fundingTx(rec.agent.address, need) : { to: rec.agent.address, data: '0x', value: need };
      predicted = { token: q.predicted.token, curve: q.predicted.curve, tokensOut: tokensStr(q.tokensOut) };
      rec.agent.predictedToken = q.predicted.token;
      rec.agent.budget = chain.formatAmount(need);
      rec.summary.agent = { ...(rec.summary.agent || {}), send: `${chain.formatAmount(need)} ${unit}`, predictedToken: q.predicted.token };
      funding = await chain.fundingCheck({ wallet, tx, pre: [], devBuy: need });
    } else if (rec.kind === 'handover') {
      const current = (await chain.feeRecipient(rec.token)) || rec.currentRecipient;
      if (getAddress(current) !== wallet) throw new UserError(`only the current fee recipient (${current}) can hand the fees over`, 'FORBIDDEN');
      tx = chain.buildHandoverTx({ token: rec.token, newRecipient: rec.agent });
      const info = hooks.agentInfo?.(rec.token);
      if (info) {
        rec.summary.vibe = info.vibe || '';
        rec.summary.avatar = info.avatar || null;
        rec.summary.split = info.split;
      }
      try {
        await chain.simulate({ from: wallet, to: tx.to, data: tx.data, value: 0n, fund: true });
      } catch (e) {
        const r = chain.explainRevert(e);
        throw new UserError(`handover simulation failed: ${r.message}`, r.code);
      }
      predicted = { token: rec.token, curve: null, tokensOut: null };
      funding = await chain.fundingCheck({ wallet, tx, pre: [], devBuy: 0n });
    } else {
      const amount = chain.parseAmount(rec.amount);
      const q = await chain.quoteBuy({ token: rec.token, amount, from: wallet, exact: true });
      tx = q.tx; pre = q.pre;
      predicted = { token: rec.token, curve: rec.curve, tokensOut: tokensStr(q.tokensOut) };
      funding = await chain.fundingCheckBuy({ wallet, tx, pre, amount });
    }
  } catch (e) { throw asUser(e); }

  rec.wallet = wallet;
  rec.tx = { to: tx.to, data: tx.data, value: hex(tx.value || 0n), gas: funding.gas ? hex((funding.gas * 120n) / 100n) : null, chainId: hex(BigInt(CHAIN.id)) };
  rec.pre = pre.map(toHexTx);
  rec.predicted = predicted;
  rec.funding = { ok: funding.ok, balance: funding.balance, required: funding.required, unit: funding.unit, message: funding.message, balanceEth: funding.balance, requiredEth: funding.required };
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
    const r = await chain.waitForReceipt(rec.txHash, { kind: rec.kind === 'buy' ? 'buy' : rec.kind === 'launch' ? 'launch' : 'transfer', wallet: rec.wallet, token: rec.token });
    if (!r.ok) return fail(rec, 'the transaction reverted on-chain');
    rec.blockNumber = r.blockNumber.toString();
    if (rec.kind === 'handover') {
      rec.status = 'done';
      rec.error = null;
      rec.confirmedAt = new Date().toISOString();
      launches.put(rec);
      console.log(`[handover] ${rec.id} confirmed for ${rec.symbol}`);
      try { await hooks.handoverConfirmed?.(rec); } catch (e) { console.error('[handover hook]', e); }
      return;
    }
    if (rec.kind === 'agent-launch') {
      // O dinheiro chegou na carteira do agente: agora o agente lanca.
      rec.status = 'launching';
      rec.error = null;
      rec.fundedAt = new Date().toISOString();
      launches.put(rec);
      console.log(`[agent-launch] ${rec.id} funded; agent ${rec.agent.address} launching ${rec.input.symbol}`);
      try {
        const out = await hooks.agentLaunch?.(rec);
        if (!out?.ok) return fail(rec, out?.error || 'the agent could not launch the token');
        rec.status = 'live';
        rec.token = out.token;
        rec.curve = out.curve;
        rec.tokensOut = tokensStr(out.tokensOut || 0n);
        rec.launchTxHash = out.hash;
        rec.confirmedAt = new Date().toISOString();
        launches.put(rec);
        console.log(`[agent-launch] ${rec.id} live token=${rec.token}`);
      } catch (e) {
        return fail(rec, `the agent could not launch: ${String(e?.shortMessage || e?.message || e).split('\n')[0].slice(0, 160)}`);
      }
      return;
    }
    if (rec.kind === 'launch') {
      if (!r.token) return fail(rec, `the transaction confirmed but no ${chain.SHORT} launch event was found`);
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
  // Lancamentos pelo agente que ficaram no meio (o processo caiu depois do dinheiro chegar).
  for (const rec of launches.list((r) => r.kind === 'agent-launch' && r.status === 'launching')) {
    (async () => {
      try {
        const out = await hooks.agentLaunch?.(rec);
        if (!out?.ok) return fail(rec, out?.error || 'the agent could not launch the token');
        rec.status = 'live'; rec.token = out.token; rec.curve = out.curve; rec.tokensOut = tokensStr(out.tokensOut || 0n); rec.launchTxHash = out.hash; rec.confirmedAt = new Date().toISOString(); launches.put(rec);
      } catch (e) { fail(rec, `the agent could not launch: ${String(e?.message || e).slice(0, 160)}`); }
    })();
  }
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

export const get = (id) => launches.get(String(id || '')) ?? null;

export function status(id) { return publicRecord(getOrThrow(id)); }

export function recent(limit = 20) {
  return launches
    .list((r) => (r.kind === 'launch' || r.kind === 'agent-launch') && r.status === 'live')
    .sort((a, b) => Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)))
    .map((r) => ({
      id: r.id, name: r.input.name, symbol: r.input.symbol, token: r.token, curve: r.curve,
      deployer: r.kind === 'agent-launch' ? r.agent?.address : r.wallet, owner: r.wallet, byAgent: r.kind === 'agent-launch',
      confirmedAt: r.confirmedAt, links: links({ token: r.token, curve: r.curve, txHash: r.launchTxHash || r.txHash }),
    }));
}

// Registros antigos (da primeira versao, so pons) ganham os nomes novos na leitura.
function upgrade(rec) {
  if (rec.devBuy === undefined && rec.devBuyEth !== undefined) rec.devBuy = rec.devBuyEth;
  if (rec.amount === undefined && rec.ethAmount !== undefined) rec.amount = rec.ethAmount;
  if (rec.pre === undefined) rec.pre = [];
  const s = rec.summary;
  if (s?.cost && s.cost.total === undefined && s.cost.totalEth !== undefined) s.cost = { launchFee: s.cost.launchFeeEth, devBuy: s.cost.devBuyEth, total: s.cost.totalEth, unit: 'ETH', plusGas: s.cost.plusGas };
  if (s?.devBuy && s.devBuy.amount === undefined && s.devBuy.eth !== undefined) s.devBuy = { ...s.devBuy, amount: s.devBuy.eth, unit: 'ETH' };
  if (s?.spend && s.spend.amount === undefined && s.spend.eth !== undefined) s.spend = { ...s.spend, amount: s.spend.eth, unit: 'ETH' };
  if (s && s.unit === undefined) s.unit = 'ETH';
  if (rec.funding && rec.funding.balance === undefined && rec.funding.balanceEth !== undefined) rec.funding = { ...rec.funding, balance: rec.funding.balanceEth, required: rec.funding.requiredEth, unit: 'ETH' };
  return rec;
}

export function publicRecord(rec) {
  upgrade(rec);
  const { salt, ...rest } = rec; // o salt nao e segredo, mas tambem nao e util fora daqui
  return {
    ...rest,
    url: `${PUBLIC_URL}/l/${rec.id}`,
    links: links({ token: rec.token || rec.predicted?.token, curve: rec.curve || rec.predicted?.curve, txHash: rec.launchTxHash || rec.txHash }),
    explorer: CHAIN.explorer,
    unit,
  };
}
