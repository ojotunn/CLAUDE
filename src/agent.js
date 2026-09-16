// O agente do token. Uma carteira propria recebe as taxas de criador e age
// sozinha em ciclos: coleta, aluguel, salario do dono, recompra e queima,
// airdrop (com ou sem fidelidade), sorteio, compra na queda, reserva. Fala
// quando age e quando algo acontece no mercado (compra grande, marco,
// graduacao). Sem aprovacao por acao e sem teto por operacao (regra da casa).
// As unicas travas sao de construcao: esta carteira so fala com o protocolo do
// venue, com o endereco de queima, com holders (token), com o dono e com a
// tesouraria.
//
// Dois jeitos de nascer, conforme o venue:
//  - pons: o token ja existe; o criador assina UMA vez e passa as taxas ao agente.
//  - Argus: nao da para trocar o criador, entao o agente LANCA o token com a
//    carteira dele; o dono manda o dinheiro do lancamento para essa carteira.
import fs from 'node:fs';
import path from 'node:path';
import { CHAIN, PUBLIC_URL, DATA_DIR, VENUE, APP_NAME } from './config.js';
import { Store } from './store.js';
import * as chain from './chain.js';
import { seal, open, agentsEnabled, issueSession } from './crypto.js';
import { speak, react, answer, voiceEnabled } from './voice.js';
import { postTweet, validCreds, postTelegram, validTelegram } from './x.js';
import { UserError, links, hooks, launches } from './launches.js';

const { parseAmount, formatAmount, formatUnits, getAddress } = chain;
const unit = chain.quoteSymbol;

export const agents = new Store('agents');
hooks.agentInfo = (token) => {
  const r = agents.get(String(token).toLowerCase());
  return r ? { vibe: r.vibe, avatar: r.avatar || null, rules: r.rules, split: splitText(r.rules) } : null;
};

// ---------------------------------------------------------------------------
// Constantes e regras. Os valores em moeda vem do venue (ETH na pons, USDC na Argus).
const D = chain.AGENT_DEFAULTS;
const envAmt = (names, dflt) => { for (const n of names) if (process.env[n]) return process.env[n]; return dflt; };
const RENT_BPS = Number(process.env.AGENT_RENT_BPS || 1000);
const TREASURY = process.env.TREASURY_ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(process.env.TREASURY_ADDRESS) ? getAddress(process.env.TREASURY_ADDRESS) : null;
const RESERVE = parseAmount(envAmt(['AGENT_RESERVE', 'AGENT_RESERVE_ETH'], D.reserve));
const MIN_ACTION = parseAmount(envAmt(['AGENT_MIN_ACTION', 'AGENT_MIN_ACTION_ETH'], D.minAction));
export const MIN_GAS = parseAmount(envAmt(['AGENT_MIN_GAS', 'AGENT_MIN_GAS_ETH'], D.minGas));   // abaixo disto nao consegue nem sacar
export const KICKSTART = envAmt(['AGENT_KICKSTART', 'AGENT_KICKSTART_ETH'], D.kickstart);        // gas inicial sugerido
const MAX_AIRDROP = 20;
export const INTERVAL_MS = Number(process.env.AGENT_INTERVAL_MIN || 5) * 60_000;

export const PRESETS = {
  balanced: { buybackBps: 5000, airdropBps: 2500, salaryBps: 0, raffleBps: 0 },
  burner: { buybackBps: 8000, airdropBps: 1000, salaryBps: 0, raffleBps: 0 },
  generous: { buybackBps: 2000, airdropBps: 5000, salaryBps: 0, raffleBps: 1000 },
  saver: { buybackBps: 2000, airdropBps: 1000, salaryBps: 0, raffleBps: 0 },
  creator: { buybackBps: 4000, airdropBps: 2000, salaryBps: 2000, raffleBps: 0 },
};
export const RULES = {
  rentBps: RENT_BPS, ...PRESETS.balanced,
  loyaltyOnly: false, dipBuyPct: 0, milestones: true, collectOnly: false,
  quietHours: null, minPostMin: 0, whaleEth: D.whale,
};

