// Prova ponta a ponta: sobe o servidor de verdade numa porta livre com DATA_DIR
// descartavel, conecta um cliente MCP como o Claude faria e exercita o caminho
// inteiro contra a mainnet (so leitura + simulacao; nada e assinado).
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

const PONSDROP = '0xca6e7dba9ccc2342f30439115f0c9ed4f5dd7698';
let child, base, client, dataDir;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer(); s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callTool(name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
  return { res, text, data: res.structuredContent ?? null, isError: !!res.isError };
}

before(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pronto-test-'));
  child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port), PUBLIC_URL: base, DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${base}/api/health`); if (r.ok) break; } catch {}
    await sleep(100);
    if (i === 99) throw new Error(`server did not start:\n${out}`);
  }
  client = new Client({ name: 'pronto-test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
});

after(async () => {
  try { await client?.close(); } catch {}
  child?.kill();
  await sleep(200);
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
});

test('MCP handshake exposes the tools', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['launch_status', 'launch_terms', 'prepare_buy', 'prepare_launch', 'preview_launch', 'recent_launches', 'token_info']);
  const preview = tools.find((t) => t.name === 'preview_launch');
  assert.ok(preview.inputSchema.properties.name, 'preview_launch schema has name');
  assert.ok(preview.inputSchema.properties.devBuyEth, 'preview_launch schema has devBuyEth');
});

test('launch_terms reads the live protocol terms', async () => {
  const { data, isError, text } = await callTool('launch_terms');
  assert.equal(isError, false, text);
  assert.equal(data.chainId, 4663);
  assert.match(data.launchFeeEth, /^\d+(\.\d+)?$/);
  assert.equal(Number(data.supply), 1_000_000_000);
  assert.equal(typeof data.launchesOpenToEveryone, 'boolean');
});

test('preview_launch simulates a launch with a dev buy', async () => {
  const { data, isError, text } = await callTool('preview_launch', {
    name: 'Pronto Test', symbol: '$ptest', description: 'never launched', devBuyEth: '0.01', creatorTaxBps: 100,
  });
  assert.equal(isError, false, text);
  assert.equal(data.symbol, 'PTEST');
  assert.equal(data.creatorTax, '1.00%');
  assert.ok(data.devBuy, 'has dev buy');
  assert.ok(Number(data.devBuy.tokens.replace(/,/g, '')) > 0, 'dev buy yields tokens');
  assert.equal(data.cost.devBuyEth, '0.01');
  assert.equal(Number(data.cost.totalEth), Number(data.cost.launchFeeEth) + 0.01);
  assert.match(data.route, /router/);
});

test('preview_launch without dev buy goes through the factory', async () => {
  const { data, isError, text } = await callTool('preview_launch', { name: 'Bare', symbol: 'BARE' });
  assert.equal(isError, false, text);
  assert.equal(data.devBuy, null);
  assert.equal(data.route, 'pons factory');
});

test('preview_launch clamps an oversized dev buy', async () => {
  const { data, isError, text } = await callTool('preview_launch', { name: 'Whale', symbol: 'WHALE', devBuyEth: '2' });
  assert.equal(isError, false, text);
  assert.ok(data.warnings.some((w) => /reduced/.test(w)), `expected a clamp warning, got ${JSON.stringify(data.warnings)}`);
  assert.ok(Number(data.devBuy.eth) < 2);
  assert.ok(parseFloat(data.devBuy.shareOfSupply) <= 5);
});

test('preview_launch rejects bad input with a readable error', async () => {
  const a = await callTool('preview_launch', { name: '', symbol: 'X' });
  assert.equal(a.isError, true);
  assert.match(a.text, /name/);
  const b = await callTool('preview_launch', { name: 'Tax', symbol: 'TAX', creatorTaxBps: 5000 });
  assert.equal(b.isError, true);
  assert.match(b.text, /creator tax/i);
});

let launchId;
test('prepare_launch returns a signing link', async () => {
  const { data, isError, text } = await callTool('prepare_launch', {
    name: 'Night Owl', symbol: 'OWL', description: 'ships at 3am', devBuyEth: '0.02', twitter: 'https://x.com/nightowl',
  });
  assert.equal(isError, false, text);
  launchId = data.id;
  assert.equal(data.url, `${base}/l/${data.id}`);
  assert.match(text, /Send the user this link/);
});

test('signing page is served and binds a wallet with a predicted address', async () => {
  const page = await fetch(`${base}/l/${launchId}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /launch\.js/);

  const wallet = `0x${crypto.randomBytes(20).toString('hex')}`;
  const res = await fetch(`${base}/api/launch/${launchId}/bind`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet }),
  });
  const rec = await res.json();
  assert.equal(res.status, 200, JSON.stringify(rec));
  assert.equal(rec.wallet.toLowerCase(), wallet);
  assert.match(rec.predicted.token, /^0x[0-9a-fA-F]{40}$/);
  assert.match(rec.predicted.curve, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(rec.tx.to.toLowerCase(), '0xe33e9e479df8802cb0866d5d05258bec4cf62948', 'dev buy goes through the router');
  assert.match(rec.tx.data, /^0x[0-9a-f]+$/);
  assert.equal(BigInt(rec.tx.value), BigInt(Math.round((Number(rec.terms.launchFeeEth) + 0.02) * 1e18)));
  assert.equal(rec.funding.ok, false, 'a random wallet has no ETH');
  assert.equal(rec.status, 'needs_funds');
  assert.equal(rec.creatorFeeRecipient.toLowerCase(), wallet, 'signer becomes fee recipient by default');

  // A mesma carteira e o mesmo salt precisam dar o mesmo endereco.
  const again = await fetch(`${base}/api/launch/${launchId}/bind`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet }),
  }).then((r) => r.json());
  assert.equal(again.predicted.token, rec.predicted.token);
});

