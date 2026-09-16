// Pagina de assinatura. Conecta a carteira injetada (EIP-1193 / EIP-6963),
// pede ao servidor a transacao ja simulada a partir dessa carteira, mostra o
// endereco previsto do token e manda a carteira assinar. Nenhuma chave passa
// por aqui: so eth_sendTransaction. Quando ha passos previos (aprovacoes de
// USDC na Argus), eles vao antes, um por vez, esperando o recibo de cada um.
(() => {
  const id = location.pathname.split('/').filter(Boolean).pop();
  const app = document.getElementById('app');
  let rec = null, terms = null, provider = null, account = null, pollTimer = null, busy = false, lastError = null, step = null;

  const providers = new Map();
  window.addEventListener('eip6963:announceProvider', (e) => {
    const { info, provider: p } = e.detail || {};
    if (info?.uuid && !providers.has(info.uuid)) { providers.set(info.uuid, { info, provider: p }); render(); }
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const hexChain = () => '0x' + Number(terms.chain.id).toString(16);
  const unit = () => rec?.unit || terms?.unit || '';
  const venue = () => terms?.venue?.name || 'the launchpad';

  async function api(path, body) {
    const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : undefined);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    return data;
  }

  async function load() {
    try {
      [rec, terms] = await Promise.all([api(`/api/launch/${id}`), api('/api/terms')]);
      render();
      if (rec.status === 'submitted' || rec.status === 'launching') poll();
    } catch (e) {
      app.innerHTML = `<div class="notice bad">${esc(e.message)}</div><p class="sub">Ask Claude to prepare the launch again.</p>`;
    }
  }

  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      try { rec = await api(`/api/launch/${id}`); render(); } catch {}
      if (rec && (rec.status === 'submitted' || rec.status === 'launching')) poll();
    }, 3000);
  }

  function walletList() {
    const list = [...providers.values()];
    if (!list.length && window.ethereum) list.push({ info: { uuid: 'injected', name: 'Browser wallet', icon: null }, provider: window.ethereum });
    return list;
  }

  async function ensureChain(p) {
    try {
      await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hexChain() }] });
    } catch (e) {
      const unknown = e?.code === 4902 || /unrecognized|not added|unknown chain|does not exist/i.test(e?.message || '');
      if (!unknown) throw e;
      const native = terms.chain.native || { name: 'Ether', symbol: 'ETH', decimals: 18 };
      await p.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hexChain(), chainName: terms.chain.name,
          nativeCurrency: { name: native.name, symbol: native.symbol, decimals: 18 },
          rpcUrls: [terms.chain.rpc], blockExplorerUrls: [terms.chain.explorer],
        }],
      });
    }
  }

  async function connect(entry) {
    if (busy) return;
    busy = true; lastError = null; render();
    try {
      provider = entry.provider;
      const accounts = await provider.request({ method: 'eth_requestAccounts' });
      account = accounts?.[0];
      if (!account) throw new Error('no account returned by the wallet');
      await ensureChain(provider);
      rec = await api(`/api/launch/${id}/bind`, { wallet: account });
    } catch (e) {
      lastError = e?.message || String(e);
    } finally {
      busy = false; render();
    }
  }

  // Espera o recibo de um passo previo pela propria carteira (sem o servidor).
  async function waitReceipt(hash) {
    for (let i = 0; i < 120; i++) {
      const r = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] }).catch(() => null);
      if (r) { if (r.status === '0x0') throw new Error('an approval reverted'); return r; }
      await new Promise((res) => setTimeout(res, 1500));
    }
    throw new Error('the approval did not confirm in time; reload and try again');
  }

  async function sign() {
    if (busy || !provider || !rec?.tx) return;
    busy = true; lastError = null; render();
    try {
      await ensureChain(provider);
      const pre = rec.pre || [];
      for (let i = 0; i < pre.length; i++) {
        step = { n: i + 1, total: pre.length + 1, label: pre[i].label || 'approval' }; render();
        const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ from: account, to: pre[i].to, data: pre[i].data, value: pre[i].value, chainId: hexChain() }] });
        await waitReceipt(hash);
      }
      step = { n: pre.length + 1, total: pre.length + 1, label: rec.kind === 'buy' ? 'swap' : rec.kind === 'agent-launch' ? 'send the launch money' : rec.kind === 'handover' ? 'hand over' : 'launch' }; render();
      const tx = { from: account, to: rec.tx.to, data: rec.tx.data, value: rec.tx.value, chainId: hexChain() };
      if (rec.tx.gas) tx.gas = rec.tx.gas;
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] });
      rec = await api(`/api/launch/${id}/tx`, { hash });
      poll();
    } catch (e) {
      lastError = e?.code === 4001 ? 'signature rejected in the wallet' : (e?.message || String(e));
    } finally {
      busy = false; step = null; render();
    }
  }

  function statusChip() {
    const map = {
      awaiting_wallet: ['', 'waiting for a wallet'],
      needs_funds: ['warn', `wallet needs ${unit()}`],
      ready: ['ok', 'ready to sign'],
      submitted: ['busy', 'waiting for confirmation'],
      launching: ['busy', 'the agent is launching'],
      live: ['ok', `live on ${venue()}`],
      done: ['ok', rec.kind === 'buy' ? 'buy filled' : 'done'],
      failed: ['bad', 'transaction failed'],
      expired: ['bad', 'link expired'],
    };
    const [cls, label] = map[rec.status] || ['', rec.status];
    return `<span class="status ${cls}"><i></i>${esc(label)}</span>`;
  }

  function summaryRows() {
    const s = rec.summary || {};
    const u = unit();
    if (rec.kind === 'handover') {
      return [
        ['Token', `<b>${esc(s.name)}</b> <span class="sub">$${esc(s.symbol)}</span>`],
        ['Contract', `<span class="mono">${esc(s.token)}</span>`],
        ['Agent wallet', `<span class="mono">${esc(s.agent)}</span>`],
        ['Fees today go to', `<span class="mono">${esc(s.currentRecipient)}</span> (you)`],
        ...(s.split ? [['It will spend', esc(s.split)]] : []),
        ...(s.vibe ? [['Personality', esc(s.vibe)]] : []),
        ['What happens', esc(s.whatHappens)],
        ['Cost', 'gas only'],
      ];
    }
    if (rec.kind === 'buy') {
      return [
        ['Token', `<b>${esc(s.name)}</b> <span class="sub">$${esc(s.symbol)}</span>`],
        ['Contract', `<span class="mono">${esc(s.token)}</span>`],
        ['You spend', `${esc(s.spend?.amount)} ${esc(u)}`],
        ['You receive', `about ${esc(rec.predicted?.tokensOut || s.spend?.tokens)} ${esc(s.symbol)}`],
        ['Progress', s.graduationProgress != null ? `${s.graduationProgress}% to ${esc((s.graduationLabel || 'graduation').split(' (')[0])}` : '—'],
        ...(s.steps ? [['Signatures', esc(s.steps)]] : []),
      ];
    }
    const rows = [
      ['Name', `<b>${esc(s.name)}</b>`],
      ['Ticker', `$${esc(s.symbol)}`],
      ['Supply', `${Number(s.supply).toLocaleString('en-US')} tokens`],
    ];
    if (s.description) rows.push(['About', esc(s.description)]);
    if (s.taxes && s.taxes.buyTax) {
      rows.push(['Tax', `${esc(s.taxes.buyTax)} on buys, ${esc(s.taxes.sellTax)} on sells, fixed forever`]);
      const sp = s.taxes.split || {};
      rows.push(['Tax split', `${(sp.creatorBps || 0) / 100}% creator, ${(sp.burnBps || 0) / 100}% buy back &amp; burn, ${(sp.holdersBps || 0) / 100}% holders, ${(sp.liquidityBps || 0) / 100}% liquidity (Argus keeps 10% of the tax)`]);
      if (s.taxes.opensAt) rows.push(['Market', `opens at ${esc(s.taxes.opensAt)}, liquidity locks at ${esc(s.taxes.bondsAt)} market cap`]);
    } else {
      rows.push(['Creator tax', esc(s.creatorTax)]);
      if (s.buybackEnabled) rows.push(['Buybacks', 'enabled']);
    }
    if (rec.kind === 'agent-launch') {
      const a = rec.agent || s.agent || {};
      rows.push(['Launched by', `the agent wallet <span class="mono">${esc(a.address || a.wallet)}</span> (it becomes the creator and keeps the creator share)`]);
      if (s.agent?.vibe) rows.push(['Personality', esc(s.agent.vibe)]);
      if (s.devBuy) rows.push(['Dev buy', `${esc(s.devBuy.amount)} ${esc(u)} → about ${esc(rec.predicted?.tokensOut || s.devBuy.tokens)} ${esc(s.symbol)} (${esc(s.devBuy.shareOfSupply)} of supply), bought by the agent`]);
      rows.push(['You send', `<b>${esc(a.budget ? `${a.budget} ${u}` : (s.agent?.send || `dev buy plus gas in ${u}`))}</b> to the agent wallet (dev buy plus gas for the launch and the first cycles)`]);
      return rows;
    }
    rows.push(['Fees go to', rec.creatorFeeRecipient ? `<span class="mono">${esc(rec.creatorFeeRecipient)}</span>` : esc(s.creatorFeeRecipient)]);
    if (s.devBuy) rows.push(['Dev buy', `${esc(s.devBuy.amount)} ${esc(u)} → about ${esc(rec.predicted?.tokensOut || s.devBuy.tokens)} ${esc(s.symbol)} (${esc(s.devBuy.shareOfSupply)} of supply)`]);
    if (Number(s.cost?.launchFee) > 0) rows.push(['Launch fee', `${esc(s.cost?.launchFee)} ${esc(u)} (${esc(venue())})`]);
    rows.push(['Total', `<b>${esc(s.cost?.total)} ${esc(u)}</b> + gas${terms?.venue?.id === 'argus' ? ' (paid in USDC)' : ''}`]);
    return rows;
  }

  function render() {
    if (!rec || !terms) return;
    const isLaunch = rec.kind === 'launch';
    const isAgentLaunch = rec.kind === 'agent-launch';
    const isHandover = rec.kind === 'handover';
    const u = unit();
    const title = isLaunch ? `Launch ${esc(rec.summary?.name)}` : isAgentLaunch ? `Fund the agent that launches ${esc(rec.summary?.name)}` : isHandover ? `Give $${esc(rec.summary?.symbol)} its agent` : `Buy ${esc(rec.summary?.symbol)}`;
    let html = `<div class="head">
      <div><div class="big">${title}</div><div class="sub">${esc(terms.chain.name)}${terms.chain.isTestnet ? ' — TESTNET' : ''} · ${esc(venue())}</div></div>
      ${statusChip()}
    </div>`;

    if (rec.status === 'live') {
      html += `<div class="notice ok">${esc(rec.summary?.name)} is live on ${esc(venue())}.</div>
        <div class="label">Contract address</div>
        <div class="ca" id="ca">${esc(rec.token)}</div>
        <div class="actions">
          <button class="sm ghost" data-copy="#ca">Copy address</button>
          <a class="btn sm accent" href="${esc(rec.links.venue)}" target="_blank" rel="noopener">Open on ${esc(venue())}</a>
          ${isAgentLaunch && rec.agent?.page ? `<a class="btn sm ghost" href="${esc(rec.agent.page)}">Agent page</a>` : ''}
          <a class="btn sm ghost" href="${esc(rec.links.explorerToken)}" target="_blank" rel="noopener">Explorer</a>
          <a class="btn sm ghost" href="${esc(rec.links.explorerTx)}" target="_blank" rel="noopener">Transaction</a>
        </div>
        ${rec.tokensOut && rec.tokensOut !== '0' ? `<p class="sub" style="margin-top:14px">${isAgentLaunch ? 'The agent\'s dev buy' : 'Your dev buy'} received ${esc(rec.tokensOut)} ${esc(rec.summary?.symbol)}.</p>` : ''}
        <p class="sub">Back in Claude, ask whether it went through. The status tool will answer with this address.</p>`;
      app.innerHTML = html;
      return;
    }
    if (rec.status === 'launching') {
      html += `<div class="notice">The launch money reached the agent wallet. The agent is sending the launch transaction now; this page updates by itself.</div>
        ${rec.agent?.page ? `<div class="actions"><a class="btn sm ghost" href="${esc(rec.agent.page)}">Agent page</a></div>` : ''}`;
      app.innerHTML = html;
      return;
    }
    if (rec.status === 'done' && isHandover) {
      html += `<div class="notice ok">Done. $${esc(rec.summary?.symbol)} now runs its own wallet.</div>
        <div class="notice warn">One more thing: the agent wallet starts empty and its first move costs gas. On the agent page, press <b>Send ${esc(u)} for gas</b> once. After that it pays for itself.</div>
        <div class="actions">
          <a class="btn sm accent" href="/t/${esc(rec.token)}">Open the agent page</a>
          <a class="btn sm ghost" href="${esc(rec.links.explorerTx)}" target="_blank" rel="noopener">Transaction</a>
        </div>`;
      app.innerHTML = html;
      return;
    }
    if (rec.status === 'done') {
      html += `<div class="notice ok">Buy filled: ${esc(rec.tokensOut)} ${esc(rec.summary?.symbol)}.</div>
        <div class="actions">
          <a class="btn sm accent" href="${esc(rec.links.venue)}" target="_blank" rel="noopener">Open on ${esc(venue())}</a>
          <a class="btn sm ghost" href="${esc(rec.links.explorerTx)}" target="_blank" rel="noopener">Transaction</a>
        </div>`;
      app.innerHTML = html;
      return;
    }

    html += `<hr class="soft"><div class="kv">${summaryRows().map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('')}</div>`;

    if (rec.predicted?.token && (isLaunch || isAgentLaunch)) {
      html += `<div class="label">Will deploy at</div>
        <div class="ca">${esc(rec.predicted.token)}</div>
        <p class="sub" style="margin:6px 0 0">Derived from ${isAgentLaunch ? 'the agent wallet' : 'your wallet'}, the pinned terms and this link's salt. Same address, or the transaction reverts.</p>`;
    }

    for (const w of rec.warnings || []) html += `<div class="notice warn">${esc(w)}</div>`;
    if (rec.funding && !rec.funding.ok) html += `<div class="notice warn">${esc(rec.funding.message)}</div>`;
    if (rec.status === 'failed') html += `<div class="notice bad">${esc(rec.error || 'the transaction failed')}. Ask Claude to prepare it again.</div>`;
    if (rec.status === 'expired') html += `<div class="notice bad">This link expired. Ask Claude to prepare it again.</div>`;
    if (lastError) html += `<div class="notice bad">${esc(lastError)}</div>`;

    if (rec.status === 'submitted') {
      html += `<div class="notice">Transaction sent. Waiting for ${esc(terms.chain.name)} to confirm…
        <div class="sub"><a href="${esc(rec.links.explorerTx)}" target="_blank" rel="noopener">View on explorer</a></div></div>`;
    } else if (['awaiting_wallet', 'needs_funds', 'ready'].includes(rec.status)) {
      const wallets = walletList();
      html += `<hr class="soft">`;
      if (account && rec.wallet && account.toLowerCase() === rec.wallet.toLowerCase()) {
        const pre = rec.pre || [];
        html += `<div class="sub">Connected: <span class="mono">${esc(account)}</span> · balance ${esc(rec.funding?.balance)} ${esc(u)}</div>`;
        if (pre.length) html += `<div class="sub" style="margin-top:6px">${pre.length + 1} signatures: ${pre.map((p) => esc(p.label || 'approval')).join(', ')}, then the ${isLaunch ? 'launch' : 'swap'}. The approvals are one-time.</div>`;
        if (step) html += `<div class="notice">Step ${step.n} of ${step.total}: ${esc(step.label)}. Confirm it in your wallet.</div>`;
        html += `<div class="actions">
          <button class="accent" id="sign" ${busy || !rec.funding?.ok ? 'disabled' : ''}>${busy ? 'Waiting for wallet…' : (isLaunch ? 'Sign & launch' : isAgentLaunch ? `Send ${esc(rec.agent?.budget || '')} ${esc(u)} to the agent` : isHandover ? 'Sign & hand over' : 'Sign & buy')}</button>
          <button class="ghost" id="recheck" ${busy ? 'disabled' : ''}>Re-check balance</button>
        </div>`;
      } else if (!wallets.length) {
        html += `<div class="notice">No browser wallet found. Open this link in a browser with MetaMask, Rabby, Phantom (EVM) or another injected wallet, or in your wallet's built-in browser on mobile.</div>`;
      } else {
        const who = isHandover ? `Connect the wallet that currently receives the creator fees (<span class="mono">${esc(rec.summary?.currentRecipient)}</span>). Any other wallet is refused.`
          : isAgentLaunch ? `Connect the wallet that pays for the launch. It becomes the agent's owner: it can manage the agent, receives the salary and can take the balance back.`
            : `Connect the wallet that will pay and sign. It becomes the deployer${isLaunch ? ' and the creator fee recipient' : ''}.`;
        html += `<div class="sub" style="margin-bottom:10px">${who}</div>
          <div class="wallets">${wallets.map((w, i) => `<button class="ghost" data-w="${i}" ${busy ? 'disabled' : ''}>${w.info.icon ? `<img src="${esc(w.info.icon)}" alt="">` : ''}Connect with ${esc(w.info.name)}</button>`).join('')}</div>
          <p class="sub" style="margin-top:10px">Needs a wallet that supports custom networks, such as MetaMask or Rabby. The page adds ${esc(terms.chain.name)} to the wallet if it is missing.</p>`;
      }
    }

    app.innerHTML = html;
    app.querySelectorAll('button[data-w]').forEach((b) => { b.onclick = () => connect(walletList()[Number(b.dataset.w)]); });
    const signBtn = document.getElementById('sign'); if (signBtn) signBtn.onclick = sign;
    const re = document.getElementById('recheck'); if (re) re.onclick = () => connect({ provider });
  }

  load();
})();
