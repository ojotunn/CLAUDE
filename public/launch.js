// Pagina de assinatura. Conecta a carteira injetada (EIP-1193 / EIP-6963),
// pede ao servidor a transacao ja simulada a partir dessa carteira, mostra o
// endereco previsto do token e manda a carteira assinar. Nenhuma chave passa
// por aqui: so eth_sendTransaction.
(() => {
  const id = location.pathname.split('/').filter(Boolean).pop();
  const app = document.getElementById('app');
  let rec = null, terms = null, provider = null, account = null, pollTimer = null, busy = false, lastError = null;

  const providers = new Map();
  window.addEventListener('eip6963:announceProvider', (e) => {
    const { info, provider: p } = e.detail || {};
    if (info?.uuid && !providers.has(info.uuid)) { providers.set(info.uuid, { info, provider: p }); render(); }
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const hexChain = () => '0x' + Number(terms.chain.id).toString(16);

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
      if (rec.status === 'submitted') poll();
    } catch (e) {
      app.innerHTML = `<div class="notice bad">${esc(e.message)}</div><p class="sub">Ask Claude to prepare the launch again.</p>`;
    }
  }

  function poll() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      try { rec = await api(`/api/launch/${id}`); render(); } catch {}
      if (rec && rec.status === 'submitted') poll();
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
      await p.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: hexChain(), chainName: terms.chain.name,
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
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

  async function sign() {
    if (busy || !provider || !rec?.tx) return;
    busy = true; lastError = null; render();
    try {
      await ensureChain(provider);
      const tx = { from: account, to: rec.tx.to, data: rec.tx.data, value: rec.tx.value, chainId: hexChain() };
      if (rec.tx.gas) tx.gas = rec.tx.gas;
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [tx] });
      rec = await api(`/api/launch/${id}/tx`, { hash });
      poll();
    } catch (e) {
      lastError = e?.code === 4001 ? 'signature rejected in the wallet' : (e?.message || String(e));
    } finally {
      busy = false; render();
    }
  }

  function statusChip() {
    const map = {
      awaiting_wallet: ['', 'waiting for a wallet'],
      needs_funds: ['warn', 'wallet needs ETH'],
      ready: ['ok', 'ready to sign'],
      submitted: ['busy', 'waiting for confirmation'],
      live: ['ok', 'live on pons'],
      done: ['ok', 'buy filled'],
      failed: ['bad', 'transaction failed'],
      expired: ['bad', 'link expired'],
    };
    const [cls, label] = map[rec.status] || ['', rec.status];
    return `<span class="status ${cls}"><i></i>${esc(label)}</span>`;
  }

  function summaryRows() {
    const s = rec.summary || {};
    if (rec.kind === 'handover') {
      return [
        ['Token', `<b>${esc(s.name)}</b> <span class="sub">$${esc(s.symbol)}</span>`],
        ['Contract', `<span class="mono">${esc(s.token)}</span>`],
        ['Agent wallet', `<span class="mono">${esc(s.agent)}</span>`],
        ['Fees today go to', `<span class="mono">${esc(s.currentRecipient)}</span> (you)`],
        ['What happens', esc(s.whatHappens)],
        ['Cost', 'gas only'],
      ];
    }
    if (rec.kind === 'buy') {
      return [
        ['Token', `<b>${esc(s.name)}</b> <span class="sub">$${esc(s.symbol)}</span>`],
        ['Contract', `<span class="mono">${esc(s.token)}</span>`],
        ['You spend', `${esc(s.spend?.eth)} ETH`],
        ['You receive', `about ${esc(rec.predicted?.tokensOut || s.spend?.tokens)} ${esc(s.symbol)}`],
        ['Curve progress', s.graduationProgress != null ? `${s.graduationProgress}% to graduation` : '—'],
      ];
    }
    const rows = [
      ['Name', `<b>${esc(s.name)}</b>`],
      ['Ticker', `$${esc(s.symbol)}`],
      ['Supply', `${Number(s.supply).toLocaleString('en-US')} tokens`],
    ];
    if (s.description) rows.push(['About', esc(s.description)]);
    rows.push(['Creator tax', esc(s.creatorTax)]);
    if (s.buybackEnabled) rows.push(['Buybacks', 'enabled']);
    rows.push(['Fees go to', rec.creatorFeeRecipient ? `<span class="mono">${esc(rec.creatorFeeRecipient)}</span>` : esc(s.creatorFeeRecipient)]);
    if (s.devBuy) rows.push(['Dev buy', `${esc(s.devBuy.eth)} ETH → about ${esc(rec.predicted?.tokensOut || s.devBuy.tokens)} ${esc(s.symbol)} (${esc(s.devBuy.shareOfSupply)} of supply)`]);
    rows.push(['Launch fee', `${esc(s.cost?.launchFeeEth)} ETH (pons)`]);
    rows.push(['Total', `<b>${esc(s.cost?.totalEth)} ETH</b> + gas`]);
    return rows;
  }

  function render() {
    if (!rec || !terms) return;
    const isLaunch = rec.kind === 'launch';
    const isHandover = rec.kind === 'handover';
    const title = isLaunch ? `Launch ${esc(rec.summary?.name)}` : isHandover ? `Give $${esc(rec.summary?.symbol)} its agent` : `Buy ${esc(rec.summary?.symbol)}`;
    let html = `<div class="head">
      <div><div class="big">${title}</div><div class="sub">${esc(terms.chain.name)}${terms.chain.isTestnet ? ' — TESTNET' : ''} · pons v2</div></div>
      ${statusChip()}
    </div>`;

    if (rec.status === 'live') {
      html += `<div class="notice ok">${esc(rec.summary?.name)} is live on pons.</div>
        <div class="label">Contract address</div>
        <div class="ca" id="ca">${esc(rec.token)}</div>
        <div class="actions">
          <button class="sm ghost" data-copy="#ca">Copy address</button>
          <a class="btn sm accent" href="${esc(rec.links.pons)}" target="_blank" rel="noopener">Open on pons</a>
          <a class="btn sm ghost" href="${esc(rec.links.explorerToken)}" target="_blank" rel="noopener">Explorer</a>
          <a class="btn sm ghost" href="${esc(rec.links.explorerTx)}" target="_blank" rel="noopener">Transaction</a>
        </div>
        ${rec.tokensOut && rec.tokensOut !== '0' ? `<p class="sub" style="margin-top:14px">Your dev buy received ${esc(rec.tokensOut)} ${esc(rec.summary?.symbol)}.</p>` : ''}
        <p class="sub">Back in Claude, ask whether it went through. The status tool will answer with this address.</p>`;
      app.innerHTML = html;
      return;
    }
    if (rec.status === 'done' && isHandover) {
      html += `<div class="notice ok">Done. $${esc(rec.summary?.symbol)} now runs its own wallet.</div>
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
          <a class="btn sm accent" href="${esc(rec.links.pons)}" target="_blank" rel="noopener">Open on pons</a>
          <a class="btn sm ghost" href="${esc(rec.links.explorerTx)}" target="_blank" rel="noopener">Transaction</a>
        </div>`;
      app.innerHTML = html;
      return;
    }

    html += `<hr class="soft"><div class="kv">${summaryRows().map(([k, v]) => `<div class="k">${k}</div><div class="v">${v}</div>`).join('')}</div>`;

    if (rec.predicted?.token && isLaunch) {
      html += `<div class="label">Will deploy at</div>
        <div class="ca">${esc(rec.predicted.token)}</div>
        <p class="sub" style="margin:6px 0 0">Derived from your wallet, the pinned terms and this link's salt. Same address, or the transaction reverts.</p>`;
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
        html += `<div class="sub">Connected: <span class="mono">${esc(account)}</span> · balance ${esc(rec.funding?.balanceEth)} ETH</div>`;
        html += `<div class="actions">
          <button class="accent" id="sign" ${busy || !rec.funding?.ok ? 'disabled' : ''}>${busy ? 'Waiting for wallet…' : (isLaunch ? 'Sign & launch' : isHandover ? 'Sign & hand over' : 'Sign & buy')}</button>
          <button class="ghost" id="recheck" ${busy ? 'disabled' : ''}>Re-check balance</button>
        </div>`;
      } else if (!wallets.length) {
        html += `<div class="notice">No browser wallet found. Open this link in a browser with MetaMask, Rabby, Phantom (EVM) or another injected wallet, or in your wallet's built-in browser on mobile.</div>`;
      } else {
        html += `<div class="sub" style="margin-bottom:10px">${isHandover ? `Connect the wallet that currently receives the creator fees (<span class="mono">${esc(rec.summary?.currentRecipient)}</span>). Any other wallet is refused.` : `Connect the wallet that will pay and sign. It becomes the deployer${isLaunch ? ' and, unless set otherwise, the fee recipient' : ''}.`}</div>
          <div class="wallets">${wallets.map((w, i) => `<button class="ghost" data-w="${i}" ${busy ? 'disabled' : ''}>${w.info.icon ? `<img src="${esc(w.info.icon)}" alt="">` : ''}Connect with ${esc(w.info.name)}</button>`).join('')}</div>
          <p class="sub" style="margin-top:10px">Needs a wallet that supports custom networks, such as MetaMask or Rabby. Phantom does not support Robinhood Chain.</p>`;
      }
    }

    app.innerHTML = html;
    app.querySelectorAll('button[data-w]').forEach((b) => { b.onclick = () => connect(walletList()[Number(b.dataset.w)]); });
    const signBtn = document.getElementById('sign'); if (signBtn) signBtn.onclick = sign;
    const re = document.getElementById('recheck'); if (re) re.onclick = () => connect({ provider });
  }

  load();
})();
