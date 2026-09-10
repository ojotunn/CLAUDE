// O agente do token. Uma carteira propria recebe as taxas de criador e age
// sozinha em ciclos: coleta, aluguel, recompra e queima, airdrop, reserva.
// Sem aprovacao por acao e sem teto por operacao (regra da casa). As unicas
// travas sao de construcao: esta carteira so fala com a pons, com o endereco
// de queima, com holders (token) e com o criador (na saida).
import fs from 'node:fs';
import path from 'node:path';
import { LIMITS, CHAIN, PUBLIC_URL, CONTRACTS, DATA_DIR } from './config.js';
import { Store } from './store.js';
import * as chain from './chain.js';
import { seal, open, agentsEnabled, issueSession } from './crypto.js';
import { speak, voiceEnabled } from './voice.js';
import { postTweet, validCreds } from './x.js';
import { CURVE_ABI, ERC20_ABI, ESCROW_ABI, DEAD_ADDRESS } from './abi.js';
import { UserError, links } from './launches.js';

const { parseEther, formatEther, formatUnits, getAddress } = chain;

export const agents = new Store('agents');

export const RULES = {
  rentBps: Number(process.env.AGENT_RENT_BPS || 1000),      // aluguel do cerebro -> TREASURY_ADDRESS
  buybackBps: Number(process.env.AGENT_BUYBACK_BPS || 5000), // compra e queima
  airdropBps: Number(process.env.AGENT_AIRDROP_BPS || 2500), // compra e distribui a compradores recentes
  // o resto fica de reserva na carteira
};
const TREASURY = process.env.TREASURY_ADDRESS && /^0x[0-9a-fA-F]{40}$/.test(process.env.TREASURY_ADDRESS) ? getAddress(process.env.TREASURY_ADDRESS) : null;
const RESERVE = parseEther(process.env.AGENT_RESERVE_ETH || '0.001');   // nunca gasta abaixo disto (gas)
const MIN_ACTION = parseEther(process.env.AGENT_MIN_ACTION_ETH || '0.002'); // abaixo disto, dorme
const MIN_SWEEP = parseEther('0.0005');
const MAX_AIRDROP = 20;
export const INTERVAL_MS = Number(process.env.AGENT_INTERVAL_MIN || 5) * 60_000;

const id = (token) => String(token).toLowerCase();
const tokens = (wei) => Number(formatUnits(wei, 18));
const addEth = (a, b) => formatEther(parseEther(a || '0') + b);
const addNum = (a, b) => (Number(a || 0) + Number(b)).toString();
const now = () => new Date().toISOString();

// Modos prontos: a pessoa escolhe um nome ou da os percentuais. O aluguel e
// fixo e fica fora da conta; o que sobra vira reserva.
export const PRESETS = {
  balanced: { buybackBps: 5000, airdropBps: 2500 },
  burner: { buybackBps: 8000, airdropBps: 1000 },
  generous: { buybackBps: 2000, airdropBps: 6000 },
  saver: { buybackBps: 2000, airdropBps: 1000 },
};

export function normalizeRules({ preset, buybackPct, airdropPct } = {}, base = RULES) {
  let buybackBps = base.buybackBps, airdropBps = base.airdropBps;
  if (preset != null) {
    const p = PRESETS[String(preset).toLowerCase()];
    if (!p) throw new UserError(`unknown preset; use one of ${Object.keys(PRESETS).join(', ')}`, 'INVALID_INPUT');
    ({ buybackBps, airdropBps } = p);
  }
  const pct = (v, label) => {
    if (v == null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0 || n > 100) throw new UserError(`${label} must be a percentage between 0 and 100`, 'INVALID_INPUT');
    return Math.round(n * 100);
  };
  const b = pct(buybackPct, 'buybackPct'), a = pct(airdropPct, 'airdropPct');
  if (b != null) buybackBps = b;
  if (a != null) airdropBps = a;
  if (buybackBps + airdropBps + RULES.rentBps > 10_000) {
    throw new UserError(`buyback + airdrop can be at most ${(10_000 - RULES.rentBps) / 100}% (the rest covers rent and gas reserve)`, 'INVALID_INPUT');
  }
  return { rentBps: RULES.rentBps, buybackBps, airdropBps, treasury: !!TREASURY };
}

export function allocate(budget, rules = RULES) {
  const rent = TREASURY ? (budget * BigInt(rules.rentBps ?? RULES.rentBps)) / 10_000n : 0n;
  const buyback = (budget * BigInt(rules.buybackBps)) / 10_000n;
  const airdrop = (budget * BigInt(rules.airdropBps)) / 10_000n;
  return { rent, buyback, airdrop, reserve: budget - rent - buyback - airdrop };
}

