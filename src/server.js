// Servidor HTTP do Claudeploy: endpoint MCP (Claude), API da pagina de
// assinatura e o site estatico. Uma porta so. As paginas HTML passam por um
// template minimo, porque o mesmo site serve os dois venues (pons e Argus).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PORT, PUBLIC_URL, CHAIN, CONTRACTS, LIMITS, APP_NAME, VERSION, DATA_DIR, LINKS, REPO_URL, OFFICIAL_TOKEN, TOKEN_URL, VENUE, QUOTE } from './config.js';
import { createMcpServer } from './mcp.js';
import * as chain from './chain.js';
import * as launches from './launches.js';
import * as agent from './agent.js';
import { readSession, agentsEnabled } from './crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// Dominio canonico: paginas em outro host (www, dominio do Railway) redirecionam.
// /mcp e /api ficam de fora: um conector ja colado com a URL antiga continua
// funcionando, porque cliente MCP nao segue redirect de POST.
const CANONICAL_HOST = process.env.CANONICAL_HOST || null;
if (CANONICAL_HOST) {
  app.use((req, res, next) => {
    const host = (req.headers.host || '').toLowerCase();
    if (req.method === 'GET' && host && host !== CANONICAL_HOST && req.path !== '/mcp' && !req.path.startsWith('/api')) {
      return res.redirect(301, `https://${CANONICAL_HOST}${req.originalUrl}`);
    }
    next();
  });
}

// Cabecalhos de seguranca. A pagina de assinatura nunca pode ser embutida em
// iframe de terceiros (clickjacking sobre o botao de assinar).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
});

// Limite por IP, um balde por limitador. O endpoint e publico e cada chamada
// bate na RPC, entao o que escreve ou simula tem teto mais baixo.
function rateLimit(max, windowMs) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const entry = hits.get(req.ip) || { count: 0, reset: now + windowMs };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
    entry.count++;
    hits.set(req.ip, entry);
    if (hits.size > 20_000) hits.clear();
    if (entry.count > max) return res.status(429).json({ error: 'too many requests, slow down' });
    next();
  };
}

// ---------------------------------------------------------------------------
// MCP (Streamable HTTP, sem sessao): um servidor novo por requisicao.
app.post('/mcp', rateLimit(60, 60_000), async (req, res) => {
  const server = createMcpServer();
  try {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('[mcp] request failed:', e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
  }
});
const methodNotAllowed = (_req, res) => res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'method not allowed' }, id: null });
app.get('/mcp', methodNotAllowed);
app.delete('/mcp', methodNotAllowed);

// ---------------------------------------------------------------------------
// API usada pela pagina de assinatura e pelo site.
const api = express.Router();
api.use(rateLimit(240, 60_000));
const writeLimit = rateLimit(20, 60_000);

api.get('/health', (_req, res) => res.json({ ok: true, app: APP_NAME, version: VERSION, venue: VENUE, network: CHAIN.network }));

api.get('/terms', async (_req, res) => {
  const t = await chain.protocolTerms();
  const s = chain.termsSummary(t);
  res.json({
    ...s,
    app: APP_NAME,
    venueName: s.venue,
    venue: { id: VENUE, name: chain.NAME, short: chain.SHORT, market: chain.MARKET, docs: chain.DOCS_URL, tokenUrl: TOKEN_URL, supportsHandover: chain.supportsHandover, agentMustLaunch: chain.agentMustLaunch },
    unit: QUOTE.symbol,
    chain: { id: CHAIN.id, name: CHAIN.name, rpc: CHAIN.rpc, explorer: CHAIN.explorer, isTestnet: CHAIN.isTestnet, native: CHAIN.native },
    contracts: CONTRACTS,
    launchFeeEth: s.launchFee,
    maxCreatorTaxBps: s.maxCreatorTaxBps,
    launchEnabled: s.launchesOpenToEveryone,
    graduatesAtEth: s.graduatesAtValue,
    devBuyCapBps: LIMITS.maxDevBuyBps,
    mcpUrl: `${PUBLIC_URL}/mcp`,
    links: LINKS,
    repo: REPO_URL,
    officialToken: OFFICIAL_TOKEN ? { ...OFFICIAL_TOKEN, pons: TOKEN_URL.replace('{token}', OFFICIAL_TOKEN.address), venue: TOKEN_URL.replace('{token}', OFFICIAL_TOKEN.address), explorer: `${CHAIN.explorer}/token/${OFFICIAL_TOKEN.address}` } : null,
  });
});

api.get('/launches', (req, res) => res.json({ launches: launches.recent(req.query.limit) }));

