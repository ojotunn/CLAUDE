// O agente do token. Uma carteira propria recebe as taxas de criador e age
// sozinha em ciclos: coleta, aluguel, salario do criador, recompra e queima,
// airdrop (com ou sem fidelidade), sorteio, compra na queda, reserva. Fala
// quando age e quando algo acontece na curva (compra grande, marco,
// graduacao). Sem aprovacao por acao e sem teto por operacao (regra da casa).
// As unicas travas sao de construcao: esta carteira so fala com a pons, com o
// endereco de queima, com holders (token), com o criador e com a tesouraria.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LIMITS, CHAIN, PUBLIC_URL, CONTRACTS, DATA_DIR } from './config.js';
import { Store } from './store.js';
import * as chain from './chain.js';
import { seal, open, agentsEnabled, issueSession } from './crypto.js';
import { speak, react, answer, voiceEnabled } from './voice.js';
import { postTweet, validCreds, postTelegram, validTelegram } from './x.js';
import { CURVE_ABI, ERC20_ABI, ESCROW_ABI, FACTORY_ABI, DEAD_ADDRESS } from './abi.js';
import { UserError, links, hooks, launches } from './launches.js';

const { parseEther, formatEther, formatUnits, getAddress } = chain;

export const agents = new Store('agents');
hooks.agentInfo = (token) => {
  const r = agents.get(String(token).toLowerCase());
  return r ? { vibe: r.vibe, avatar: r.avatar || null, rules: r.rules } : null;
};

// ---------------------------------------------------------------------------
// Constantes e regras.
const RENT_BPS = Number(process.env.AGENT_RENT_BPS || 1000);
const TREASURY = process.env.TREASURY_ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(process.env.TREASURY_ADDRESS) ? getAddress(process.env.TREASURY_ADDRESS) : null;
const RESERVE = parseEther(process.env.AGENT_RESERVE_ETH || '0.001');
const MIN_ACTION = parseEther(process.env.AGENT_MIN_ACTION_ETH || '0.002');
const MIN_SWEEP = parseEther('0.0005');
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
  quietHours: null, minPostMin: 0, whaleEth: '0.05',
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
  if (input.whaleEth != null) {
    const w = String(input.whaleEth);
    if (!/^\d+(\.\d{1,18})?$/.test(w)) throw new UserError('whaleEth must be a decimal ETH amount', 'INVALID_INPUT');
    r.whaleEth = w;
  }
  r.rentBps = RENT_BPS;
  const total = r.buybackBps + r.airdropBps + r.salaryBps + r.raffleBps + r.rentBps;
  if (total > 10_000) throw new UserError(`buy back + airdrop + salary + raffle can be at most ${(10_000 - r.rentBps) / 100}% (the rest covers rent and gas reserve)`, 'INVALID_INPUT');
  r.treasury = !!TREASURY;
  return r;
}