const pctToBps = (v, label) => {
  if (v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new UserError(`${label} must be a percentage between 0 and 100`, 'INVALID_INPUT');
  return Math.round(n * 100);
};
const parseQuiet = (q) => {
  if (q == null || q === '' || q === false) return null;
  const m = String(q).match(/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/);
  if (!m) throw new UserError('quietHours must look like "22-8" (UTC hours)', 'INVALID_INPUT');
  const from = Number(m[1]), to = Number(m[2]);
  if (from > 23 || to > 23) throw new UserError('quietHours must use hours 0-23', 'INVALID_INPUT');
  return { from, to };
};

export function normalizeRules(input = {}, base = RULES) {
  let r = { ...RULES, ...base };
  if (input.preset != null) {
    const p = PRESETS[String(input.preset).toLowerCase()];
    if (!p) throw new UserError(`unknown preset; use one of ${Object.keys(PRESETS).join(', ')}`, 'INVALID_INPUT');
    r = { ...r, ...p };
  }
  const b = pctToBps(input.buybackPct, 'buybackPct'); if (b != null) r.buybackBps = b;
  const a = pctToBps(input.airdropPct, 'airdropPct'); if (a != null) r.airdropBps = a;
  const s = pctToBps(input.salaryPct, 'salaryPct'); if (s != null) r.salaryBps = s;
  const f = pctToBps(input.rafflePct, 'rafflePct'); if (f != null) r.raffleBps = f;
  if (input.loyaltyOnly != null) r.loyaltyOnly = !!input.loyaltyOnly;
  if (input.milestones != null) r.milestones = !!input.milestones;
  if (input.collectOnly != null) r.collectOnly = !!input.collectOnly;
  if (input.dipBuyPct != null) {
    const d = Number(input.dipBuyPct);
    if (!Number.isFinite(d) || d < 0 || d > 90) throw new UserError('dipBuyPct must be between 0 (off) and 90', 'INVALID_INPUT');
    r.dipBuyPct = d;
  }
  if (input.minPostMin != null) {
    const m = Number(input.minPostMin);
    if (!Number.isFinite(m) || m < 0 || m > 1440) throw new UserError('minPostMin must be between 0 and 1440', 'INVALID_INPUT');
    r.minPostMin = m;
  }
  if (input.quietHours !== undefined) r.quietHours = parseQuiet(input.quietHours);
  const whale = input.whaleAmount ?? input.whaleEth;
  if (whale != null) {
    const w = String(whale);
    if (!/^\d+(\.\d{1,18})?$/.test(w)) throw new UserError(`whaleAmount must be a decimal ${unit} amount`, 'INVALID_INPUT');
    r.whaleEth = w;
  }
  r.rentBps = RENT_BPS;
  const total = r.buybackBps + r.airdropBps + r.salaryBps + r.raffleBps + r.rentBps;
  if (total > 10_000) throw new UserError(`buy back + airdrop + salary + raffle can be at most ${(10_000 - r.rentBps) / 100}% (the rest covers rent and gas reserve)`, 'INVALID_INPUT');
  r.treasury = !!TREASURY;
  return r;
}

export function allocate(budget, rules = RULES) {
  const cut = (b) => (budget * BigInt(b || 0)) / 10_000n;
  const rent = TREASURY ? cut(rules.rentBps ?? RENT_BPS) : 0n;
  const salary = cut(rules.salaryBps), buyback = cut(rules.buybackBps), airdrop = cut(rules.airdropBps), raffle = cut(rules.raffleBps);
  return { rent, salary, buyback, airdrop, raffle, reserve: budget - rent - salary - buyback - airdrop - raffle };
}

export const splitText = (r) => [
  `${r.buybackBps / 100}% buy back & burn`, `${r.airdropBps / 100}% airdrop${r.loyaltyOnly ? ' (holders who never sold)' : ''}`,
  r.salaryBps ? `${r.salaryBps / 100}% creator salary` : null, r.raffleBps ? `${r.raffleBps / 100}% raffle` : null,
  r.treasury ? `${r.rentBps / 100}% rent` : null, 'the rest stays as gas reserve',
].filter(Boolean).join(', ');

export const requireEnabled = () => {
  if (!agentsEnabled()) throw new UserError('agents are not enabled on this server (AGENT_SECRET missing)', 'AGENTS_DISABLED');
};

const id = (token) => String(token).toLowerCase();
const tokens = (wei) => Number(formatUnits(wei, 18));
const addAmt = (a, b) => formatAmount(parseAmount(a || '0') + b);
const addNum = (a, b) => (Number(a || 0) + Number(b)).toString();
const now = () => new Date().toISOString();
const cleanAvatar = (u) => {
  const s = String(u || '').trim();
  if (!s) return null;
  if (!/^https:\/\/[^\s"'<>]{1,300}$/i.test(s)) throw new UserError('avatar must be an https image URL', 'INVALID_INPUT');
  return s;
};

function newRecord({ token, name, symbol, curve, creator, agent, key, vibe, avatar, rules, status, extra = {} }) {
  return {
    id: id(token), token, name, symbol, curve,
    creator, agent, key,
    status, vibe: String(vibe || '').slice(0, 200), avatar: cleanAvatar(avatar),
    rules, pendingRules: null, x: null, tg: null,
    stats: { collectedEth: '0', buybackEth: '0', burnedTokens: '0', airdropEth: '0', airdroppedTokens: '0', raffleEth: '0', raffleTokens: '0', salaryEth: '0', rentEth: '0', dipBuyEth: '0', forwardedEth: '0', cycles: 0, posts: 0, questions: 0 },
    milestones: [], lastPriceEth: null, lastScanBlock: null, biggestBuyEth: '0', graduatedNoted: false, lastPostAt: null,
    log: [], qa: [], createdAt: now(), activatedAt: null, lastTickAt: null, handoverId: null, handoverUrl: null,
    venue: VENUE, unit, ...extra,
  };
}

// ---------------------------------------------------------------------------
// Criacao (pons): carteira nova + pedido de handover para o recebedor atual assinar.
export async function attach({ token, vibe, avatar, ...ruleInput }, prepareHandover) {
  requireEnabled();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token || '')) throw new UserError('token must be a 0x address', 'INVALID_INPUT');
  if (chain.agentMustLaunch) throw new UserError(`on ${chain.NAME} the creator of a token cannot be changed, so an agent has to launch its own token: call prepare_launch with withAgent: true (the agent gets a wallet, you fund it, it launches and keeps the creator share of the tax)`, 'NO_HANDOVER');
  const info = await chain.tokenInfo(token);
  if (!info) throw new UserError(`this address is not a ${chain.NAME} launch on this network`, 'NOT_VENUE_TOKEN');
  const existing = agents.get(id(token));
  if (existing && existing.status === 'active') return { agent: publicView(existing), url: null, already: true };
  if (existing && existing.status === 'pending_handover') {
    const h = launches.get(existing.handoverId);
    if (h && Date.parse(h.expiresAt) > Date.now()) return { agent: publicView(existing), url: existing.handoverUrl, already: true };
  }
  const { pk, address } = chain.newAgentKey();
  const rec = newRecord({ token: info.token, name: info.name, symbol: info.symbol, curve: info.curve, creator: info.creatorFeeRecipient, agent: address, key: seal(pk), vibe, avatar, rules: normalizeRules(ruleInput), status: 'pending_handover' });
  const handover = await prepareHandover({ token: info.token, name: info.name, symbol: info.symbol, agent: address, currentRecipient: info.creatorFeeRecipient });
  rec.handoverId = handover.id;
  rec.handoverUrl = handover.url;
  agents.put(rec);
  return { agent: publicView(rec), url: handover.url, already: false };
}

export async function activate(token, agentAddress) {
  const rec = agents.get(id(token));
  if (!rec || rec.agent.toLowerCase() !== String(agentAddress).toLowerCase()) return;
  const recipient = await chain.feeRecipient(rec.token);
  if (!recipient || recipient.toLowerCase() !== rec.agent.toLowerCase()) {
    console.error(`[agent] ${rec.symbol}: handover confirmed but recipient is ${recipient}`);
    return;
  }
  rec.status = 'active';
  rec.activatedAt = now();
  rec.log.unshift({ at: now(), kind: 'born', text: `Fees handed over. ${rec.symbol} now runs its own wallet.`, actions: [], txs: [] });
  agents.put(rec);
  console.log(`[agent] ${rec.symbol} active at ${rec.agent}`);
}

// ---------------------------------------------------------------------------
// Criacao (Argus): o agente nasce junto com o pedido de lancamento. O token e
// previsto a partir da carteira dele, entao o registro ja pode ter o endereco.
hooks.createAgentForLaunch = async ({ rec, agent, terms }) => {
  if (!agentsEnabled()) return null;
  const { pk, address } = chain.newAgentKey();
  const q = await chain.quoteLaunch({ input: rec.input, devBuy: parseAmount(rec.devBuy), salt: rec.salt, from: address, terms, exact: false });
  const a = newRecord({
    token: q.predicted.token, name: rec.input.name, symbol: rec.input.symbol, curve: q.predicted.curve,
    creator: null, agent: address, key: seal(pk), vibe: agent.vibe, avatar: agent.avatar, rules: normalizeRules(agent.rules || {}),
    status: 'pending_funding', extra: { launchId: rec.id, hook: q.predicted.hook, tokenIsCurrency0: q.predicted.tokenIsCurrency0 },
  });
  agents.put(a);
  return { address, page: `${PUBLIC_URL}/t/${a.token}`, predictedToken: a.token };
};

// Quanto o dono manda para a carteira do agente: dev buy + gas do lancamento e
// dos primeiros ciclos (o "kickstart").
hooks.agentLaunchBudget = (q) => q.devBuy + parseAmount(KICKSTART);

// O dinheiro chegou: o agente lanca de verdade.
hooks.agentLaunch = async (launchRec) => {
  const rec = agents.get(id(launchRec.agent.predictedToken));
  if (!rec) return { ok: false, error: 'agent record not found' };
  if (rec.status === 'active' && rec.token) return { ok: true, token: rec.token, curve: rec.curve, tokensOut: 0n, hash: rec.launchTxHash };
  const pk = open(rec.key);
  const terms = await chain.protocolTerms({ fresh: true });
  const quote = await chain.quoteLaunch({ input: launchRec.input, devBuy: parseAmount(launchRec.devBuy), salt: launchRec.salt, from: rec.agent, terms, exact: true });
  if (quote.predicted.token.toLowerCase() !== rec.token) return { ok: false, error: `predicted token changed (${quote.predicted.token}); the launch was not sent` };
  const out = await chain.agentLaunch(pk, { rec, quote });
  rec.log.unshift({ at: now(), kind: 'launch', text: out.ok ? `I launched ${rec.symbol} from my own wallet. I am its creator on ${chain.NAME}.` : `My launch attempt failed: ${out.error}`, actions: [], txs: out.txs || [] });
  if (!out.ok) { agents.put(rec); return out; }
  rec.status = 'active';
  rec.creator = launchRec.wallet;   // o dono: quem financiou e quem manda
  rec.token = out.token; rec.id = id(out.token); rec.curve = out.curve || rec.curve;
  rec.launchTxHash = out.hash;
  rec.activatedAt = now();
  try { const info = await chain.tokenInfo(rec.token); if (info) { rec.poolId = info.poolId || null; rec.hook = info.hook || rec.hook; rec.locker = info.locker || null; } } catch { /* opcional */ }
  agents.put(rec);
  console.log(`[agent] ${rec.symbol} launched by its agent ${rec.agent}: ${rec.token}`);
  return out;
};

// ---------------------------------------------------------------------------
// Publicacao: pagina sempre; X e Telegram se conectados; respeita silencio e
// intervalo minimo entre posts.
function canPostNow(rec) {
  const r = rec.rules;
  if (r.quietHours) {
    const h = new Date().getUTCHours();
    const { from, to } = r.quietHours;
    const quiet = from <= to ? (h >= from && h < to) : (h >= from || h < to);
    if (quiet) return false;
  }
  if (r.minPostMin && rec.lastPostAt && Date.now() - Date.parse(rec.lastPostAt) < r.minPostMin * 60_000) return false;
  return true;
}

async function publish(rec, text, generated) {
  const post = { text, generated, tweetId: null, tweetError: null, tgOk: false, tgError: null };
  if (rec.x) { try { const t = await postTweet(JSON.parse(open(rec.x)), text); post.tweetId = t.id; } catch (e) { post.tweetError = String(e.message).slice(0, 160); } }
  if (rec.tg) { try { await postTelegram(JSON.parse(open(rec.tg)), text); post.tgOk = true; } catch (e) { post.tgError = String(e.message).slice(0, 160); } }
  rec.stats.posts++;
  rec.lastPostAt = now();
  return post;
}

// ---------------------------------------------------------------------------
// O ciclo.
const running = new Set();
export async function tick(rec) {
  if (!['active', 'released'].includes(rec.status) || running.has(rec.id)) return;
  if (rec.status === 'released' && !rec.forwarding) return;
  upgrade(rec);
  running.add(rec.id);
  const pk = open(rec.key);
  const actions = [], txs = [], errors = [], events = [];
  const tx = async (label, fn) => {
    try { const r = await fn(); txs.push({ label, hash: r.hash, ok: r.ok }); if (!r.ok) errors.push(`${label} reverted`); return r; } catch (e) { errors.push(`${label}: ${String(e.shortMessage || e.message).split('\n')[0].slice(0, 120)}`); return null; }
  };
  const buy = (label, value) => chain.buyTokens(pk, rec, value, { tx: (l, fn) => tx(l === 'buy' ? label : `${label} ${l}`, fn) });
  const burn = async (got) => {
    const b = await tx('burn', () => chain.agentTransferTokens(pk, rec.token, chain.burnAddress, got));
    if (b?.ok) { actions.push({ kind: 'burn', tokens: tokens(got) }); rec.stats.burnedTokens = addNum(rec.stats.burnedTokens, tokens(got)); }
  };
  try {
    // Sem gas nao ha o que fazer: a primeira coleta e uma transacao. Avisa
    // (uma vez por hora) e espera alguem mandar o gas inicial.
    const gasBal = await chain.agentBalance(rec.agent);
    if (gasBal < MIN_GAS) {
      const last = rec.log.find((l) => l.kind === 'needs_gas');
      if (!last || Date.now() - Date.parse(last.at) > 3600_000) {
        rec.log.unshift({ at: now(), kind: 'needs_gas', text: `I have ${formatAmount(gasBal)} ${unit} and need about ${formatAmount(MIN_GAS)} ${unit} of gas to collect my fees. Anyone can send it to ${rec.agent}.`, actions: [], txs: [] });
        rec.log = rec.log.slice(0, 200);
      }
      rec.lastTickAt = now();
      agents.put(rec);
      return;
    }
    const flags = await chain.marketFlags(rec);
    const info = await chain.tokenInfo(rec.token).catch(() => null);

    // 0) eventos no mercado desde o ultimo ciclo
    const latest = await chain.blockNumber();
    const from = rec.lastScanBlock ? BigInt(rec.lastScanBlock) + 1n : latest - 200n;
    const buys = await chain.buysBetween(rec, from < 0n ? 0n : from, latest);
    const whale = parseAmount(rec.rules.whaleEth || D.whale);
    for (const b of buys) {
      if (b.quoteIn >= whale && b.recipient.toLowerCase() !== rec.agent.toLowerCase()) events.push({ kind: 'whale', eth: formatAmount(b.quoteIn), amount: formatAmount(b.quoteIn), unit, who: b.recipient });
      if (b.quoteIn > parseAmount(rec.biggestBuyEth || '0')) rec.biggestBuyEth = formatAmount(b.quoteIn);
    }
    rec.lastScanBlock = latest.toString();
    if (info && rec.rules.milestones) {
      for (const m of [25, 50, 75, 100]) {
        if (info.graduationProgress >= m && !rec.milestones.includes(m)) { rec.milestones.push(m); events.push({ kind: 'milestone', pct: m, label: info.graduationLabel }); }
      }
    }
    if ((flags.graduated || flags.bonded) && !rec.graduatedNoted) { rec.graduatedNoted = true; events.push({ kind: 'graduated', label: info?.graduationLabel }); }

    // 1) coleta: o que o protocolo deve ao agente
    const collected = await chain.collectFees(pk, rec, { tx });
    if (collected > 0n) { actions.push({ kind: 'collect', eth: formatAmount(collected), amount: formatAmount(collected), unit }); rec.stats.collectedEth = addAmt(rec.stats.collectedEth, collected); }

    // Modo "released" (Argus): o agente nao consegue devolver o papel de
    // criador, entao repassa tudo o que coletar ao dono, para sempre.
    if (rec.status === 'released') {
      const bal = await chain.agentBalance(rec.agent);
      const keep = MIN_GAS;
      if (bal > keep + MIN_ACTION) {
        const r = await tx('forward', () => chain.agentSendNative(pk, rec.creator, bal - keep));
        if (r?.ok) { actions.push({ kind: 'forward', eth: formatAmount(bal - keep), amount: formatAmount(bal - keep), unit }); rec.stats.forwardedEth = addAmt(rec.stats.forwardedEth, bal - keep); }
      }
      if (actions.length || errors.length) rec.log.unshift({ at: now(), kind: 'cycle', actions, txs, errors, post: null });
      rec.log = rec.log.slice(0, 200);
      rec.lastTickAt = now();
      agents.put(rec);
      return;
    }

    // 2) compra na queda: usa a reserva se o preco caiu mais que X% desde o ultimo ciclo
    if (info && rec.rules.dipBuyPct > 0 && rec.lastPriceEth && flags.canBuy) {
      const drop = (1 - info.price / Number(rec.lastPriceEth)) * 100;
      if (drop >= rec.rules.dipBuyPct) {
        const bal = await chain.agentBalance(rec.agent);
        const spend = bal > RESERVE + MIN_ACTION ? bal - RESERVE : 0n;
        if (spend > 0n) {
          const got = await buy('dip-buy', spend);
          if (got > 0n) {
            rec.stats.dipBuyEth = addAmt(rec.stats.dipBuyEth, spend);
            actions.push({ kind: 'dipbuy', eth: formatAmount(spend), amount: formatAmount(spend), unit, tokens: tokens(got), dropPct: Math.round(drop) });
            await burn(got);
          }
        }
      }
    }
    if (info) rec.lastPriceEth = String(info.price);

    // 3) orcamento: tudo acima da reserva
    const balance = await chain.agentBalance(rec.agent);
    const budget = balance > RESERVE ? balance - RESERVE : 0n;
    if (budget >= MIN_ACTION && !rec.rules.collectOnly) {
      const a = allocate(budget, rec.rules);
      if (a.rent > 0n && TREASURY) {
        const r = await tx('rent', () => chain.agentSendNative(pk, TREASURY, a.rent));
        if (r?.ok) { actions.push({ kind: 'rent', eth: formatAmount(a.rent), amount: formatAmount(a.rent), unit }); rec.stats.rentEth = addAmt(rec.stats.rentEth, a.rent); }
      }
      if (a.salary > 0n) {
        const r = await tx('salary', () => chain.agentSendNative(pk, rec.creator, a.salary));
        if (r?.ok) { actions.push({ kind: 'salary', eth: formatAmount(a.salary), amount: formatAmount(a.salary), unit }); rec.stats.salaryEth = addAmt(rec.stats.salaryEth, a.salary); }
      }
      if (!flags.canBuy) {
        actions.push({ kind: 'hold', eth: formatAmount(a.buyback + a.airdrop + a.raffle), amount: formatAmount(a.buyback + a.airdrop + a.raffle), unit, reason: 'the token left the market I can buy on; holding' });
      } else {
        // recompra e queima
        if (a.buyback > 0n) {
          const got = await buy('buyback', a.buyback);
          if (got > 0n) {
            rec.stats.buybackEth = addAmt(rec.stats.buybackEth, a.buyback);
            actions.push({ kind: 'buyback', eth: formatAmount(a.buyback), amount: formatAmount(a.buyback), unit, tokens: tokens(got) });
            await burn(got);
          }
        }
        // airdrop para compradores recentes (opcional: so quem nunca vendeu)
        const exclude = [rec.agent, rec.curve, chain.burnAddress];
        let buyers = (a.airdrop > 0n || a.raffle > 0n) ? await chain.recentBuyers(rec, { max: MAX_AIRDROP, exclude }) : [];
        if (buyers.length && rec.rules.loyaltyOnly) {
          const sellers = await chain.sellersSince(rec, 20_000n);
          buyers = buyers.filter((b) => !sellers.has(b.address.toLowerCase()));
        }
        if (a.airdrop > 0n) {
          if (buyers.length) {
            const got = await buy('airdrop-buy', a.airdrop);
            if (got > 0n) {
              const total = buyers.reduce((s, b) => s + b.bought, 0n);
              let sent = 0n, count = 0;
              for (const b of buyers) {
                const share = total > 0n ? (got * b.bought) / total : got / BigInt(buyers.length);
                if (share <= 0n) continue;
                const t = await tx(`airdrop ${b.address.slice(0, 8)}`, () => chain.agentTransferTokens(pk, rec.token, b.address, share));
                if (t?.ok) { sent += share; count++; }
              }
              rec.stats.airdropEth = addAmt(rec.stats.airdropEth, a.airdrop);
              rec.stats.airdroppedTokens = addNum(rec.stats.airdroppedTokens, tokens(sent));
              actions.push({ kind: 'airdrop', eth: formatAmount(a.airdrop), amount: formatAmount(a.airdrop), unit, tokens: tokens(sent), recipients: count, loyal: rec.rules.loyaltyOnly });
            }
          } else {
            actions.push({ kind: 'hold', eth: formatAmount(a.airdrop), amount: formatAmount(a.airdrop), unit, reason: rec.rules.loyaltyOnly ? 'no recent buyer kept every token yet' : 'no recent buyers to drop on yet' });
          }
        }
        // sorteio: um comprador recente leva tudo, escolhido pelo hash do bloco
        if (a.raffle > 0n) {
          if (buyers.length) {
            const got = await buy('raffle-buy', a.raffle);
            if (got > 0n) {
              const hash = await chain.blockHash(latest);
              const idx = Number(BigInt(hash) % BigInt(buyers.length));
              const winner = buyers[idx].address;
              const t = await tx('raffle prize', () => chain.agentTransferTokens(pk, rec.token, winner, got));
              if (t?.ok) {
                rec.stats.raffleEth = addAmt(rec.stats.raffleEth, a.raffle);
                rec.stats.raffleTokens = addNum(rec.stats.raffleTokens, tokens(got));
                actions.push({ kind: 'raffle', eth: formatAmount(a.raffle), amount: formatAmount(a.raffle), unit, tokens: tokens(got), winner, entrants: buyers.length, block: latest.toString() });
              }
            }
          } else {
            actions.push({ kind: 'hold', eth: formatAmount(a.raffle), amount: formatAmount(a.raffle), unit, reason: 'no recent buyers for a raffle yet' });
          }
        }
      }
    } else if (budget >= MIN_ACTION && rec.rules.collectOnly) {
      actions.push({ kind: 'hold', eth: formatAmount(budget), amount: formatAmount(budget), unit, reason: 'collect-only mode' });
    }

    // 4) fala: acoes que valem contar, e eventos
    const worth = actions.some((x) => ['collect', 'buyback', 'burn', 'airdrop', 'raffle', 'salary', 'dipbuy'].includes(x.kind));
    const market = info ? { price: info.price, priceUnit: VENUE === 'argus' ? 'USD' : unit, marketCap: info.marketCap, raised: info.raised, graduationProgress: info.graduationProgress, graduationLabel: info.graduationLabel } : null;
    let post = null;
    if (worth && canPostNow(rec)) {
      const v = await speak({ name: rec.name, symbol: rec.symbol, vibe: rec.vibe, actions, stats: rec.stats, curve: market });
      post = await publish(rec, v.text, v.generated);
    }
    for (const ev of events) {
      if (!canPostNow(rec)) break;
      const v = await react({ name: rec.name, symbol: rec.symbol, vibe: rec.vibe, event: ev, curve: market });
      const p = await publish(rec, v.text, v.generated);
      rec.log.unshift({ at: now(), kind: 'event', event: ev, post: p, actions: [], txs: [] });
    }
    if (actions.length || errors.length) rec.log.unshift({ at: now(), kind: 'cycle', actions, txs, errors, post });
    rec.log = rec.log.slice(0, 200);
    rec.stats.cycles++;
    rec.lastTickAt = now();
    agents.put(rec);
  } catch (e) {
    console.error(`[agent] ${rec.symbol} tick failed:`, e?.shortMessage || e?.message || e);
    rec.log.unshift({ at: now(), kind: 'error', text: String(e?.shortMessage || e?.message || e).slice(0, 200), actions: [], txs: [] });
    rec.log = rec.log.slice(0, 200);
    agents.put(rec);
  } finally {
    running.delete(rec.id);
  }
}

let timer = null;
export function startLoop() {
  if (!agentsEnabled() || timer) return;
  const run = async () => { for (const rec of agents.list((r) => r.status === 'active' || (r.status === 'released' && r.forwarding))) await tick(rec); };
  timer = setInterval(() => run().catch((e) => console.error('[agent loop]', e)), INTERVAL_MS);
  timer.unref();
  setTimeout(() => run().catch(() => {}), 15_000).unref();
  console.log(`  agents       : enabled, cycle every ${INTERVAL_MS / 60_000} min, voice ${voiceEnabled() ? 'on' : 'template only'}, treasury ${TREASURY || 'none (rent stays in reserve)'}`);
}

// ---------------------------------------------------------------------------
// Sessao do dono (assinatura de mensagem na pagina) e configuracoes.
export function loginMessage({ token, wallet, issuedAt }) {
  return `${APP_NAME}: manage the agent of ${token} as ${wallet} at ${issuedAt}`;
}

export async function login({ token, wallet, issuedAt, signature }) {
  const rec = agents.get(id(token));
  if (!rec) throw new UserError('no agent for this token', 'NOT_FOUND');
  if (!rec.creator) throw new UserError('this agent has no owner yet (the launch was not funded)', 'BAD_STATE');
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet || '')) throw new UserError('invalid wallet', 'INVALID_INPUT');
  if (getAddress(wallet) !== getAddress(rec.creator)) throw new UserError(`only the creator wallet ${rec.creator} can manage this agent`, 'FORBIDDEN');
  const age = Date.now() - Date.parse(issuedAt || '');
  if (!(age >= -60_000 && age < 10 * 60_000)) throw new UserError('login message expired; try again', 'EXPIRED');
  const ok = await chain.verifySignedMessage({ address: getAddress(wallet), message: loginMessage({ token: rec.token, wallet, issuedAt }), signature });
  if (!ok) throw new UserError('signature does not match the wallet', 'FORBIDDEN');
  return { session: issueSession({ wallet, token: rec.token }) };
}