// ---------------------------------------------------------------------------
// Agentes. Leitura e publica; escrita exige a sessao do dono (assinatura).
const tokenParam = (req) => {
  const t = req.params.token || '';
  if (!/^0x[0-9a-fA-F]{40}$/.test(t)) throw new launches.UserError('invalid token address', 'INVALID_INPUT');
  return t;
};
const creatorOnly = (req, res, next) => {
  const s = readSession((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const t = (req.params.token || '').toLowerCase();
  if (!s || s.token !== t) return res.status(401).json({ error: 'sign in with the creator wallet first', code: 'UNAUTHORIZED' });
  const rec = agent.get(t);
  if (!rec || !rec.creator || rec.creator.toLowerCase() !== s.wallet) return res.status(403).json({ error: 'only the creator wallet can do this', code: 'FORBIDDEN' });
  req.agent = rec;
  next();
};
api.get('/agent/:token', async (req, res) => {
  const v = await agent.liveView(tokenParam(req));
  if (!v) return res.status(404).json({ error: 'this token has no agent', code: 'NOT_FOUND' });
  res.json(v);
});
api.get('/agent/:token/login-message', (req, res) => {
  const token = tokenParam(req);
  const rec = agent.get(token);
  if (!rec) return res.status(404).json({ error: 'this token has no agent', code: 'NOT_FOUND' });
  const issuedAt = new Date().toISOString();
  const wallet = String(req.query.wallet || '');
  res.json({ issuedAt, message: agent.loginMessage({ token: rec.token, wallet, issuedAt }), creator: rec.creator });
});
api.post('/agent/:token/login', writeLimit, async (req, res) => res.json(await agent.login({ token: tokenParam(req), ...(req.body || {}) })));
api.post('/agent/:token/x', creatorOnly, (req, res) => res.json(agent.setX(req.params.token, req.body?.disconnect ? null : (req.body || {}))));
api.post('/agent/:token/x/test', creatorOnly, writeLimit, async (req, res) => res.json(await agent.testX(req.params.token)));
api.post('/agent/:token/telegram', creatorOnly, (req, res) => res.json(agent.setTelegram(req.params.token, req.body?.disconnect ? null : (req.body || {}))));
api.post('/agent/:token/telegram/test', creatorOnly, writeLimit, async (req, res) => res.json(await agent.testTelegram(req.params.token)));
// Pergunte ao agente: publico, mas cada pergunta custa modelo; 5 por minuto por IP.
api.post('/agent/:token/ask', rateLimit(5, 60_000), async (req, res) => res.json(await agent.ask(tokenParam(req), req.body?.question)));
api.post('/agent/:token/vibe', creatorOnly, (req, res) => res.json(agent.setVibe(req.params.token, req.body?.vibe)));
api.post('/agent/:token/rules', creatorOnly, (req, res) => res.json(req.body?.applyPending ? agent.applyPendingRules(req.params.token) : agent.setRules(req.params.token, req.body || {})));
api.post('/agent/:token/avatar', creatorOnly, express.raw({ type: 'image/*', limit: '450kb' }), (req, res) => {
  if (Buffer.isBuffer(req.body) && req.body.length) return res.json(agent.setAvatar(req.params.token, { bytes: req.body }));
  res.json(agent.setAvatar(req.params.token, { url: req.body?.url }));
});
api.post('/agent/:token/release', creatorOnly, writeLimit, async (req, res) => res.json(await agent.release(req.params.token)));

// Pagina de tokens: a lista dos lancamentos com o estado vivo do mercado. Cache
// de 60s por token para nao bater na RPC a cada visita.
const infoCache = new Map();
async function cachedInfo(token) {
  const hit = infoCache.get(token);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  const value = await chain.tokenInfo(token).catch(() => null);
  infoCache.set(token, { at: Date.now(), value });
  return value;
}
api.get('/tokens', async (req, res) => {
  const list = launches.recent(req.query.limit || 100);
  const ag = agent.summaries();
  const tokens = await Promise.all(list.map(async (l) => ({ ...l, info: await cachedInfo(l.token), agent: ag[l.token.toLowerCase()] || null })));
  const totals = tokens.reduce((acc, t) => {
    if (!t.info) return acc;
    acc.marketCap += t.info.marketCap || 0;
    acc.raised += Number(t.info.raised || 0);
    if (t.info.graduated) acc.graduated++;
    return acc;
  }, { count: tokens.length, marketCap: 0, raised: 0, graduated: 0 });
  res.json({ tokens, totals: { ...totals, marketCapEth: totals.marketCap, raisedEth: totals.raised }, unit: QUOTE.symbol, venue: VENUE });
});
api.get('/launch/:id', (req, res) => res.json(launches.status(req.params.id)));
api.post('/launch/:id/bind', writeLimit, async (req, res) => res.json(await launches.bind(req.params.id, req.body?.wallet)));
api.post('/launch/:id/tx', writeLimit, async (req, res) => res.json(await launches.submitted(req.params.id, req.body?.hash)));

app.use('/api', api);

// ---------------------------------------------------------------------------
// Site. As paginas HTML sao templates: {{#pons}}...{{/pons}} e
// {{#argus}}...{{/argus}} ficam ou somem conforme o venue; {{CHAVE}} vira texto.
const VARS = {
  VENUE: VENUE, VENUE_NAME: chain.NAME, VENUE_SHORT: chain.SHORT, CHAIN_NAME: CHAIN.name, CHAIN_ID: String(CHAIN.id),
  UNIT: QUOTE.symbol, MARKET: chain.MARKET, VENUE_DOCS: chain.DOCS_URL, TOKEN_SITE: TOKEN_URL.replace('/{token}', '').replace('{token}', ''),
  EXAMPLE_DEV_BUY: VENUE === 'argus' ? '20 USDC' : '0.05 ETH', EXAMPLE_BUY: VENUE === 'argus' ? '10 USDC' : '0.01 ETH',
};
// Marca da Uniswap (svg oficial do repositorio brand-assets, sem cores) para a faixa "built on".
try { VARS.UNISWAP_ICON = fs.readFileSync(path.join(publicDir, 'brand', 'uniswap-mark.svg'), 'utf8'); } catch { VARS.UNISWAP_ICON = ''; }
const pageCache = new Map();
function renderPage(file) {
  const abs = path.join(publicDir, file);
  const stat = fs.statSync(abs);
  const hit = pageCache.get(file);
  if (hit && hit.mtime === stat.mtimeMs) return hit.html;
  let html = fs.readFileSync(abs, 'utf8');
  for (const v of ['pons', 'argus']) {
    const re = new RegExp(`\\{\\{#${v}\\}\\}([\\s\\S]*?)\\{\\{/${v}\\}\\}`, 'g');
    html = html.replace(re, (_, body) => (v === VENUE ? body : ''));
  }
  html = html.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in VARS ? VARS[k] : m));
  pageCache.set(file, { mtime: stat.mtimeMs, html });
  return html;
}
const PAGES = { '/': 'index.html', '/how': 'how.html', '/tokens': 'tokens.html', '/docs': 'docs.html', '/support': 'support.html', '/privacy': 'privacy.html', '/terms': 'terms.html' };
const sendPage = (file) => (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.type('html').send(renderPage(file)); };
for (const [route, file] of Object.entries(PAGES)) { app.get(route, sendPage(file)); app.get(`${route === '/' ? '/index' : route}.html`, sendPage(file)); }
app.get('/l/:id', sendPage('launch.html'));
app.get('/t/:token', sendPage('agent.html'));
app.use('/avatars', express.static(path.join(DATA_DIR, 'avatars'), { maxAge: '1h', index: false }));
// JS e CSS sempre revalidam (o navegador pergunta e recebe 304 se nada
// mudou); so imagens da marca ficam em cache longo.
app.use(express.static(publicDir, {
  index: false,
  setHeaders: (res, filePath) => {
    res.setHeader('Cache-Control', /\.(png|jpg|gif|webp|svg|ico)$/i.test(filePath) ? 'public, max-age=86400' : 'no-cache');
  },
}));

