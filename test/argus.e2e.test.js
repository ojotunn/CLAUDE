// Prova ponta a ponta do venue Argus (Arc): sobe o servidor com VENUE=argus numa
// porta livre, conecta um cliente MCP como o Claude faria e exercita o caminho
// inteiro contra a mainnet da Arc (so leitura + simulacao; nada e assinado).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const ARCOS = '0x22a4f446c096775d774c9eb8617f078bea16eacf';   // token real da Argus (token e currency0)
const CRCL = '0xb9264179fb75ff6dd25a7144fd50e1592681a170';    // token real da Argus (token e currency1)
const PORTAL = '0xb021be536808f551b31789422fd28a6c9c6e97da';
const UR = '0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1';
let child, base, client, dataDir;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function callTool(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  return { res, text, data: res.structuredContent ?? null, isError: !!res.isError };
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeploy-argus-test-'));
  child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, VENUE: 'argus', PORT: String(port), PUBLIC_URL: base, DATA_DIR: dataDir, AGENT_SECRET: 'test-secret-for-agents-0123456789', ANTHROPIC_API_KEY: '', TREASURY_ADDRESS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch {}
    await sleep(100);
    if (i === 149) throw new Error(`server did not start:\n${out}`);
  }
  client = new Client({ name: 'claudeploy-argus-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
});

after(async () => {
  try { await client?.close(); } catch {}
  child?.kill();
  await sleep(200);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

test('MCP handshake exposes the tools with Argus fields', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['agent_status', 'ask_agent', 'attach_agent', 'launch_status', 'launch_terms', 'prepare_buy', 'prepare_launch', 'preview_launch', 'recent_launches', 'release_agent', 'set_agent_rules', 'token_info']);
  const preview = tools.find((t) => t.name === 'preview_launch');
  for (const k of ['name', 'devBuy', 'buyTaxPct', 'sellTaxPct', 'creatorShare', 'holdersShare', 'withAgent', 'vibe']) assert.ok(preview.inputSchema.properties[k], `schema has ${k}`);
  assert.equal(preview.inputSchema.properties.creatorFeeRecipient, undefined, 'no fee recipient field on Argus');
});

test('launch_terms reads the live Argus terms on Arc', async () => {
  const { data, isError, text } = await callTool('launch_terms');
  assert.equal(isError, false, text);
  assert.equal(data.chainId, 5042);
  assert.equal(data.unit, 'USDC');
  assert.equal(data.launchFee, '0');
  assert.equal(Number(data.supply), 1_000_000_000);
  assert.equal(data.maxCreatorTaxBps, 1000);
  assert.ok(data.tokensLaunchedOnArgus > 30000, 'Argus has launched tens of thousands of tokens');
  assert.equal(data.contracts.portal.toLowerCase(), PORTAL);
});

test('preview_launch simulates a launch with a dev buy, taxes and split', async () => {
  const { data, isError, text } = await callTool('preview_launch', {
    name: 'Claudeploy Test', symbol: '$ptest', description: 'never launched', devBuy: '5', buyTaxPct: 3, sellTaxPct: 5, creatorShare: 70, burnShare: 20, liquidityShare: 10,
  });
  assert.equal(isError, false, text);
  assert.equal(data.symbol, 'PTEST');
  assert.equal(data.unit, 'USDC');
  assert.equal(data.taxes.buyTax, '3.00%');
  assert.equal(data.taxes.sellTax, '5.00%');
  assert.deepEqual(data.taxes.split, { creatorBps: 7000, burnBps: 2000, holdersBps: 0, liquidityBps: 1000 });
  assert.ok(data.devBuy, 'has dev buy');
  assert.ok(Number(data.devBuy.tokens.replace(/,/g, '')) > 1_000_000, 'five dollars buys over a million tokens at the opening price');
  assert.equal(data.devBuy.unit, 'USDC');
  assert.equal(data.cost.devBuy, '5');
  assert.equal(data.cost.total, '5');
  assert.equal(data.cost.launchFee, '0');
  assert.match(data.route, /portal/);
  assert.match(data.graduatesAt, /45,000/);
});

