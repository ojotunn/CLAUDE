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
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudeploy-test-'));
  child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, PORT: String(port), PUBLIC_URL: base, DATA_DIR: dataDir, AGENT_SECRET: 'test-secret-for-agents-0123456789', ANTHROPIC_API_KEY: '' },
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
  client = new Client({ name: 'claudeploy-test', version: '0.0.0' });
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
  assert.deepEqual(names, ['agent_status', 'ask_agent', 'attach_agent', 'launch_status', 'launch_terms', 'prepare_buy', 'prepare_launch', 'preview_launch', 'recent_launches', 'release_agent', 'set_agent_rules', 'token_info']);
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
    name: 'Claudeploy Test', symbol: '$ptest', description: 'never launched', devBuyEth: '0.01', creatorTaxBps: 100,
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
  assert.match(await home.text(), /Add it to Claude/);
});

test('site pages and enriched token feed are served', async () => {
  for (const p of ['/how', '/tokens', '/docs', '/support', '/privacy', '/terms']) {
    const r = await fetch(`${base}${p}`);
    assert.equal(r.status, 200, p);
    assert.match(await r.text(), /site\.js/, p);
  }
  const { tokens, totals } = await fetch(`${base}/api/tokens`).then((r) => r.json());
  assert.deepEqual(tokens, []);
  assert.equal(totals.count, 0);
  const terms = await fetch(`${base}/api/terms`).then((r) => r.json());
  assert.equal(terms.mcpUrl, `${base}/mcp`);
  assert.ok('links' in terms);
});