// Registros criados antes de um campo existir ganham o campo aqui, na leitura.
export function upgrade(rec) {
  if (!rec) return rec;
  rec.log ||= []; rec.qa ||= []; rec.milestones ||= [];
  rec.stats ||= {};
  for (const k of ['collectedEth', 'buybackEth', 'airdropEth', 'raffleEth', 'salaryEth', 'rentEth', 'dipBuyEth', 'forwardedEth']) rec.stats[k] ||= '0';
  for (const k of ['burnedTokens', 'airdroppedTokens', 'raffleTokens']) rec.stats[k] ||= '0';
  for (const k of ['cycles', 'posts', 'questions']) rec.stats[k] ||= 0;
  rec.rules = normalizeRules({}, rec.rules || {});
  if (rec.pendingRules === undefined) rec.pendingRules = null;
  if (rec.tg === undefined) rec.tg = null;
  if (rec.lastPriceEth === undefined) rec.lastPriceEth = null;
  if (rec.lastScanBlock === undefined) rec.lastScanBlock = null;
  rec.biggestBuyEth ||= '0';
  if (rec.graduatedNoted === undefined) rec.graduatedNoted = false;
  if (rec.lastPostAt === undefined) rec.lastPostAt = null;
  if (rec.venue === undefined) rec.venue = VENUE;
  if (rec.unit === undefined) rec.unit = unit;
  if (rec.forwarding === undefined) rec.forwarding = false;
  return rec;
}