// Erros: os de usuario viram 4xx com mensagem; o resto vira 500 sem vazar nada.
app.use((err, _req, res, _next) => {
  if (err instanceof launches.UserError) {
    const code = err.code === 'NOT_FOUND' ? 404 : 400;
    return res.status(code).json({ error: err.message, code: err.code });
  }
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON' });
  console.error('[http]', err);
  res.status(500).json({ error: 'internal error' });
});

launches.prune();
launches.hooks.handoverConfirmed = (rec) => agent.activate(rec.token, rec.agent);
launches.resumeWatchers();
agent.startLoop();
// Poda de hora em hora; observadores que ficaram de fora (teto) voltam a cada 5 min.
setInterval(() => { try { launches.prune(); } catch (e) { console.error('[prune]', e); } }, 3600_000).unref();
setInterval(() => { try { launches.resumeWatchers(); } catch (e) { console.error('[watch]', e); } }, 300_000).unref();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${APP_NAME} ${VERSION} on ${PUBLIC_URL} (${chain.NAME} on ${CHAIN.name}, chain ${CHAIN.id})`);
  console.log(`  MCP endpoint : ${PUBLIC_URL}/mcp`);
  console.log(`  data dir     : ${DATA_DIR}`);
  if (!agentsEnabled()) console.log('  agents       : disabled (set AGENT_SECRET to enable)');
});