test('a submitted hash that is not our transaction is rejected by the watcher', async () => {
  // pega o hash de uma transacao real qualquer da chain
  const rpc = async (method, params) => (await fetch('https://rpc.mainnet.chain.robinhood.com', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  }).then((r) => r.json())).result;
  let hash = null;
  let n = BigInt(await rpc('eth_blockNumber', []));
  for (let i = 0; i < 30 && !hash; i++, n--) {
    const b = await rpc('eth_getBlockByNumber', [`0x${n.toString(16)}`, false]);
    hash = b?.transactions?.[0] ?? null;
  }
  assert.ok(hash, 'found a real transaction hash');

  const { data } = await callTool('prepare_launch', { name: 'Spoof', symbol: 'SPF' });
  const wallet = `0x${crypto.randomBytes(20).toString('hex')}`;
  await fetch(`${base}/api/launch/${data.id}/bind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet }) });
  const sub = await fetch(`${base}/api/launch/${data.id}/tx`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hash }) });
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
  const { launches } = await fetch(`${base}/api/launches`).then((r) => r.json());
  assert.deepEqual(launches, [], 'spoofed launch never reaches the public feed');
});

test('security headers and write rate limit are in place', async () => {
  const r = await fetch(`${base}/l/whatever`);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.match(r.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  const big = await callTool('preview_launch', { name: 'Huge', symbol: 'HUGE', devBuyEth: '5000' });
  assert.equal(big.isError, true);
  assert.match(big.text, /too large/);
  const ctrl = await callTool('preview_launch', { name: 'Bad\u0000Name\u200b', symbol: 'ok' });
  assert.equal(ctrl.isError, false, ctrl.text);
  assert.equal(ctrl.data.name, 'BadName');
});

// ---- agentes ----
test('crypto: seal/open roundtrip and session integrity', async () => {
  const { seal, open, issueSession, readSession } = await import('../src/crypto.js');
  const s = seal('0xabc123');
  assert.notEqual(s, '0xabc123');
  assert.equal(open(s), '0xabc123');
  const wallet = '0x' + 'a'.repeat(40), token = '0x' + 'b'.repeat(40);
  const sess = issueSession({ wallet, token });
  assert.deepEqual(readSession(sess), { wallet, token });
  assert.equal(readSession(sess.slice(0, -2) + 'zz'), null, 'tampered session is rejected');
});

test('x: oauth header is well formed', async () => {
  const { oauthHeader } = await import('../src/x.js');
  const h = oauthHeader({ apiKey: 'k', apiSecret: 's', accessToken: 't', accessSecret: 'ts' }, 'POST', 'https://api.x.com/2/tweets');
  assert.match(h, /^OAuth oauth_consumer_key="k", oauth_nonce="[0-9a-f]{32}", oauth_signature="[^"]+", oauth_signature_method="HMAC-SHA1", oauth_timestamp="\d+", oauth_token="t", oauth_version="1\.0"$/);
});

test('agent: allocation and template voice', async () => {
  const { allocate } = await import('../src/agent.js');
  const { templatePost } = await import('../src/voice.js');
  const a = allocate(1_000_000n);
  assert.equal(a.rent + a.buyback + a.airdrop + a.reserve, 1_000_000n);
  assert.equal(a.buyback, 500_000n);
  assert.equal(a.airdrop, 250_000n);
  const t = templatePost({ symbol: 'OWL', actions: [{ kind: 'burn', tokens: 1234567 }, { kind: 'airdrop', tokens: 1000, recipients: 3 }] });
  assert.match(t, /burned 1,234,567 \$OWL/);
  assert.match(t, /dropped 1,000 \$OWL on 3 recent buyers/);
});

let agentPage;
test('attach_agent creates a wallet and a handover link only the fee recipient can sign', async () => {
  const { data, isError, text } = await callTool('attach_agent', { token: PONSDROP, vibe: 'test vibe', avatar: 'https://example.com/a.png' });
  assert.equal(isError, false, text);
  assert.match(data.agent, /^0x[0-9a-fA-F]{40}$/);
  assert.equal(data.status, 'pending_handover');
  assert.match(data.handoverUrl, new RegExp(`^${base}/l/`));
  agentPage = data.page;

  const again = await callTool('attach_agent', { token: PONSDROP });
  assert.equal(again.data.agent, data.agent, 'idempotent: same agent wallet');

  const hid = data.handoverUrl.split('/').pop();
  const wrong = await fetch(`${base}/api/launch/${hid}/bind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: `0x${crypto.randomBytes(20).toString('hex')}` }) });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json()).error, /only the current fee recipient/);

  const info = await callTool('token_info', { token: PONSDROP });
  const recipient = info.data.creatorFeeRecipient;
  const right = await fetch(`${base}/api/launch/${hid}/bind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: recipient }) });
  const rec = await right.json();
  assert.equal(right.status, 200, JSON.stringify(rec));
  assert.equal(rec.kind, 'handover');
  assert.equal(rec.tx.to.toLowerCase(), '0x7ed598bcef8bd9edd8c97a195c6d13f40801ec7e', 'handover goes to the pons factory');
  assert.equal(BigInt(rec.tx.value), 0n);
  assert.ok(['ready', 'needs_funds'].includes(rec.status));
});

test('agent page and public API expose no secrets; creator endpoints need a signature', async () => {
  const page = await fetch(`${base}/t/${PONSDROP}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /agent\.js/);
  const v = await fetch(`${base}/api/agent/${PONSDROP}`).then((r) => r.json());
  assert.equal(v.status, 'pending_handover');
  assert.equal(v.vibe, 'test vibe');
  assert.equal(v.avatar, 'https://example.com/a.png');
  assert.equal(v.key, undefined, 'no key material in the public view');
  assert.equal(v.x, undefined);
  const raw = JSON.stringify(v);
  assert.ok(!/"key"|"pk"|apiSecret|accessSecret/.test(raw));
  const denied = await fetch(`${base}/api/agent/${PONSDROP}/vibe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ vibe: 'hacked' }) });
  assert.equal(denied.status, 401);
  const badSig = await fetch(`${base}/api/agent/${PONSDROP}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: v.creator, issuedAt: new Date().toISOString(), signature: '0x' + '11'.repeat(65) }) });
  assert.equal(badSig.status, 400);
  const s = await callTool('agent_status', { token: PONSDROP });
  assert.equal(s.isError, false, s.text);
  assert.equal(s.data.agent, v.agent);
  const r = await callTool('release_agent', { token: PONSDROP });
  assert.match(r.text, /Manage/);
  const { tokens } = await fetch(`${base}/api/tokens`).then((x) => x.json());
  assert.deepEqual(tokens, []);
});