export function allocate(budget, rules = RULES) {
  const cut = (bps) => (budget * BigInt(bps || 0)) / 10_000n;
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
const addEth = (a, b) => formatEther(parseEther(a || '0') + b);
const addNum = (a, b) => (Number(a || 0) + Number(b)).toString();
const now = () => new Date().toISOString();
const cleanAvatar = (u) => {
  const s = String(u || '').trim();
  if (!s) return null;
  if (!/^https:\/\/[^\s"'<>]{1,300}$/i.test(s)) throw new UserError('avatar must be an https image URL', 'INVALID_INPUT');
  return s;
};

// ---------------------------------------------------------------------------
// Criacao: carteira nova + pedido de handover para o recebedor atual assinar.
export async function attach({ token, vibe, avatar, ...ruleInput }, prepareHandover) {
  requireEnabled();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token || '')) throw new UserError('token must be a 0x address', 'INVALID_INPUT');
  const info = await chain.tokenInfo(token);
  if (!info) throw new UserError('this address is not a pons v2 launch on this network', 'NOT_PONS_TOKEN');
  const existing = agents.get(id(token));
  if (existing && existing.status === 'active') return { agent: publicView(existing), url: null, already: true };
  if (existing && existing.status === 'pending_handover') {
    const h = launches.get(existing.handoverId);
    if (h && Date.parse(h.expiresAt) > Date.now()) return { agent: publicView(existing), url: existing.handoverUrl, already: true };
  }
  const { pk, address } = chain.newAgentKey();
  const rec = {
    id: id(token), token: info.token, name: info.name, symbol: info.symbol, curve: info.curve,
    creator: info.creatorFeeRecipient, agent: address, key: seal(pk),
    status: 'pending_handover', vibe: String(vibe || '').slice(0, 200), avatar: cleanAvatar(avatar),
    rules: normalizeRules(ruleInput), pendingRules: null, x: null, tg: null,
    stats: { collectedEth: '0', buybackEth: '0', burnedTokens: '0', airdropEth: '0', airdroppedTokens: '0', raffleEth: '0', raffleTokens: '0', salaryEth: '0', rentEth: '0', dipBuyEth: '0', cycles: 0, posts: 0, questions: 0 },
    milestones: [], lastPriceEth: null, lastScanBlock: null, biggestBuyEth: '0', graduatedNoted: false, lastPostAt: null,
    log: [], qa: [], createdAt: now(), activatedAt: null, lastTickAt: null, handoverId: null, handoverUrl: null,
  };
  const handover = await prepareHandover({ token: info.token, name: info.name, symbol: info.symbol, agent: address, currentRecipient: info.creatorFeeRecipient });
  rec.handoverId = handover.id;
  rec.handoverUrl = handover.url;
  agents.put(rec);
  return { agent: publicView(rec), url: handover.url, already: false };
}

export async function activate(token, agentAddress) {
  const rec = agents.get(id(token));
  if (!rec || rec.agent.toLowerCase() !== String(agentAddress).toLowerCase()) return;
  const launched = await chain.launchedToken(rec.token);
  if (!launched || launched.creatorFeeRecipient.toLowerCase() !== rec.agent.toLowerCase()) {
    console.error(`[agent] ${rec.symbol}: handover confirmed but recipient is ${launched?.creatorFeeRecipient}`);
    return;
  }
  rec.status = 'active';
  rec.activatedAt = now();
  rec.log.unshift({ at: now(), kind: 'born', text: `Fees handed over. ${rec.symbol} now runs its own wallet.`, actions: [], txs: [] });
  agents.put(rec);
  console.log(`[agent] ${rec.symbol} active at ${rec.agent}`);
}

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
  if (rec.status !== 'active' || running.has(rec.id)) return;
  running.add(rec.id);
  const pk = open(rec.key);
  const actions = [], txs = [], errors = [], events = [];
  const tx = async (label, fn) => {
    try { const r = await fn(); txs.push({ label, hash: r.hash, ok: r.ok }); if (!r.ok) errors.push(`${label} reverted`); return r; } catch (e) { errors.push(`${label}: ${String(e.shortMessage || e.message).split('\n')[0].slice(0, 120)}`); return null; }
  };
  const buy = async (label, value) => {
    const before = await chain.tokenBalance(rec.token, rec.agent);
    const r = await tx(label, () => chain.agentWrite(pk, { address: rec.curve, abi: CURVE_ABI, functionName: 'buy', args: [value, 0n, rec.agent], value }));
    if (!r?.ok) return 0n;
    return (await chain.tokenBalance(rec.token, rec.agent)) - before;
  };
  try {
    const flags = await chain.curveFlags(rec.curve);
    const info = await chain.tokenInfo(rec.token).catch(() => null);

    // 0) eventos na curva desde o ultimo ciclo
    const latest = await chain.blockNumber();
    const from = rec.lastScanBlock ? BigInt(rec.lastScanBlock) + 1n : latest - 200n;
    const buys = await chain.curveBuysBetween(rec.curve, from < 0n ? 0n : from, latest);
    const whale = parseEther(rec.rules.whaleEth || '0.05');
    for (const b of buys) {
      if (b.quoteIn >= whale && b.recipient.toLowerCase() !== rec.agent.toLowerCase()) events.push({ kind: 'whale', eth: formatEther(b.quoteIn), who: b.recipient });
      if (b.quoteIn > parseEther(rec.biggestBuyEth || '0')) rec.biggestBuyEth = formatEther(b.quoteIn);
    }
    rec.lastScanBlock = latest.toString();
    if (info && rec.rules.milestones) {
      for (const m of [25, 50, 75, 100]) {
        if (info.graduationProgress >= m && !rec.milestones.includes(m)) { rec.milestones.push(m); events.push({ kind: 'milestone', pct: m }); }
      }
    }
    if (flags.graduated && !rec.graduatedNoted) { rec.graduatedNoted = true; events.push({ kind: 'graduated' }); }

    // 1) coleta: varre a curva (se puder) e saca o escrow
    if (!flags.graduated && !flags.buybackEnabled && flags.deployer.toLowerCase() === rec.agent.toLowerCase()) {
      const unswept = await chain.curveUnswept(rec.curve);
      if (unswept >= MIN_SWEEP) await tx('sweep', () => chain.agentWrite(pk, { address: rec.curve, abi: CURVE_ABI, functionName: 'sweepFees', args: [0n] }));
    }
    const escrow = await chain.escrowBalance(rec.agent);
    if (escrow > 0n) {
      const r = await tx('claim', () => chain.agentWrite(pk, { address: CONTRACTS.feeEscrow, abi: ESCROW_ABI, functionName: 'claim' }));
      if (r?.ok) { actions.push({ kind: 'collect', eth: formatEther(escrow) }); rec.stats.collectedEth = addEth(rec.stats.collectedEth, escrow); }
    }

    // 2) compra na queda: usa a reserva se o preco caiu mais que X% desde o ultimo ciclo
    if (info && rec.rules.dipBuyPct > 0 && rec.lastPriceEth && !flags.graduated) {
      const drop = (1 - info.priceEth / Number(rec.lastPriceEth)) * 100;
      if (drop >= rec.rules.dipBuyPct) {
        const bal = await chain.getBalance(rec.agent);
        const spend = bal > RESERVE + MIN_ACTION ? bal - RESERVE : 0n;
        if (spend > 0n) {
          const got = await buy('dip-buy', spend);
          if (got > 0n) {
            rec.stats.dipBuyEth = addEth(rec.stats.dipBuyEth, spend);
            actions.push({ kind: 'dipbuy', eth: formatEther(spend), tokens: tokens(got), dropPct: Math.round(drop) });
            const b = await tx('burn', () => chain.agentWrite(pk, { address: rec.token, abi: ERC20_ABI, functionName: 'transfer', args: [DEAD_ADDRESS, got] }));
            if (b?.ok) { actions.push({ kind: 'burn', tokens: tokens(got) }); rec.stats.burnedTokens = addNum(rec.stats.burnedTokens, tokens(got)); }
          }
        }
      }
    }
    if (info) rec.lastPriceEth = String(info.priceEth);

    // 3) orcamento: tudo acima da reserva
    const balance = await chain.getBalance(rec.agent);
    const budget = balance > RESERVE ? balance - RESERVE : 0n;
    if (budget >= MIN_ACTION && !rec.rules.collectOnly) {
      const a = allocate(budget, rec.rules);
      if (a.rent > 0n && TREASURY) {
        const r = await tx('rent', () => chain.agentSendEth(pk, TREASURY, a.rent));
        if (r?.ok) { actions.push({ kind: 'rent', eth: formatEther(a.rent) }); rec.stats.rentEth = addEth(rec.stats.rentEth, a.rent); }
      }
      if (a.salary > 0n) {
        const r = await tx('salary', () => chain.agentSendEth(pk, rec.creator, a.salary));
        if (r?.ok) { actions.push({ kind: 'salary', eth: formatEther(a.salary) }); rec.stats.salaryEth = addEth(rec.stats.salaryEth, a.salary); }
      }
      if (flags.graduated) {
        actions.push({ kind: 'hold', eth: formatEther(a.buyback + a.airdrop + a.raffle), reason: 'curve graduated to Uniswap v4; holding' });
      } else {
        // recompra e queima
        if (a.buyback > 0n) {
          const got = await buy('buyback', a.buyback);
          if (got > 0n) {
            rec.stats.buybackEth = addEth(rec.stats.buybackEth, a.buyback);
            actions.push({ kind: 'buyback', eth: formatEther(a.buyback), tokens: tokens(got) });
            const b = await tx('burn', () => chain.agentWrite(pk, { address: rec.token, abi: ERC20_ABI, functionName: 'transfer', args: [DEAD_ADDRESS, got] }));
            if (b?.ok) { actions.push({ kind: 'burn', tokens: tokens(got) }); rec.stats.burnedTokens = addNum(rec.stats.burnedTokens, tokens(got)); }
          }
        }
        // airdrop para compradores recentes (opcional: so quem nunca vendeu)
        const exclude = [rec.agent, rec.curve, DEAD_ADDRESS];
        let buyers = (a.airdrop > 0n || a.raffle > 0n) ? await chain.recentBuyers(rec.curve, { max: MAX_AIRDROP, exclude }) : [];
        if (buyers.length && rec.rules.loyaltyOnly) {
          const sellers = await chain.sellersSince(rec.token, rec.curve, 20_000n);
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
                const t = await tx(`airdrop ${b.address.slice(0, 8)}`, () => chain.agentWrite(pk, { address: rec.token, abi: ERC20_ABI, functionName: 'transfer', args: [b.address, share] }));
                if (t?.ok) { sent += share; count++; }
              }
              rec.stats.airdropEth = addEth(rec.stats.airdropEth, a.airdrop);
              rec.stats.airdroppedTokens = addNum(rec.stats.airdroppedTokens, tokens(sent));
              actions.push({ kind: 'airdrop', eth: formatEther(a.airdrop), tokens: tokens(sent), recipients: count, loyal: rec.rules.loyaltyOnly });
            }
          } else {
            actions.push({ kind: 'hold', eth: formatEther(a.airdrop), reason: rec.rules.loyaltyOnly ? 'no recent buyer kept every token yet' : 'no recent buyers to drop on yet' });
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
              const t = await tx('raffle prize', () => chain.agentWrite(pk, { address: rec.token, abi: ERC20_ABI, functionName: 'transfer', args: [winner, got] }));
              if (t?.ok) {
                rec.stats.raffleEth = addEth(rec.stats.raffleEth, a.raffle);
                rec.stats.raffleTokens = addNum(rec.stats.raffleTokens, tokens(got));
                actions.push({ kind: 'raffle', eth: formatEther(a.raffle), tokens: tokens(got), winner, entrants: buyers.length, block: latest.toString() });
              }
            }
          } else {
            actions.push({ kind: 'hold', eth: formatEther(a.raffle), reason: 'no recent buyers for a raffle yet' });
          }
        }
      }
    } else if (budget >= MIN_ACTION && rec.rules.collectOnly) {
      actions.push({ kind: 'hold', eth: formatEther(budget), reason: 'collect-only mode' });
    }

    // 4) fala: acoes que valem contar, e eventos
    const worth = actions.some((x) => ['collect', 'buyback', 'burn', 'airdrop', 'raffle', 'salary', 'dipbuy'].includes(x.kind));
    const curve = info ? { priceEth: info.priceEth, raisedEth: info.raisedEth, graduationProgress: info.graduationProgress } : null;
    let post = null;
    if (worth && canPostNow(rec)) {
      const v = await speak({ name: rec.name, symbol: rec.symbol, vibe: rec.vibe, actions, stats: rec.stats, curve });
      post = await publish(rec, v.text, v.generated);
    }
    for (const ev of events) {
      if (!canPostNow(rec)) break;
      const v = await react({ name: rec.name, symbol: rec.symbol, vibe: rec.vibe, event: ev, curve });
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
  const run = async () => { for (const rec of agents.list((r) => r.status === 'active')) await tick(rec); };
  timer = setInterval(() => run().catch((e) => console.error('[agent loop]', e)), INTERVAL_MS);
  timer.unref();
  setTimeout(() => run().catch(() => {}), 15_000).unref();
  console.log(`  agents       : enabled, cycle every ${INTERVAL_MS / 60_000} min, voice ${voiceEnabled() ? 'on' : 'template only'}, treasury ${TREASURY || 'none (rent stays in reserve)'}`);
}