test('preview_launch without dev buy and with defaults (3%/3%, 100% creator)', async () => {
  const { data, isError, text } = await callTool('preview_launch', { name: 'Bare', symbol: 'BARE' });
  assert.equal(isError, false, text);
  assert.equal(data.devBuy, null);
  assert.equal(data.taxes.buyTax, '3.00%');
  assert.deepEqual(data.taxes.split, { creatorBps: 10000, burnBps: 0, holdersBps: 0, liquidityBps: 0 });
});

test('preview_launch clamps an oversized dev buy to 5% of supply', async () => {
  const { data, isError, text } = await callTool('preview_launch', { name: 'Whale', symbol: 'WHALE', devBuy: '5000' });
  assert.equal(isError, false, text);
  assert.ok(data.warnings.some((w) => /reduced/.test(w)), `expected a clamp warning, got ${JSON.stringify(data.warnings)}`);
  assert.ok(Number(data.devBuy.amount) < 5000);
  assert.ok(parseFloat(data.devBuy.shareOfSupply) <= 5);
});

test('preview_launch rejects what Argus rejects, with a readable error', async () => {
  const noTax = await callTool('preview_launch', { name: 'Free', symbol: 'FREE', buyTaxPct: 0, sellTaxPct: 0 });
  assert.equal(noTax.isError, true);
  assert.match(noTax.text, /at least one/);
  const badSplit = await callTool('preview_launch', { name: 'Split', symbol: 'SPLT', creatorShare: 60, holdersShare: 30 });
  assert.equal(badSplit.isError, true);
  assert.match(badSplit.text, /add up/);
  const tooHigh = await callTool('preview_launch', { name: 'Tax', symbol: 'TAX', buyTaxPct: 12 });
  assert.equal(tooHigh.isError, true);
  assert.match(tooHigh.text, /maximum/i);
  // fatia para holders: so lancadores cadastrados pela Argus (rewardMode no launchConfig)
  const holders = await callTool('preview_launch', { name: 'Div', symbol: 'DIV', creatorShare: 70, holdersShare: 30 });
  assert.equal(holders.isError, true);
  assert.match(holders.text, /registered by Argus/);
  const empty = await callTool('preview_launch', { name: '', symbol: 'X' });
  assert.equal(empty.isError, true);
  assert.match(empty.text, /name/);
});

let launchId;
test('prepare_launch returns a signing link', async () => {
  const { data, isError, text } = await callTool('prepare_launch', {
    name: 'Night Owl', symbol: 'OWL', description: 'ships at 3am', devBuy: '5', twitter: 'https://x.com/nightowl', website: 'https://nightowl.xyz',
  });
  assert.equal(isError, false, text);
  launchId = data.id;
  assert.equal(data.kind, 'launch');
  assert.equal(data.url, `${base}/l/${data.id}`);
  assert.match(text, /Send the user this link/);
});

