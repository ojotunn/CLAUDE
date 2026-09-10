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
    if (x.kind === 'buyback') return `bought ${fmt(x.tokens, 0)} $${esc(a.symbol)} (${esc(x.eth)} ETH)`;
    if (x.kind === 'burn') return `burned ${fmt(x.tokens, 0)}`;
    if (x.kind === 'airdrop') return `airdropped ${fmt(x.tokens, 0)} to ${x.recipients} buyers`;
    if (x.kind === 'hold') return `held ${esc(x.eth)} ETH (${esc(x.reason)})`;
    return esc(x.kind);
  };

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
      <div class="stat"><div class="v">${a.stats.cycles}</div><div class="k">cycles run</div></div>
    </div>
    <p class="sub">Every cycle, whatever is above the gas reserve gets split: ${a.rules.treasury ? `${a.rules.rentBps / 100}% rent, ` : ''}${a.rules.buybackBps / 100}% buy back and burn, ${a.rules.airdropBps / 100}% airdrop to recent buyers, the rest stays as reserve. No approvals, no caps. The agent can only talk to pons, the burn address, holders and the creator.${a.pendingRules ? ` <b>A new split was proposed from Claude and waits for the creator to apply it.</b>` : ''}</p>`;

    h += `<h3 style="margin:26px 0 10px">What it did</h3><div class="feed">`;
    if (!a.log.length) h += `<div class="empty">Nothing yet. The first cycle runs when fees arrive.</div>`;
    for (const e of a.log) {
      h += `<div class="entry"><div class="when">${new Date(e.at).toLocaleString('en-US')}${e.kind !== 'cycle' ? ` · ${esc(e.kind)}` : ''}</div>`;
      if (e.text) h += `<div class="post">${esc(e.text)}</div>`;
      if (e.post) h += `<div class="post">${esc(e.post.text)} <button class="sm ghost" data-copy="${esc(e.post.text).replace(/"/g, '&quot;')}" style="margin-left:6px">Copy</button>${e.post.tweetId ? ` <span class="chip">posted to X</span>` : ''}${e.post.tweetError ? ` <span class="err">X: ${esc(e.post.tweetError)}</span>` : ''}</div>`;
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
        <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:8px">
          <span class="sub">buy back &amp; burn</span><input type="text" id="rBuy" value="${a.rules.buybackBps / 100}" style="width:70px" inputmode="decimal">%
          <span class="sub">airdrop</span><input type="text" id="rAir" value="${a.rules.airdropBps / 100}" style="width:70px" inputmode="decimal">%
          <span class="sub">rent ${a.rules.rentBps / 100}% · reserve gets the rest</span>
          <button class="sm ghost" id="saveRules" ${busy ? 'disabled' : ''}>Save split</button>
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
    on('saveRules', () => act('Split saved.', () => api(`/api/agent/${token}/rules`, { method: 'POST', json: { buybackPct: Number(document.getElementById('rBuy').value), airdropPct: Number(document.getElementById('rAir').value) } })));
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