const need = (token) => { const rec = agents.get(id(token)); if (!rec) throw new UserError('no agent for this token', 'NOT_FOUND'); return upgrade(rec); };

export function setX(token, creds) {
  const rec = need(token);
  if (creds === null) { rec.x = null; agents.put(rec); return publicView(rec); }
  const c = { apiKey: String(creds.apiKey || '').trim(), apiSecret: String(creds.apiSecret || '').trim(), accessToken: String(creds.accessToken || '').trim(), accessSecret: String(creds.accessSecret || '').trim() };
  if (!validCreds(c)) throw new UserError('all four X credentials are required', 'INVALID_INPUT');
  rec.x = seal(JSON.stringify(c)); agents.put(rec); return publicView(rec);
}
export async function testX(token) {
  const rec = need(token);
  if (!rec.x) throw new UserError('X is not connected for this agent', 'NOT_FOUND');
  const t = await postTweet(JSON.parse(open(rec.x)), `$${rec.symbol} here. My agent just connected to X. More soon.`);
  return { tweetId: t.id };
}

export function setTelegram(token, creds) {
  const rec = need(token);
  if (creds === null) { rec.tg = null; agents.put(rec); return publicView(rec); }
  const c = { botToken: String(creds.botToken || '').trim(), chatId: String(creds.chatId || '').trim() };
  if (!validTelegram(c)) throw new UserError('bot token and chat id are required', 'INVALID_INPUT');
  rec.tg = seal(JSON.stringify(c)); agents.put(rec); return publicView(rec);
}
export async function testTelegram(token) {
  const rec = need(token);
  if (!rec.tg) throw new UserError('Telegram is not connected for this agent', 'NOT_FOUND');
  await postTelegram(JSON.parse(open(rec.tg)), `$${rec.symbol} here. My agent just connected to Telegram.`);
  return { ok: true };
}

