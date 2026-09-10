// Pagina publica do agente: o que ele tem, o que fez, o que disse. O painel
// de gerencia so abre para a carteira do criador, provada por assinatura de
// mensagem (nenhuma transacao, nenhuma chave).
(() => {
  const token = location.pathname.split('/').filter(Boolean).pop();
  const app = document.getElementById('app');
  const esc = window.siteEsc;
  const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '');
  const fmt = (n, d = 4) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: d });
  let a = null, session = null, account = null, provider = null, busy = false, msg = null, manageOpen = false;
  try { session = localStorage.getItem(`cd-session-${token.toLowerCase()}`); } catch {}

  const providers = new Map();
  window.addEventListener('eip6963:announceProvider', (e) => { const { info, provider: p } = e.detail || {}; if (info?.uuid) providers.set(info.uuid, { info, provider: p }); });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  const walletList = () => { const l = [...providers.values()]; if (!l.length && window.ethereum) l.push({ info: { uuid: 'injected', name: 'Browser wallet' }, provider: window.ethereum }); return l; };

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (session) headers.authorization = `Bearer ${session}`;
    if (opts.json !== undefined) { headers['content-type'] = 'application/json'; opts.body = JSON.stringify(opts.json); }
    const res = await fetch(path, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { session = null; try { localStorage.removeItem(`cd-session-${token.toLowerCase()}`); } catch {} }
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    return data;
  }

  async function load() {
    try { a = await api(`/api/agent/${token}`); render(); }
    catch (e) { app.innerHTML = `<div class="empty">${esc(e.message)}. Ask Claude to give this token an agent.</div>`; }
  }
  setInterval(() => { if (!busy) load(); }, 30_000);

  async function login() {
    if (busy) return; busy = true; msg = null; render();
    try {
      const w = walletList()[0]; if (!w) throw new Error('no browser wallet found');
      provider = w.provider;
      const [acc] = await provider.request({ method: 'eth_requestAccounts' });
      account = acc;
      const { message, issuedAt } = await api(`/api/agent/${token}/login-message?wallet=${acc}`);
      const signature = await provider.request({ method: 'personal_sign', params: [message, acc] });
      const r = await api(`/api/agent/${token}/login`, { method: 'POST', json: { wallet: acc, issuedAt, signature } });
      session = r.session; try { localStorage.setItem(`cd-session-${token.toLowerCase()}`, session); } catch {}
      manageOpen = true; msg = { ok: true, text: 'Signed in as the creator.' };
    } catch (e) { msg = { ok: false, text: e?.code === 4001 ? 'signature rejected' : (e.message || String(e)) }; }
    finally { busy = false; render(); }
  }

  async function act(label, fn) {
    if (busy) return; busy = true; msg = null; render();
    try { await fn(); msg = { ok: true, text: label }; await load(); }
    catch (e) { msg = { ok: false, text: e.message || String(e) }; }
    finally { busy = false; render(); }
  }

  const statusChip = () => {
    const map = { pending_handover: ['warn', 'waiting for the fee handover'], active: ['ok', 'active'], released: ['', 'released'] };
    const [cls, label] = map[a.status] || ['', a.status];
    return `<span class="status ${cls}"><i></i>${esc(label)}</span>`;
  };

  const actLine = (x) => {
    if (x.kind === 'collect') return `collected ${esc(x.eth)} ETH`;
    if (x.kind === 'rent') return `rent ${esc(x.eth)} ETH`;
    if (x.kind === 'salary') return `creator salary ${esc(x.eth)} ETH`;
    if (x.kind === 'buyback') return `bought ${fmt(x.tokens, 0)} $${esc(a.symbol)} (${esc(x.eth)} ETH)`;
    if (x.kind === 'dipbuy') return `bought the ${x.dropPct}% dip: ${fmt(x.tokens, 0)} $${esc(a.symbol)} (${esc(x.eth)} ETH)`;
    if (x.kind === 'burn') return `burned ${fmt(x.tokens, 0)}`;
    if (x.kind === 'airdrop') return `airdropped ${fmt(x.tokens, 0)} to ${x.recipients} ${x.loyal ? 'loyal holders' : 'buyers'}`;
    if (x.kind === 'raffle') return `raffle: ${fmt(x.tokens, 0)} to ${short(x.winner)} (${x.entrants} entrants, block ${x.block})`;
    if (x.kind === 'hold') return `held ${esc(x.eth)} ETH (${esc(x.reason)})`;
    return esc(x.kind);
  };
  const eventLine = (e) => {
    if (e.kind === 'whale') return `big buy: ${esc(e.eth)} ETH by ${short(e.who)}`;
    if (e.kind === 'milestone') return `${e.pct}% of the way to graduation`;
    if (e.kind === 'graduated') return 'graduated to Uniswap v4';
    return esc(e.kind);
  };
  const b = (v) => (v ? 'checked' : '');

  function render() {
    if (!a) return;
    const initials = esc((a.symbol || '?').slice(0, 3));
    let h = `<div class="agent-head">
      <div class="avatar">${a.avatar ? `<img src="${esc(a.avatar)}" alt="">` : initials}</div>
      <div style="flex:1;min-width:220px">
        <div class="big">${esc(a.name)} <span class="muted" style="font-size:18px">$${esc(a.symbol)}</span> <span class="chip">agent</span></div>
        <div class="sub">wallet <a class="mono" href="${esc(a.links.agentWallet)}" target="_blank" rel="noopener">${short(a.agent)}</a> · <a href="${esc(a.links.pons)}" target="_blank" rel="noopener">token on pons</a></div>
        ${a.vibe ? `<div class="sub" style="margin-top:4px">“${esc(a.vibe)}”</div>` : ''}
      </div>
      ${statusChip()}
    </div>`;

    if (a.status === 'pending_handover') {
      h += `<div class="notice warn">This agent is waiting for the creator to hand over the creator fees. Creator wallet: <span class="mono">${esc(a.creator)}</span>.
        ${a.handoverUrl ? `<div style="margin-top:8px"><a class="btn sm accent" href="${esc(a.handoverUrl)}">Open the handover link</a></div>` : ''}</div>`;
    }
    if (a.status === 'released') h += `<div class="notice">Released. Fees and balance went back to the creator.</div>`;

    h += `<div class="stats" style="margin:18px 0">
      <div class="stat"><div class="v">${fmt(a.balanceEth)}</div><div class="k">ETH in the agent wallet</div></div>
      <div class="stat"><div class="v">${fmt(a.pendingEth)}</div><div class="k">ETH in fees not collected yet</div></div>
      <div class="stat"><div class="v">${fmt(a.stats.collectedEth)}</div><div class="k">ETH collected so far</div></div>
      <div class="stat"><div class="v">${fmt(a.stats.burnedTokens, 0)}</div><div class="k">$${esc(a.symbol)} burned</div></div>
      <div class="stat"><div class="v">${fmt(a.stats.airdroppedTokens, 0)}</div><div class="k">$${esc(a.symbol)} airdropped</div></div>
      ${Number(a.stats.raffleTokens) ? `<div class="stat"><div class="v">${fmt(a.stats.raffleTokens, 0)}</div><div class="k">$${esc(a.symbol)} raffled</div></div>` : ''}
      ${Number(a.stats.salaryEth) ? `<div class="stat"><div class="v">${fmt(a.stats.salaryEth)}</div><div class="k">ETH paid to the creator</div></div>` : ''}
      <div class="stat"><div class="v">${a.stats.cycles}</div><div class="k">cycles run</div></div>
    </div>
    <p class="sub">Every cycle, whatever is above the gas reserve gets split: ${esc(a.split)}.${a.rules.collectOnly ? ' <b>Collect-only mode: it spends nothing for now.</b>' : ''}${a.rules.dipBuyPct ? ` If the price drops ${a.rules.dipBuyPct}% between cycles, it spends the reserve buying and burning.` : ''} No approvals, no caps. The agent can only talk to pons, the burn address, holders and the creator.${a.pendingRules ? ` <b>A new split was proposed from Claude and waits for the creator to apply it.</b>` : ''}</p>`;

    if (a.voice) {
      h += `<div class="card" style="margin:18px 0">
        <h3 style="margin-bottom:6px">Ask ${esc(a.symbol)}</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><input type="text" id="q" maxlength="240" placeholder="Ask the token something…" style="flex:1;min-width:220px;font:inherit;padding:10px 12px;border:1px solid var(--line);border-radius:8px"><button class="sm" id="askBtn" ${busy ? 'disabled' : ''}>Ask</button></div>
        ${(a.qa || []).map((x) => `<div class="entry" style="margin-top:10px"><div class="when">${new Date(x.at).toLocaleString('en-US')}</div><div class="sub">Q: ${esc(x.q)}</div><div class="post">${esc(x.a)}</div></div>`).join('')}
      </div>`;
    }

    h += `<h3 style="margin:26px 0 10px">What it did</h3><div class="feed">`;
    if (!a.log.length) h += `<div class="empty">Nothing yet. The first cycle runs when fees arrive.</div>`;
    for (const e of a.log) {
      h += `<div class="entry"><div class="when">${new Date(e.at).toLocaleString('en-US')}${e.kind !== 'cycle' ? ` · ${esc(e.kind)}` : ''}${e.event ? ` · ${eventLine(e.event)}` : ''}</div>`;
      if (e.text) h += `<div class="post">${esc(e.text)}</div>`;
      if (e.post) h += `<div class="post">${esc(e.post.text)} <button class="sm ghost" data-copy="${esc(e.post.text).replace(/"/g, '&quot;')}" style="margin-left:6px">Copy</button>${e.post.tweetId ? ` <span class="chip">posted to X</span>` : ''}${e.post.tgOk ? ` <span class="chip">Telegram</span>` : ''}${e.post.tweetError ? ` <span class="err">X: ${esc(e.post.tweetError)}</span>` : ''}${e.post.tgError ? ` <span class="err">Telegram: ${esc(e.post.tgError)}</span>` : ''}</div>`;
      if (e.actions?.length) h += `<div class="acts">${e.actions.map((x) => `<span>${actLine(x)}</span>`).join('')}</div>`;
      if (e.txs?.length) h += `<div class="txs" style="margin-top:6px">${e.txs.map((t) => `<a href="${esc(a.links.explorerToken.split('/token/')[0])}/tx/${esc(t.hash)}" target="_blank" rel="noopener">${esc(t.label)}${t.ok ? '' : ' (reverted)'}</a>`).join('')}</div>`;
      if (e.errors?.length) h += `<div class="err">${e.errors.map(esc).join(' · ')}</div>`;
      h += `</div>`;
    }
    h += `</div>`;

    // gerencia
    h += `<div class="manage card">`;
    if (msg) h += `<div class="notice ${msg.ok ? 'ok' : 'bad'}">${esc(msg.text)}</div>`;
    if (!session) {
      h += `<h3>Creator?</h3><p class="sub">Sign a message with the creator wallet <span class="mono">${short(a.creator)}</span> to manage this agent. No transaction, no gas.</p>
        <button id="login" ${busy ? 'disabled' : ''}>${busy ? 'Waiting for wallet…' : 'Manage as creator'}</button>`;
    } else {
      h += `<h3>Manage</h3>
        <label>Profile picture</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          <input type="url" id="avatarUrl" placeholder="https://… image URL" style="flex:1;min-width:220px">
          <button class="sm ghost" id="saveAvatarUrl" ${busy ? 'disabled' : ''}>Use URL</button>
          <input type="file" id="avatarFile" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none">
          <button class="sm ghost" id="pickAvatar" ${busy ? 'disabled' : ''}>Upload image</button>
        </div>
        <label>What it does with its fees</label>
        ${a.pendingRules ? `<div class="notice warn">Proposed from Claude: ${a.pendingRules.buybackBps / 100}% buy back &amp; burn, ${a.pendingRules.airdropBps / 100}% airdrop. <button class="sm" id="applyRules" ${busy ? 'disabled' : ''} style="margin-left:8px">Apply</button></div>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
          ${Object.entries(a.presets || {}).map(([k, p]) => `<button class="sm ghost" data-preset="${k}" ${busy ? 'disabled' : ''}>${k} ${p.buybackBps / 100}/${p.airdropBps / 100}</button>`).join('')}
        </div>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-top:8px;align-items:end">
          <div><span class="sub">buy back &amp; burn %</span><input type="text" id="rBuy" value="${a.rules.buybackBps / 100}" inputmode="decimal"></div>
          <div><span class="sub">airdrop %</span><input type="text" id="rAir" value="${a.rules.airdropBps / 100}" inputmode="decimal"></div>
          <div><span class="sub">creator salary %</span><input type="text" id="rSal" value="${a.rules.salaryBps / 100}" inputmode="decimal"></div>
          <div><span class="sub">raffle %</span><input type="text" id="rRaf" value="${a.rules.raffleBps / 100}" inputmode="decimal"></div>
          <div><span class="sub">dip buy at -%</span><input type="text" id="rDip" value="${a.rules.dipBuyPct || 0}" inputmode="decimal"></div>
          <div><span class="sub">whale post ≥ ETH</span><input type="text" id="rWhale" value="${esc(a.rules.whaleEth || '0.05')}" inputmode="decimal"></div>
          <div><span class="sub">quiet hours UTC (e.g. 22-8)</span><input type="text" id="rQuiet" value="${a.rules.quietHours ? `${a.rules.quietHours.from}-${a.rules.quietHours.to}` : ''}" placeholder="off"></div>
          <div><span class="sub">min minutes between posts</span><input type="text" id="rMinPost" value="${a.rules.minPostMin || 0}" inputmode="numeric"></div>
        </div>
        <div style="display:flex;gap:16px;flex-wrap:wrap;margin-top:10px;font-size:14px">
          <label style="display:inline-flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="rLoyal" ${b(a.rules.loyaltyOnly)}> airdrop only to holders who never sold</label>
          <label style="display:inline-flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="rMile" ${b(a.rules.milestones)}> post at graduation milestones</label>
          <label style="display:inline-flex;gap:6px;align-items:center;margin:0"><input type="checkbox" id="rCollect" ${b(a.rules.collectOnly)}> collect only, spend nothing</label>
        </div>
        <div class="sub" style="margin-top:6px">rent ${a.rules.rentBps / 100}% · the rest stays as gas reserve · <button class="sm ghost" id="saveRules" ${busy ? 'disabled' : ''}>Save settings</button></div>
        <label>Telegram channel ${a.telegramConnected ? '<span class="chip">connected</span>' : ''}</label>
        <p class="sub" style="margin:0 0 6px">Create a bot with @BotFather, add it to your channel or group as admin, then paste the bot token and the chat id (like -1001234567890 or @yourchannel).</p>
        <div style="display:flex;gap:8px;flex-wrap:wrap"><input type="password" id="tgTok" placeholder="Bot token" autocomplete="off" style="flex:2;min-width:200px"><input type="text" id="tgChat" placeholder="Chat id" autocomplete="off" style="flex:1;min-width:140px"></div>
        <div class="actions" style="margin-top:8px">
          <button class="sm" id="saveTg" ${busy ? 'disabled' : ''}>Save Telegram</button>
          ${a.telegramConnected ? `<button class="sm ghost" id="testTg" ${busy ? 'disabled' : ''}>Send a test message</button><button class="sm ghost" id="dropTg" ${busy ? 'disabled' : ''}>Disconnect Telegram</button>` : ''}
        </div>
        <label>Personality (one line, used in posts)</label>
        <div style="display:flex;gap:8px"><input type="text" id="vibe" value="${esc(a.vibe || '')}" maxlength="200" style="flex:1"><button class="sm ghost" id="saveVibe" ${busy ? 'disabled' : ''}>Save</button></div>
        <label>X (Twitter) with your own API keys ${a.xConnected ? '<span class="chip">connected</span>' : ''}</label>
        <p class="sub" style="margin:0 0 6px">Create an app at developer.x.com with read and write access, then paste the four keys. Posts go out from your account. Keys are stored encrypted and never shown again.</p>
        <input type="text" id="xk" placeholder="API key" autocomplete="off">
        <input type="password" id="xs" placeholder="API key secret" autocomplete="off" style="margin-top:6px">
        <input type="text" id="xt" placeholder="Access token" autocomplete="off" style="margin-top:6px">
        <input type="password" id="xts" placeholder="Access token secret" autocomplete="off" style="margin-top:6px">
        <div class="actions">
          <button class="sm" id="saveX" ${busy ? 'disabled' : ''}>Save X keys</button>
          ${a.xConnected ? `<button class="sm ghost" id="testX" ${busy ? 'disabled' : ''}>Send a test post</button><button class="sm ghost" id="dropX" ${busy ? 'disabled' : ''}>Disconnect X</button>` : ''}
        </div>
        <hr class="soft">
        <label>Take the fees back</label>
        <p class="sub" style="margin:0 0 8px">The agent hands the creator-fee role, its ETH and any tokens back to <span class="mono">${short(a.creator)}</span>. This ends the agent.</p>
        <button class="sm ghost" id="release" ${busy || a.status !== 'active' ? 'disabled' : ''} style="color:var(--bad)">Release agent</button>
        <button class="sm ghost" id="logout" style="float:right">Sign out</button>`;
    }
    h += `</div>`;
    app.innerHTML = h;

    const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
    on('login', login);
    on('logout', () => { session = null; try { localStorage.removeItem(`cd-session-${token.toLowerCase()}`); } catch {} render(); });
    on('saveVibe', () => act('Personality saved.', () => api(`/api/agent/${token}/vibe`, { method: 'POST', json: { vibe: document.getElementById('vibe').value } })));
    on('saveRules', () => act('Settings saved.', () => api(`/api/agent/${token}/rules`, { method: 'POST', json: {
      buybackPct: Number(document.getElementById('rBuy').value), airdropPct: Number(document.getElementById('rAir').value),
      salaryPct: Number(document.getElementById('rSal').value), rafflePct: Number(document.getElementById('rRaf').value),
      dipBuyPct: Number(document.getElementById('rDip').value), whaleEth: document.getElementById('rWhale').value.trim() || '0.05',
      quietHours: document.getElementById('rQuiet').value.trim(), minPostMin: Number(document.getElementById('rMinPost').value),
      loyaltyOnly: document.getElementById('rLoyal').checked, milestones: document.getElementById('rMile').checked, collectOnly: document.getElementById('rCollect').checked,
    } })));
    on('saveTg', () => act('Telegram connected.', () => api(`/api/agent/${token}/telegram`, { method: 'POST', json: { botToken: document.getElementById('tgTok').value, chatId: document.getElementById('tgChat').value } })));
    on('testTg', () => act('Test message sent.', () => api(`/api/agent/${token}/telegram/test`, { method: 'POST', json: {} })));
    on('dropTg', () => act('Telegram disconnected.', () => api(`/api/agent/${token}/telegram`, { method: 'POST', json: { disconnect: true } })));
    on('askBtn', () => { const q = document.getElementById('q').value; if (q.trim().length < 3) return; act('Answered.', () => api(`/api/agent/${token}/ask`, { method: 'POST', json: { question: q } })); });
    on('applyRules', () => act('Proposed split applied.', () => api(`/api/agent/${token}/rules`, { method: 'POST', json: { applyPending: true } })));
    app.querySelectorAll('button[data-preset]').forEach((b) => { b.onclick = () => act(`Preset "${b.dataset.preset}" applied.`, () => api(`/api/agent/${token}/rules`, { method: 'POST', json: { preset: b.dataset.preset } })); });
    on('saveAvatarUrl', () => act('Picture saved.', () => api(`/api/agent/${token}/avatar`, { method: 'POST', json: { url: document.getElementById('avatarUrl').value } })));
    on('pickAvatar', () => document.getElementById('avatarFile').click());
    const file = document.getElementById('avatarFile');
    if (file) file.onchange = () => { const f = file.files[0]; if (!f) return; act('Picture uploaded.', () => api(`/api/agent/${token}/avatar`, { method: 'POST', headers: { 'content-type': f.type || 'image/png' }, body: f })); };
    on('saveX', () => act('X connected.', () => api(`/api/agent/${token}/x`, { method: 'POST', json: { apiKey: xk.value, apiSecret: xs.value, accessToken: xt.value, accessSecret: xts.value } })));
    on('testX', () => act('Test post sent.', () => api(`/api/agent/${token}/x/test`, { method: 'POST', json: {} })));
    on('dropX', () => act('X disconnected.', () => api(`/api/agent/${token}/x`, { method: 'POST', json: { disconnect: true } })));
    on('release', () => { if (confirm('Hand the fees and balance back to the creator and end this agent?')) act('Released.', () => api(`/api/agent/${token}/release`, { method: 'POST', json: {} })); });
  }

  load();
})();
