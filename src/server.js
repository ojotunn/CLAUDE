// Servidor HTTP do Pronto: endpoint MCP (Claude), API da pagina de assinatura e
// o site estatico. Uma porta so.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { PORT, PUBLIC_URL, CHAIN, CONTRACTS, LIMITS, APP_NAME, VERSION, DATA_DIR } from './config.js';
import { createMcpServer } from './mcp.js';
import * as chain from './chain.js';
import * as launches from './launches.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

// Limite simples por IP: o endpoint e publico e cada chamada bate na RPC.
const hits = new Map();
function rateLimit(max, windowMs) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}|${req.path.split('/')[1]}`;
    const entry = hits.get(key) || { count: 0, reset: now + windowMs };
    if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
    entry.count++;
    hits.set(key, entry);
    if (hits.size > 10_000) hits.clear();
    if (entry.count > max) return res.status(429).json({ error: 'too many requests, slow down' });
    next();
  };
}

// ---------------------------------------------------------------------------
// MCP (Streamable HTTP, sem sessao): um servidor novo por requisicao.
app.post('/mcp', rateLimit(120, 60_000), async (req, res) => {
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
  });
});

api.get('/launches', (req, res) => res.json({ launches: launches.recent(req.query.limit) }));
api.get('/launch/:id', (req, res) => res.json(launches.status(req.params.id)));
api.post('/launch/:id/bind', async (req, res) => res.json(await launches.bind(req.params.id, req.body?.wallet)));
api.post('/launch/:id/tx', async (req, res) => res.json(await launches.submitted(req.params.id, req.body?.hash)));

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

launches.resumeWatchers();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`${APP_NAME} ${VERSION} on ${PUBLIC_URL} (${CHAIN.name}, chain ${CHAIN.id})`);
  console.log(`  MCP endpoint : ${PUBLIC_URL}/mcp`);
  console.log(`  data dir     : ${DATA_DIR}`);
});