export function proposeRules(token, input) {
  const rec = need(token);
  if (rec.status === 'released') throw new UserError('this agent was released', 'BAD_STATE');
  const rules = normalizeRules(input, rec.rules);
  if (rec.status === 'pending_handover' || rec.status === 'pending_funding') { rec.rules = rules; rec.pendingRules = null; agents.put(rec); return { applied: true, rules, view: publicView(rec) }; }
  rec.pendingRules = { ...rules, proposedAt: now() }; agents.put(rec);
  return { applied: false, rules, view: publicView(rec) };
}
export function setRules(token, input) {
  const rec = need(token);
  rec.rules = normalizeRules(input, rec.rules); rec.pendingRules = null; agents.put(rec); return publicView(rec);
}
export function applyPendingRules(token) {
  const rec = need(token);
  if (!rec.pendingRules) throw new UserError('nothing proposed', 'BAD_STATE');
  const { proposedAt, ...rules } = rec.pendingRules;
  rec.rules = rules; rec.pendingRules = null; agents.put(rec); return publicView(rec);
}
export function setVibe(token, vibe) {
  const rec = need(token);
  rec.vibe = String(vibe || '').slice(0, 200); agents.put(rec); return publicView(rec);
}

const MAGIC = [
  { ext: 'png', head: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg', head: [0xff, 0xd8, 0xff] },
  { ext: 'gif', head: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'webp', head: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x45, 0x42, 0x50] },
];
export function setAvatar(token, { url = null, bytes = null } = {}) {
  const rec = need(token);
  if (bytes) {
    if (bytes.length > 400 * 1024) throw new UserError('image must be under 400 KB', 'TOO_LARGE');
    const kind = MAGIC.find((m) => m.head.every((b, i) => bytes[i] === b) && (!m.at8 || m.at8.every((b, i) => bytes[8 + i] === b)));
    if (!kind) throw new UserError('image must be PNG, JPG, GIF or WebP', 'INVALID_INPUT');
    const dir = path.join(DATA_DIR, 'avatars');
    fs.mkdirSync(dir, { recursive: true });
    for (const m of MAGIC) { try { fs.unlinkSync(path.join(dir, `${rec.id}.${m.ext}`)); } catch { /* nao existia */ } }
    fs.writeFileSync(path.join(dir, `${rec.id}.${kind.ext}`), bytes);
    rec.avatar = `/avatars/${rec.id}.${kind.ext}?v=${Date.now()}`;
  } else {
    rec.avatar = cleanAvatar(url);
  }
  agents.put(rec); return publicView(rec);
}