// ---------------------------------------------------------------------------
// Sessao do criador (assinatura de mensagem na pagina) e configuracoes.
export function loginMessage({ token, wallet, issuedAt }) {
  return `Claudeploy: manage the agent of ${token} as ${wallet} at ${issuedAt}`;
}

export async function login({ token, wallet, issuedAt, signature }) {
  const rec = agents.get(id(token));
  if (!rec) throw new UserError('no agent for this token', 'NOT_FOUND');
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet || '')) throw new UserError('invalid wallet', 'INVALID_INPUT');
  if (getAddress(wallet) !== getAddress(rec.creator)) throw new UserError(`only the creator wallet ${rec.creator} can manage this agent`, 'FORBIDDEN');
  const age = Date.now() - Date.parse(issuedAt || '');
  if (!(age >= -60_000 && age < 10 * 60_000)) throw new UserError('login message expired; try again', 'EXPIRED');
  const ok = await chain.verifySignedMessage({ address: getAddress(wallet), message: loginMessage({ token: rec.token, wallet, issuedAt }), signature });
  if (!ok) throw new UserError('signature does not match the wallet', 'FORBIDDEN');
  return { session: issueSession({ wallet, token: rec.token }) };
}

const need = (token) => { const rec = agents.get(id(token)); if (!rec) throw new UserError('no agent for this token', 'NOT_FOUND'); return rec; };

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
  if (rec.status === 'pending_handover') { rec.rules = rules; rec.pendingRules = null; agents.put(rec); return { applied: true, rules, view: publicView(rec) }; }
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
  const info = await chain.tokenInfo(rec.token).catch(() => null);
  const a = await answer({ name: rec.name, symbol: rec.symbol, vibe: rec.vibe, stats: rec.stats, question: q,
    curve: info ? { priceEth: info.priceEth, raisedEth: info.raisedEth, graduationProgress: info.graduationProgress } : null });
  const entry = { at: now(), q, a: a.text };
  rec.qa.unshift(entry); rec.qa = rec.qa.slice(0, 30); rec.stats.questions++;
  agents.put(rec);
  return entry;
}