export const requireEnabled = () => {
  if (!agentsEnabled()) throw new UserError('agents are not enabled on this server (AGENT_SECRET missing)', 'AGENTS_DISABLED');
};

// ---------------------------------------------------------------------------
// Criacao: carteira nova + pedido de handover para o recebedor atual assinar.
const cleanAvatar = (u) => {
  const s = String(u || '').trim();
  if (!s) return null;
  if (!/^https:\/\/[^\s"'<>]{1,300}$/i.test(s)) throw new UserError('avatar must be an https image URL', 'INVALID_INPUT');
  return s;
};

export async function attach({ token, vibe, avatar, preset, buybackPct, airdropPct }, prepareHandover) {
  requireEnabled();
  if (!/^0x[0-9a-fA-F]{40}$/.test(token || '')) throw new UserError('token must be a 0x address', 'INVALID_INPUT');
  const info = await chain.tokenInfo(token);
  if (!info) throw new UserError('this address is not a pons v2 launch on this network', 'NOT_PONS_TOKEN');
  const existing = agents.get(id(token));
  if (existing && existing.status === 'active') return { agent: publicView(existing), url: null, already: true };
  if (existing && existing.status === 'pending_handover') return { agent: publicView(existing), url: existing.handoverUrl, already: true };

  const { pk, address } = chain.newAgentKey();
  const rec = {
    id: id(token), token: info.token, name: info.name, symbol: info.symbol, curve: info.curve,
    creator: info.creatorFeeRecipient, agent: address, key: seal(pk),
    status: 'pending_handover', vibe: String(vibe || '').slice(0, 200), avatar: cleanAvatar(avatar),
    rules: normalizeRules({ preset, buybackPct, airdropPct }), pendingRules: null, x: null,
    stats: { collectedEth: '0', buybackEth: '0', burnedTokens: '0', airdropEth: '0', airdroppedTokens: '0', rentEth: '0', cycles: 0, posts: 0 },
    log: [], createdAt: now(), activatedAt: null, lastTickAt: null, handoverId: null, handoverUrl: null,
  };
  const handover = await prepareHandover({ token: info.token, name: info.name, symbol: info.symbol, agent: address, currentRecipient: info.creatorFeeRecipient });
  rec.handoverId = handover.id;
  rec.handoverUrl = handover.url;
  agents.put(rec);
  return { agent: publicView(rec), url: handover.url, already: false };
}

// Chamado pelo observador quando o handover confirmou na chain.
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
// O ciclo.
const running = new Set();
export async function tick(rec) {
  if (rec.status !== 'active' || running.has(rec.id)) return;
  running.add(rec.id);
  const pk = open(rec.key);
  const actions = [], txs = [], errors = [];
  const tx = async (label, fn) => {
    try { const r = await fn(); txs.push({ label, hash: r.hash, ok: r.ok }); if (!r.ok) errors.push(`${label} reverted`); return r; } catch (e) { errors.push(`${label}: ${String(e.shortMessage || e.message).split('\n')[0].slice(0, 120)}`); return null; }
  };
  try {
    const flags = await chain.curveFlags(rec.curve);
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
    // 2) orcamento: tudo acima da reserva
    const balance = await chain.getBalance(rec.agent);
    const budget = balance > RESERVE ? balance - RESERVE : 0n;
    if (budget >= MIN_ACTION) {
      const a = allocate(budget, rec.rules);
      if (a.rent > 0n && TREASURY) {
        const r = await tx('rent', () => chain.agentSendEth(pk, TREASURY, a.rent));
        if (r?.ok) { actions.push({ kind: 'rent', eth: formatEther(a.rent) }); rec.stats.rentEth = addEth(rec.stats.rentEth, a.rent); }
      }
      if (flags.graduated) {
        actions.push({ kind: 'hold', eth: formatEther(a.buyback + a.airdrop), reason: 'curve graduated to Uniswap v4; holding' });
      } else {
        // 3) recompra e queima
        if (a.buyback > 0n) {
          const before = await chain.tokenBalance(rec.token, rec.agent);
          const r = await tx('buyback', () => chain.agentWrite(pk, { address: rec.curve, abi: CURVE_ABI, functionName: 'buy', args: [a.buyback, 0n, rec.agent], value: a.buyback }));
          if (r?.ok) {
            const got = (await chain.tokenBalance(rec.token, rec.agent)) - before;
            rec.stats.buybackEth = addEth(rec.stats.buybackEth, a.buyback);
            actions.push({ kind: 'buyback', eth: formatEther(a.buyback), tokens: tokens(got) });
            if (got > 0n) {
              const b = await tx('burn', () => chain.agentWrite(pk, { address: rec.token, abi: ERC20_ABI, functionName: 'transfer', args: [DEAD_ADDRESS, got] }));
              if (b?.ok) { actions.push({ kind: 'burn', tokens: tokens(got) }); rec.stats.burnedTokens = addNum(rec.stats.burnedTokens, tokens(got)); }
            }
          }
        }
        // 4) airdrop para compradores recentes
        if (a.airdrop > 0n) {
          const buyers = await chain.recentBuyers(rec.curve, { max: MAX_AIRDROP, exclude: [rec.agent, rec.curve, DEAD_ADDRESS] });
          if (buyers.length) {
            const before = await chain.tokenBalance(rec.token, rec.agent);
            const r = await tx('airdrop-buy', () => chain.agentWrite(pk, { address: rec.curve, abi: CURVE_ABI, functionName: 'buy', args: [a.airdrop, 0n, rec.agent], value: a.airdrop }));
            if (r?.ok) {
              const got = (await chain.tokenBalance(rec.token, rec.agent)) - before;
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
              actions.push({ kind: 'airdrop', eth: formatEther(a.airdrop), tokens: tokens(sent), recipients: count });
            }
          } else {
            actions.push({ kind: 'hold', eth: formatEther(a.airdrop), reason: 'no recent buyers to drop on yet' });
          }
        }
      }
    }
    // 5) fala, so quando fez algo que vale contar
    const worth = actions.some((x) => ['collect', 'buyback', 'burn', 'airdrop'].includes(x.kind));
    let post = null;
    if (worth) {
      const info = await chain.tokenInfo(rec.token).catch(() => null);
      const v = await speak({
        name: rec.name, symbol: rec.symbol, vibe: rec.vibe, actions, stats: rec.stats,
        curve: info ? { priceEth: info.priceEth, raisedEth: info.raisedEth, graduationProgress: info.graduationProgress } : null,
      });
      post = { text: v.text, generated: v.generated, tweetId: null, tweetError: null };
      if (rec.x) {
        try { const t = await postTweet(JSON.parse(open(rec.x)), v.text); post.tweetId = t.id; } catch (e) { post.tweetError = String(e.message).slice(0, 160); }
      }
      rec.stats.posts++;
    }
    if (actions.length || errors.length) {
      rec.log.unshift({ at: now(), kind: 'cycle', actions, txs, errors, post });
      rec.log = rec.log.slice(0, 200);
    }
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

export function setX(token, creds) {
  const rec = agents.get(id(token));
  if (!rec) throw new UserError('no agent for this token', 'NOT_FOUND');
  if (creds === null) { rec.x = null; agents.put(rec); return publicView(rec); }
  const c = { apiKey: String(creds.apiKey || '').trim(), apiSecret: String(creds.apiSecret || '').trim(), accessToken: String(creds.accessToken || '').trim(), accessSecret: String(creds.accessSecret || '').trim() };
  if (!validCreds(c)) throw new UserError('all four X credentials are required', 'INVALID_INPUT');
  rec.x = seal(JSON.stringify(c));
  agents.put(rec);
  return publicView(rec);
}

export async function testX(token) {
  const rec = agents.get(id(token));
  if (!rec?.x) throw new UserError('X is not connected for this agent', 'NOT_FOUND');
  const t = await postTweet(JSON.parse(open(rec.x)), `$${rec.symbol} here. My agent just connected to X. More soon.`);
  return { tweetId: t.id };
}

// Regras. Pelo chat: antes do handover aplica direto (a assinatura do handover
// confirma); depois vira proposta que o criador confirma na pagina. Pela
// pagina (sessao do criador): aplica direto.
export function proposeRules(token, input) {
  const rec = agents.get(id(token));
  if (!rec) throw new UserError('this token has no agent', 'NOT_FOUND');
  if (rec.status === 'released') throw new UserError('this agent was released', 'BAD_STATE');
  const rules = normalizeRules(input, rec.rules);
  if (rec.status === 'pending_handover') {
    rec.rules = rules; rec.pendingRules = null; agents.put(rec);
    return { applied: true, rules, view: publicView(rec) };
  }
  rec.pendingRules = { ...rules, proposedAt: now() };
  agents.put(rec);
  return { applied: false, rules, view: publicView(rec) };
}

export function setRules(token, input) {
  const rec = agents.get(id(token));
  if (!rec) throw new UserError('this token has no agent', 'NOT_FOUND');
  rec.rules = normalizeRules(input, rec.rules);
  rec.pendingRules = null;
  agents.put(rec);
  return publicView(rec);
}

export function applyPendingRules(token) {
  const rec = agents.get(id(token));
  if (!rec) throw new UserError('this token has no agent', 'NOT_FOUND');
  if (!rec.pendingRules) throw new UserError('nothing proposed', 'BAD_STATE');
  const { proposedAt, ...rules } = rec.pendingRules;
  rec.rules = rules; rec.pendingRules = null;
  agents.put(rec);
  return publicView(rec);
}

export function setVibe(token, vibe) {
  const rec = agents.get(id(token));
  if (!rec) throw new UserError('no agent for this token', 'NOT_FOUND');
  rec.vibe = String(vibe || '').slice(0, 200);
  agents.put(rec);
  return publicView(rec);
}

// Foto de perfil: URL https (pelo chat) ou arquivo enviado na pagina (fica em
// DATA_DIR/avatars e e servido em /avatars/<token>.<ext>).
const MAGIC = [
  { ext: 'png', head: [0x89, 0x50, 0x4e, 0x47] },
  { ext: 'jpg', head: [0xff, 0xd8, 0xff] },
  { ext: 'gif', head: [0x47, 0x49, 0x46, 0x38] },
  { ext: 'webp', head: [0x52, 0x49, 0x46, 0x46], at8: [0x57, 0x45, 0x42, 0x50] },
];
export function setAvatar(token, { url = null, bytes = null } = {}) {
  const rec = agents.get(id(token));
  if (!rec) throw new UserError('no agent for this token', 'NOT_FOUND');
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
  agents.put(rec);
  return publicView(rec);
}

// Saida: devolve o papel de recebedor e o caixa ao criador. So o criador (sessao).
export async function release(token) {
  const rec = agents.get(id(token));
  if (!rec) throw new UserError('no agent for this token', 'NOT_FOUND');
  if (rec.status !== 'active') throw new UserError(`agent is ${rec.status}; nothing to release`, 'BAD_STATE');
  const pk = open(rec.key);
  const txs = [];
  const back = await chain.agentWrite(pk, { address: CONTRACTS.factory, abi: (await import('./abi.js')).FACTORY_ABI, functionName: 'transferCreatorFeeRecipient', args: [rec.token, rec.creator] });
  txs.push({ label: 'handback', hash: back.hash, ok: back.ok });
  if (!back.ok) throw new UserError('handing the fee recipient back reverted', 'REVERT');
  const bal = await chain.getBalance(rec.agent);
  const gas = parseEther('0.0003');
  if (bal > gas) {
    const r = await chain.agentSendEth(pk, rec.creator, bal - gas);
    txs.push({ label: 'refund', hash: r.hash, ok: r.ok });
  }
  const held = await chain.tokenBalance(rec.token, rec.agent);
  if (held > 0n) {
    const r = await chain.agentWrite(pk, { address: rec.token, abi: ERC20_ABI, functionName: 'transfer', args: [rec.creator, held] });
    txs.push({ label: 'tokens back', hash: r.hash, ok: r.ok });
  }
  rec.status = 'released';
  rec.releasedAt = now();
  rec.log.unshift({ at: now(), kind: 'released', text: 'Fees and balance handed back to the creator.', actions: [], txs });
  agents.put(rec);
  return publicView(rec);
}

// ---------------------------------------------------------------------------
// Leitura publica (nunca inclui chave nem credenciais).
export function publicView(rec) {
  if (!rec) return null;
  return {
    token: rec.token, name: rec.name, symbol: rec.symbol, curve: rec.curve, agent: rec.agent, creator: rec.creator,
    status: rec.status, vibe: rec.vibe, avatar: rec.avatar || null, rules: rec.rules, pendingRules: rec.pendingRules || null, presets: PRESETS, stats: rec.stats,
    createdAt: rec.createdAt, activatedAt: rec.activatedAt, lastTickAt: rec.lastTickAt, releasedAt: rec.releasedAt || null,
    handoverUrl: rec.status === 'pending_handover' ? rec.handoverUrl : null,
    xConnected: !!rec.x, voice: voiceEnabled(),
    page: `${PUBLIC_URL}/t/${rec.token}`,
    log: rec.log.slice(0, 50),
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