// "Pergunte ao agente": qualquer visitante; o token responde no personagem.
// Custa uma chamada de modelo, entao so com voz ligada, limitado por IP na rota.
export async function ask(token, question) {
  const rec = need(token);
  if (!voiceEnabled()) throw new UserError('this agent has no voice yet', 'NO_VOICE');
  const q = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 240);
  if (q.length < 3) throw new UserError('ask something', 'INVALID_INPUT');
  const info = rec.token ? await chain.tokenInfo(rec.token).catch(() => null) : null;
  const a = await answer({ name: rec.name, symbol: rec.symbol, vibe: rec.vibe, stats: rec.stats, question: q,
    curve: info ? { price: info.price, marketCap: info.marketCap, raised: info.raised, graduationProgress: info.graduationProgress, graduationLabel: info.graduationLabel } : null });
  const entry = { at: now(), q, a: a.text };
  rec.qa.unshift(entry); rec.qa = rec.qa.slice(0, 30); rec.stats.questions++;
  agents.put(rec);
  return entry;
}

// Saida: devolve o que der ao dono. Na pons devolve tambem o papel de
// recebedor; na Argus o papel e permanente, entao o agente fica repassando.
export async function release(token) {
  const rec = need(token);
  if (rec.status !== 'active') throw new UserError(`agent is ${rec.status}; nothing to release`, 'BAD_STATE');
  const pk = open(rec.key);
  const txs = [];
  const back = await chain.releaseToOwner(pk, rec);
  txs.push(...(back.txs || []));
  if (!back.ok) throw new UserError('handing the fee recipient back reverted', 'REVERT');
  const bal = await chain.agentBalance(rec.agent);
  const gas = MIN_GAS;
  if (bal > gas) { const r = await chain.agentSendNative(pk, rec.creator, bal - gas); txs.push({ label: 'refund', hash: r.hash, ok: r.ok }); }
  const held = await chain.tokenBalance(rec.token, rec.agent);
  if (held > 0n) { const r = await chain.agentTransferTokens(pk, rec.token, rec.creator, held); txs.push({ label: 'tokens back', hash: r.hash, ok: r.ok }); }
  rec.status = 'released'; rec.releasedAt = now(); rec.forwarding = !!back.permanent;
  rec.log.unshift({ at: now(), kind: 'released', text: back.permanent ? 'Balance and tokens handed back. I stay the creator on-chain (that cannot change), so from now on every fee I collect goes straight to the owner.' : 'Fees and balance handed back to the creator.', actions: [], txs });
  agents.put(rec); return publicView(rec);
}