test('signing page binds a wallet: predicted token, portal calldata, approval step, USDC funding check', async () => {
  const page = await fetch(`${base}/l/${launchId}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /launch\.js/);

  const wallet = `0x${crypto.randomBytes(20).toString('hex')}`;
  const res = await post(`${base}/api/launch/${launchId}/bind`, { wallet });
  const rec = await res.json();
  assert.equal(res.status, 200, JSON.stringify(rec));
  assert.equal(rec.wallet.toLowerCase(), wallet);
  assert.match(rec.predicted.token, /^0x[0-9a-fA-F]{40}$/);
  assert.match(rec.predicted.curve, /^0x[0-9a-fA-F]{40}$/, 'the splitter is predicted too');
  assert.equal(rec.tx.to.toLowerCase(), PORTAL, 'the launch goes to the Argus portal');
  assert.match(rec.tx.data, /^0x11b8f0f1[0-9a-f]+$/, 'launch selector');
  assert.equal(BigInt(rec.tx.value), 0n, 'no native value: USDC is pulled from an approval');
  assert.equal(rec.pre.length, 1, 'one approval step for the dev buy');
  assert.equal(rec.pre[0].to.toLowerCase(), '0x3600000000000000000000000000000000000000');
  assert.equal(rec.funding.ok, false, 'a random wallet has no USDC');
  assert.equal(rec.funding.unit, 'USDC');
  assert.match(rec.funding.message, /USDC/);
  assert.equal(rec.status, 'needs_funds');
  assert.equal(rec.creatorFeeRecipient.toLowerCase(), wallet, 'the signer is the creator');
  assert.equal(rec.unit, 'USDC');

  // A mesma carteira e o mesmo salt precisam dar o mesmo endereco.
  const again = await post(`${base}/api/launch/${launchId}/bind`, { wallet }).then((r) => r.json());
  assert.equal(again.predicted.token, rec.predicted.token);
  assert.equal(again.predicted.curve, rec.predicted.curve);
});

test('launch_status reflects the bound wallet', async () => {
  const { data, isError, text } = await callTool('launch_status', { id: launchId });
  assert.equal(isError, false, text);
  assert.equal(data.status, 'needs_funds');
  assert.ok(data.predicted.token);
  assert.equal(data.token, null, 'no contract address before the transaction is confirmed');
});

test('token_info reads real Argus tokens on both sides of the pool', async () => {
  const a = await callTool('token_info', { token: ARCOS });
  assert.equal(a.isError, false, a.text);
  assert.equal(a.data.symbol, 'ARCOS');
  assert.equal(Number(a.data.totalSupply), 1_000_000_000);
  assert.equal(a.data.unit, 'USDC');
  assert.ok(a.data.price > 0 && a.data.price < 1, 'price in USD per token');
  assert.ok(a.data.marketCap > 1000, 'market cap in USD');
  assert.equal(a.data.buyTaxBps, 300);
  assert.deepEqual(a.data.split, { creatorBps: 10000, burnBps: 0, holdersBps: 0, liquidityBps: 0 });
  assert.equal(a.data.tokenIsCurrency0, true);
  assert.ok(a.data.links.venue.includes(a.data.token));
  const b = await callTool('token_info', { token: CRCL });
  assert.equal(b.isError, false, b.text);
  assert.equal(b.data.tokenIsCurrency0, false);
  assert.ok(b.data.price > 0);
  const notArgus = await callTool('token_info', { token: '0x3600000000000000000000000000000000000000' });
  assert.equal(notArgus.isError, true);
});

test('prepare_buy quotes a swap through the Universal Router and binds with Permit2 steps', async () => {
  const { data, isError, text } = await callTool('prepare_buy', { token: ARCOS, amount: '5' });
  assert.equal(isError, false, text);
  assert.equal(data.summary.symbol, 'ARCOS');
  assert.equal(data.summary.unit, 'USDC');
  assert.ok(Number(data.summary.spend.tokens.replace(/,/g, '')) > 100_000);

  const wallet = `0x${crypto.randomBytes(20).toString('hex')}`;
  const rec = await post(`${base}/api/launch/${data.id}/bind`, { wallet }).then((r) => r.json());
  assert.equal(rec.kind, 'buy');
  assert.equal(rec.tx.to.toLowerCase(), UR, 'the swap goes to the Universal Router');
  assert.match(rec.tx.data, /^0x3593564c/, 'execute(bytes,bytes[],uint256)');
  assert.equal(BigInt(rec.tx.value), 0n);
  assert.equal(rec.pre.length, 2, 'a fresh wallet needs the two Permit2 approvals');
  assert.equal(rec.status, 'needs_funds');
  assert.match(rec.funding.message, /USDC/);
  // token do outro lado da pool (currency1) tambem cota
  const c = await callTool('prepare_buy', { token: CRCL, amount: '5' });
  assert.equal(c.isError, false, c.text);
});

test('launch with an agent: the agent wallet is the creator; the owner funds it', async () => {
  const { data, isError, text } = await callTool('prepare_launch', { name: 'Owl Agent', symbol: 'OWLA', devBuy: '5', withAgent: true, vibe: 'dry humor', preset: 'creator' });
  assert.equal(isError, false, text);
  assert.equal(data.kind, 'agent-launch');
  assert.match(data.agent.address, /^0x[0-9a-fA-F]{40}$/);
  assert.match(data.agent.predictedToken, /^0x[0-9a-fA-F]{40}$/);
  assert.match(text, /fund it/);
  const predicted = data.agent.predictedToken;

  // pagina do agente ja existe, esperando o dinheiro
  const v = await fetch(`${base}/api/agent/${predicted}`).then((r) => r.json());
  assert.equal(v.status, 'pending_funding');
  assert.equal(v.agent, data.agent.address);
  assert.equal(v.permanentRole, true);
  assert.equal(v.unit, 'USDC');
  assert.equal(v.rules.salaryBps, 2000, 'preset creator applied at creation');
  assert.equal(v.fundingUrl, data.url);
  assert.equal(v.key, undefined);

  // regras mudam de imediato antes do financiamento
  const rules = await callTool('set_agent_rules', { token: predicted, preset: 'burner' });
  assert.equal(rules.isError, false, rules.text);
  assert.equal(rules.data.applied, true);

  // o dono conecta: a transacao e uma transferencia de USDC para a carteira do agente
  const wallet = `0x${crypto.randomBytes(20).toString('hex')}`;
  const rec = await post(`${base}/api/launch/${data.id}/bind`, { wallet }).then((r) => r.json());
  assert.equal(rec.kind, 'agent-launch');
  assert.equal(rec.tx.to.toLowerCase(), data.agent.address.toLowerCase());
  assert.equal(rec.tx.data, '0x');
  assert.equal(BigInt(rec.tx.value), 8n * 10n ** 18n, 'dev buy 5 USDC + 3 USDC kickstart, as native value');
  assert.equal(rec.agent.budget, '8');
  assert.equal(rec.predicted.token, predicted, 'the token predicted from the agent wallet');
  assert.equal(rec.status, 'needs_funds');
  assert.match(rec.funding.message, /USDC/);

  // attach_agent nao existe na Argus
  const att = await callTool('attach_agent', { token: ARCOS });
  assert.equal(att.isError, true);
  assert.match(att.text, /withAgent/);
  const rel = await callTool('release_agent', { token: predicted });
  assert.match(rel.text, /forwarding|forwards/);
});

test('HTTP guards, pages rendered for the Argus venue, no template markers leak', async () => {
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  assert.equal((await fetch(`${base}/api/launch/nope`)).status, 404);
  const { launches } = await fetch(`${base}/api/launches`).then((r) => r.json());
  assert.deepEqual(launches, []);
  for (const p of ['/', '/how', '/tokens', '/docs', '/support', '/privacy', '/terms']) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 200, p);
    const html = await r.text();
    assert.match(html, /site\.js/, p);
    assert.ok(!/\{\{#|\{\{\/|\{\{[A-Z_]+\}\}/.test(html), `no template markers on ${p}`);
    // o /docs cita a pons de proposito (o outro deploy e o changelog); as outras paginas nao
    if (p !== '/docs') assert.ok(!/Robinhood|pons v2|launch-and-buy router/.test(html), `no pons copy on ${p}`);
  }
  const docs = await fetch(`${base}/docs`).then((r) => r.text());
  assert.match(docs, /Argus portal/);
  assert.ok(!/pons launch-and-buy router together/.test(docs));
  const home = await fetch(`${base}/`).then((r) => r.text());
  assert.match(home, /Argus/);
  assert.match(home, /Add it to Claude/);
  assert.match(home, /Uniswap v4/);
  const terms = await fetch(`${base}/api/terms`).then((r) => r.json());
  assert.equal(terms.mcpUrl, `${base}/mcp`);
  assert.equal(terms.venue.id, 'argus');
  assert.equal(terms.chain.native.symbol, 'USDC');
  assert.equal(terms.unit, 'USDC');
  const { tokens, totals } = await fetch(`${base}/api/tokens`).then((r) => r.json());
  assert.deepEqual(tokens, []);
  assert.equal(totals.count, 0);
});

test('a submitted hash that is not our transaction is rejected by the watcher', async () => {
  const rpc = async (method, params) => (await fetch('https://rpc.mainnet.arc.io', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json())).result;
  let hash = null;
  let n = BigInt(await rpc('eth_blockNumber', []));
  for (let i = 0; i < 60 && !hash; i++, n--) {
    const b = await rpc('eth_getBlockByNumber', [`0x${n.toString(16)}`, false]);
    hash = b?.transactions?.[0] ?? null;
  }
  assert.ok(hash, 'found a real transaction hash');

  const { data } = await callTool('prepare_launch', { name: 'Spoof', symbol: 'SPF' });
  const wallet = `0x${crypto.randomBytes(20).toString('hex')}`;
  await post(`${base}/api/launch/${data.id}/bind`, { wallet });
  const sub = await post(`${base}/api/launch/${data.id}/tx`, { hash });
  assert.equal(sub.status, 200);
  let rec;
  for (let i = 0; i < 30; i++) {
    rec = await fetch(`${base}/api/launch/${data.id}`).then((r) => r.json());
    if (rec.status === 'failed') break;
    await sleep(1000);
  }
  assert.equal(rec.status, 'failed');
  assert.match(rec.error, /not the one prepared/);
  assert.equal(rec.token, null);
});

test('security headers and input limits', async () => {
  const r = await fetch(`${base}/l/whatever`);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  const big = await callTool('preview_launch', { name: 'Huge', symbol: 'HUGE', devBuy: '5000000' });
  assert.equal(big.isError, true);
  assert.match(big.text, /too large/);
  const ctrl = await callTool('preview_launch', { name: 'Bad Name​', symbol: 'ok' });
  assert.equal(ctrl.isError, false, ctrl.text);
  assert.equal(ctrl.data.name, 'BadName');
});

test('argus math: tick math, initial liquidity and swap output match chain values', async () => {
  process.env.VENUE = 'argus';
  const a = await import('../src/venues/argus.js');
  const m = a._math;
  assert.equal(m.sqrtAtTick(-405400).toString(16), '6c3c5ba175690d02e', 'sqrt price at the opening tick (token = currency0) equals the pool init value');
  const p0 = m.initialLiquidity(true);
  assert.equal(p0.L.toString(16), '15dba887cc46b791', 'initial liquidity equals the minted position');
  assert.equal(p0.tick, -405400);
  const p1 = m.initialLiquidity(false);
  assert.equal(p1.tick, 405400);
  // dev buy real: 200 USDC no token 0x3C372285... (currency1, taxa 3%) deu 71,697,779.185 tokens
  const out = m.swapOut({ sqrtP: p1.sqrtP, L: p1.L, amountIn: 200_000000n, tokenIsCurrency0: false, buyTaxBps: 300 });
  assert.equal(Number(out) / 1e18 > 71_697_000 && Number(out) / 1e18 < 71_698_500, true, `real dev buy reproduced (${Number(out) / 1e18})`);
  // salt do hook minerado cai nos bits 0x2044
  const salt = m.saltFor('0x2afba891c66fdeee3041926ac631ebad26604bad', '0xf43f5b4e92f90306e906c1670493f942fb3f8034337d756466f915557a722acd');
  assert.match(salt, /^0x[0-9a-f]{64}$/);
});