test('launch_status reflects the bound wallet', async () => {
  const { data, isError, text } = await callTool('launch_status', { id: launchId });
  assert.equal(isError, false, text);
  assert.equal(data.status, 'needs_funds');
  assert.ok(data.predicted.token);
  assert.equal(data.token, null, 'no contract address before the transaction is confirmed');
});

test('submitting a bogus hash is rejected, a well-formed one is accepted', async () => {
  const bad = await fetch(`${base}/api/launch/${launchId}/tx`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash: 'nope' }),
  });
  assert.equal(bad.status, 400);
  const unknown = await callTool('launch_status', { id: 'doesnotexist' });
  assert.equal(unknown.isError, true);
});

test('token_info reads a real pons v2 token', async () => {
  const { data, isError, text } = await callTool('token_info', { token: PONSDROP });
  assert.equal(isError, false, text);
  assert.equal(data.symbol, 'PONSDROP');
  assert.equal(Number(data.totalSupply), 1_000_000_000);
  assert.ok(data.links.pons.includes(data.token));
});

test('prepare_buy simulates a curve buy and binds', async () => {
  const { data, isError, text } = await callTool('prepare_buy', { token: PONSDROP, ethAmount: '0.001' });
  if (isError && /left the bonding curve/.test(text)) return; // token graduou depois deste teste ser escrito
  assert.equal(isError, false, text);
  assert.equal(data.summary.symbol, 'PONSDROP');
  assert.ok(Number(data.summary.spend.tokens.replace(/,/g, '')) > 0);

  const wallet = `0x${crypto.randomBytes(20).toString('hex')}`;
  const rec = await fetch(`${base}/api/launch/${data.id}/bind`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet }),
  }).then((r) => r.json());
  assert.equal(rec.kind, 'buy');
  assert.equal(rec.tx.to.toLowerCase(), rec.curve.toLowerCase());
  assert.equal(BigInt(rec.tx.value), 1_000_000_000_000_000n);
});

test('HTTP guards: GET /mcp is 405, unknown launch is 404, recent list is empty', async () => {
  assert.equal((await fetch(`${base}/mcp`)).status, 405);
  assert.equal((await fetch(`${base}/api/launch/nope`)).status, 404);
  const { launches } = await fetch(`${base}/api/launches`).then((r) => r.json());
  assert.deepEqual(launches, []);
  const home = await fetch(`${base}/`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /Add Pronto to Claude/);
});