// ---------------------------------------------------------------------------
// Leitura publica (nunca inclui chave nem credenciais).
export function publicView(rec) {
  if (!rec) return null;
  upgrade(rec);
  return {
    token: rec.token, name: rec.name, symbol: rec.symbol, curve: rec.curve, agent: rec.agent, creator: rec.creator,
    status: rec.status, vibe: rec.vibe, avatar: rec.avatar || null,
    venue: chain.NAME, unit, permanentRole: !!chain.agentMustLaunch, forwarding: !!rec.forwarding,
    rules: rec.rules, pendingRules: rec.pendingRules || null, presets: PRESETS, split: splitText(rec.rules),
    stats: rec.stats, milestones: rec.milestones || [], biggestBuyEth: rec.biggestBuyEth || '0',
    createdAt: rec.createdAt, activatedAt: rec.activatedAt, lastTickAt: rec.lastTickAt, releasedAt: rec.releasedAt || null,
    handoverUrl: rec.status === 'pending_handover' ? rec.handoverUrl : null,
    fundingUrl: rec.status === 'pending_funding' && rec.launchId ? `${PUBLIC_URL}/l/${rec.launchId}` : null,
    xConnected: !!rec.x, telegramConnected: !!rec.tg, voice: voiceEnabled(),
    page: `${PUBLIC_URL}/t/${rec.token}`,
    log: rec.log.slice(0, 50), qa: (rec.qa || []).slice(0, 10),
    links: { ...links({ token: rec.token, curve: rec.curve }), agentWallet: `${CHAIN.explorer}/address/${rec.agent}` },
  };
}

export async function liveView(token) {
  const rec = agents.get(id(token));
  if (!rec) return null;
  const v = publicView(rec);
  const [balance, pending] = await Promise.all([chain.agentBalance(rec.agent).catch(() => 0n), rec.status === 'active' ? chain.pendingFees(rec).catch(() => 0n) : Promise.resolve(0n)]);
  v.balanceEth = formatAmount(balance);
  v.balance = formatAmount(balance);
  v.pendingEth = formatAmount(pending);
  v.pending = formatAmount(pending);
  v.needsGas = rec.status === 'active' && balance < MIN_GAS;
  v.kickstartEth = KICKSTART;
  v.kickstart = KICKSTART;
  return v;
}

export const get = (token) => upgrade(agents.get(id(token)));
export const summaries = () => Object.fromEntries(agents.list().map((r) => [r.id, { agent: r.agent, status: r.status }]));