// Saida: devolve o papel de recebedor e o caixa ao criador. So o criador (sessao).
export async function release(token) {
  const rec = need(token);
  if (rec.status !== 'active') throw new UserError(`agent is ${rec.status}; nothing to release`, 'BAD_STATE');
  const pk = open(rec.key);
  const txs = [];
  const back = await chain.agentWrite(pk, { address: CONTRACTS.factory, abi: FACTORY_ABI, functionName: 'transferCreatorFeeRecipient', args: [rec.token, rec.creator] });
  txs.push({ label: 'handback', hash: back.hash, ok: back.ok });
  if (!back.ok) throw new UserError('handing the fee recipient back reverted', 'REVERT');
  const bal = await chain.getBalance(rec.agent);
  const gas = parseEther('0.0003');
  if (bal > gas) { const r = await chain.agentSendEth(pk, rec.creator, bal - gas); txs.push({ label: 'refund', hash: r.hash, ok: r.ok }); }
  const held = await chain.tokenBalance(rec.token, rec.agent);
  if (held > 0n) { const r = await chain.agentWrite(pk, { address: rec.token, abi: ERC20_ABI, functionName: 'transfer', args: [rec.creator, held] }); txs.push({ label: 'tokens back', hash: r.hash, ok: r.ok }); }
  rec.status = 'released'; rec.releasedAt = now();
  rec.log.unshift({ at: now(), kind: 'released', text: 'Fees and balance handed back to the creator.', actions: [], txs });
  agents.put(rec); return publicView(rec);
}

