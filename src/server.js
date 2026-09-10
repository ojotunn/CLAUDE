// Servidor HTTP do Pronto: endpoint MCP (Claude), API da pagina de assinatura e
// o site estatico. Uma porta so.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PORT, PUBLIC_URL, CHAIN, CONTRACTS, LIMITS, APP_NAME, VERSION, DATA_DIR, LINKS, REPO_URL } from './config.js';
import { createMcpServer } from './mcp.js';
import * as chain from './chain.js';
import * as launches from './launches.js';

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

api.get('/health', (_req, res) => res.json({ ok: true, app: APP_NAME, version: VERSION, network: CHAIN.network }));

api.get('/terms', async (_req, res) => {
  const t = await chain.protocolTerms();
  res.json({
    app: APP_NAME,
    chain: { id: CHAIN.id, name: CHAIN.name, rpc: CHAIN.rpc, explorer: CHAIN.explorer, isTestnet: CHAIN.isTestnet },
    contracts: CONTRACTS,
    launchFeeEth: t.launchFeeEth,
    supply: t.supplyTokens,
    maxCreatorTaxBps: t.maxCreatorTaxBps,
    launchEnabled: t.launchEnabled,
    graduatesAtEth: t.graduationThresholdEth,
    devBuyCapBps: LIMITS.maxDevBuyBps,
    mcpUrl: `${PUBLIC_URL}/mcp`,
    links: LINKS,
    repo: REPO_URL,
  });
});

api.get('/launches', (req, res) => res.json({ launches: launches.recent(req.query.limit) }));

// Pagina de tokens: a lista dos lancamentos com o estado vivo da curva. Cache
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
  const tokens = await Promise.all(list.map(async (l) => ({ ...l, info: await cachedInfo(l.token) })));
  const totals = tokens.reduce((acc, t) => {
    if (!t.info) return acc;
    acc.marketCapEth += t.info.marketCapEth || 0;
    acc.raisedEth += Number(t.info.raisedEth || 0);
    if (t.info.graduated) acc.graduated++;
    return acc;
  }, { count: tokens.length, marketCapEth: 0, raisedEth: 0, graduated: 0 });
  res.json({ tokens, totals });
});
api.get('/launch/:id', (req, res) => res.json(launches.status(req.params.id)));
const writeLimit = rateLimit(20, 60_000);
api.post('/launch/:id/bind', writeLimit, async (req, res) => res.json(await launches.bind(req.params.id, req.body?.wallet)));
api.post('/launch/:id/tx', writeLimit, async (req, res) => res.json(await launches.submitted(req.params.id, req.body?.hash)));

app.use('/api', api);

// ---------------------------------------------------------------------------
// Site.
app.get('/l/:id', (_req, res) => res.sendFile(path.join(publicDir, 'launch.html')));
app.use(express.static(publicDir, { extensions: ['html'], maxAge: '5m' }));

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
launches.resumeWatchers();
// Poda de hora em hora; observadores que ficaram de fora (teto) voltam a cada 5 min.
setInterval(() => { try { launches.prune(); } catch (e) { console.error('[prune]', e); } }, 3600_000).unref();
setInterval(() => { try { launches.resumeWatchers(); } catch (e) { console.error('[watch]', e); } }, 300_000).unref();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${APP_NAME} ${VERSION} on ${PUBLIC_URL} (${CHAIN.name}, chain ${CHAIN.id})`);
  console.log(`  MCP endpoint : ${PUBLIC_URL}/mcp`);
  console.log(`  data dir     : ${DATA_DIR}`);
});