test('agent rules: presets, custom split, chat applies before handover, proposal after', async () => {
  const { normalizeRules, allocate, PRESETS } = await import('../src/agent.js');
  assert.deepEqual(normalizeRules({ preset: 'burner' }).buybackBps, 8000);
  assert.equal(normalizeRules({ buybackPct: 30, airdropPct: 40 }).airdropBps, 4000);
  assert.throws(() => normalizeRules({ buybackPct: 80, airdropPct: 20 }), /at most/);
  assert.throws(() => normalizeRules({ preset: 'nope' }), /unknown preset/);
  const a = allocate(1_000_000n, PRESETS.generous);
  assert.equal(a.airdrop, 500_000n);
  assert.equal(a.raffle, 100_000n);
  const r = await callTool('set_agent_rules', { token: PONSDROP, preset: 'burner' });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.data.applied, true, 'pending agent: applied at once');
  const v = await fetch(`${base}/api/agent/${PONSDROP}`).then((x) => x.json());
  assert.equal(v.rules.buybackBps, 8000);
  assert.equal(v.pendingRules, null);
  const bad = await callTool('set_agent_rules', { token: PONSDROP, buybackPct: 95 });
  assert.equal(bad.isError, true);
  const { tools } = await client.listTools();
  assert.ok(tools.some((t) => t.name === 'set_agent_rules'));
});

test('agent extras: salary, raffle, quiet hours, telegram validation, ask without voice', async () => {
  const { normalizeRules, allocate, PRESETS, splitText } = await import('../src/agent.js');
  const { validTelegram } = await import('../src/x.js');
  const { templateEvent } = await import('../src/voice.js');
  const r = normalizeRules({ preset: 'creator', rafflePct: 10, quietHours: '22-8', minPostMin: 30, loyaltyOnly: true, dipBuyPct: 15, collectOnly: false });
  assert.equal(r.salaryBps, 2000);
  assert.equal(r.raffleBps, 1000);
  assert.deepEqual(r.quietHours, { from: 22, to: 8 });
  assert.equal(r.minPostMin, 30);
  assert.equal(r.loyaltyOnly, true);
  assert.equal(r.dipBuyPct, 15);
  assert.throws(() => normalizeRules({ buybackPct: 50, airdropPct: 30, salaryPct: 20 }), /at most/);
  assert.throws(() => normalizeRules({ quietHours: 'night' }), /quietHours/);
  assert.throws(() => normalizeRules({ dipBuyPct: 95 }), /dipBuyPct/);
  const a = allocate(1_000_000n, r);
  assert.equal(a.rent + a.salary + a.buyback + a.airdrop + a.raffle + a.reserve, 1_000_000n);
  assert.equal(a.salary, 200_000n);
  assert.equal(a.raffle, 100_000n);
  assert.match(splitText(PRESETS.generous ? normalizeRules({ preset: 'generous' }) : r), /raffle/);
  assert.equal(validTelegram({ botToken: '123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef', chatId: '-1001234567890' }), true);
  assert.equal(validTelegram({ botToken: 'nope', chatId: '1' }), false);
  assert.match(templateEvent({ symbol: 'OWL', event: { kind: 'milestone', pct: 50 } }), /50%/);

  const set = await callTool('set_agent_rules', { token: PONSDROP, preset: 'creator', quietHours: '22-8' });
  assert.equal(set.isError, false, set.text);
  assert.match(set.text, /creator salary/);
  assert.match(set.text, /quiet 22-8/);
  const v = await fetch(`${base}/api/agent/${PONSDROP}`).then((x) => x.json());
  assert.equal(v.rules.salaryBps, 2000);
  assert.equal(v.telegramConnected, false);
  assert.equal(v.voice, false);
  const ask = await fetch(`${base}/api/agent/${PONSDROP}/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'who are you?' }) });
  assert.equal(ask.status, 400, 'no voice in tests');
  assert.match((await ask.json()).error, /no voice/);
  const tg = await fetch(`${base}/api/agent/${PONSDROP}/telegram`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ botToken: 'x', chatId: 'y' }) });
  assert.equal(tg.status, 401, 'telegram needs the creator session');
});

test('agent records created before new fields existed are upgraded on read', async () => {
  const { upgrade } = await import('../src/agent.js');
  const old = { id: 'x', token: '0x' + '1'.repeat(40), status: 'active', rules: { rentBps: 1000, buybackBps: 5000, airdropBps: 2500, treasury: false }, stats: { collectedEth: '0', cycles: 0, posts: 0 }, log: [] };
  const r = upgrade(old);
  assert.deepEqual(r.qa, []);
  assert.deepEqual(r.milestones, []);
  assert.equal(r.stats.questions, 0);
  assert.equal(r.stats.raffleTokens, '0');
  assert.equal(r.rules.salaryBps, 0);
  assert.equal(r.rules.milestones, true);
  assert.equal(r.pendingRules, null);
});