// ---------------------------------------------------------------------------
// Leitura publica (nunca inclui chave nem credenciais).
export function publicView(rec) {
  if (!rec) return null;
  return {
    token: rec.token, name: rec.name, symbol: rec.symbol, curve: rec.curve, agent: rec.agent, creator: rec.creator,
    status: rec.status, vibe: rec.vibe, avatar: rec.avatar || null,
    rules: rec.rules, pendingRules: rec.pendingRules || null, presets: PRESETS, split: splitText(rec.rules),
    stats: rec.stats, milestones: rec.milestones || [], biggestBuyEth: rec.biggestBuyEth || '0',
    createdAt: rec.createdAt, activatedAt: rec.activatedAt, lastTickAt: rec.lastTickAt, releasedAt: rec.releasedAt || null,
    handoverUrl: rec.status === 'pending_handover' ? rec.handoverUrl : null,
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
  const [balance, escrow] = await Promise.all([chain.getBalance(rec.agent).catch(() => 0n), chain.escrowBalance(rec.agent).catch(() => 0n)]);
  let unswept = 0n;
  if (rec.status === 'active') unswept = await chain.curveUnswept(rec.curve).catch(() => 0n);
  v.balanceEth = formatEther(balance);
  v.pendingEth = formatEther(escrow + unswept);
  return v;
}

export const get = (token) => agents.get(id(token));
export const summaries = () => Object.fromEntries(agents.list().map((r) => [r.id, { agent: r.agent, status: r.status }]));
