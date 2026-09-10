// Partes comuns do site: navegacao, rodape, dados vivos da chain e botoes de copiar.
(() => {
  const MARK = `<img src="/brand/icon-64.png" width="28" height="28" alt="">`;
  const LINKS = [['/how', 'How it works'], ['/tokens', 'Tokens'], ['/docs', 'Docs'], ['/support', 'Support']];
  const path = location.pathname.replace(/\/$/, '') || '/';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const nav = document.getElementById('nav');
  if (nav) nav.innerHTML = `<div class="wrap navrow">
    <a class="brand" href="/">${MARK}<span>Claudeploy</span></a>
    <nav>${LINKS.map(([h, t]) => `<a href="${h}" class="${path === h ? 'active' : ''}">${t}</a>`).join('')}</nav>
    <div class="navright"><span id="navExtra"></span><a class="btn sm" href="/docs#connect">Add to Claude</a></div>
  </div>`;

  const footer = document.getElementById('footer');
  if (footer) footer.innerHTML = `<div class="wrap">
    <div class="cols">
      <div><a class="brand" href="/">${MARK}<span>Claudeploy</span></a><div class="small muted" style="margin-top:8px">Launch a token by talking to Claude. Then give it an agent that runs itself.</div></div>
      <div class="links">
        ${LINKS.map(([h, t]) => `<a href="${h}">${t}</a>`).join('')}
        <a href="/privacy">Privacy</a><a href="/terms">Terms</a>
        <a href="https://docs.ponsfamily.com/docs/v2" target="_blank" rel="noopener">pons docs</a>
        <span id="footSocial"></span>
      </div>
    </div>
    <div class="fine">Claudeploy is a connector for Claude. It builds and simulates transactions; your wallet signs them. It does not custody assets, does not hold keys, and does not give financial advice. Tokens launched here are created by their deployers. Claude is a trademark of Anthropic; Claudeploy is not affiliated with Anthropic or with pons.</div>
  </div>`;

  // Dados vivos: elementos com data-fill="chave" recebem o valor de /api/terms.
  window.siteTerms = fetch('/api/terms').then((r) => r.json()).then((t) => {
    const cap = `${(t.devBuyCapBps / 100).toFixed(0)}%`;
    const values = {
      mcpUrl: `${location.origin}/mcp`,
      host: location.host,
      fee: t.launchFeeEth,
      supply: Number(t.supply).toLocaleString('en-US'),
      cap,
      grad: t.graduatesAtEth,
      network: `${t.chain.name}${t.chain.isTestnet ? ' (testnet)' : ''}`,
      chainId: String(t.chain.id),
      rpc: t.chain.rpc,
      explorer: t.chain.explorer,
      factory: t.contracts.factory,
      router: t.contracts.router,
      maxTax: `${t.maxCreatorTaxBps / 100}%`,
      open: t.launchEnabled ? 'open to any wallet' : 'whitelisted wallets only',
    };
    document.querySelectorAll('[data-fill]').forEach((el) => {
      const v = values[el.dataset.fill];
      if (v != null) el.textContent = v;
    });
    // topo: X e o token oficial, ao lado do botao
    const extra = document.getElementById('navExtra');
    if (extra) {
      const X_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></svg>`;
      const parts = [];
      if (t.officialToken) {
        const a = t.officialToken.address;
        parts.push(`<a class="navtoken" href="${esc(t.officialToken.pons)}" target="_blank" rel="noopener" title="${esc(a)}">$${esc(t.officialToken.symbol)} <span class="mono">${esc(a.slice(0, 6))}…${esc(a.slice(-4))}</span></a><button class="navcopy" data-copy="${esc(a)}" title="Copy contract address">copy</button>`);
      }
      if (t.links?.x) parts.push(`<a class="navx" href="${esc(t.links.x)}" target="_blank" rel="noopener" aria-label="X">${X_ICON}</a>`);
      extra.innerHTML = parts.join('');
    }
    const social = document.getElementById('footSocial');
    if (social) {
      const l = t.links || {};
      social.innerHTML = [l.x && `<a href="${esc(l.x)}" target="_blank" rel="noopener">X</a>`,
        l.telegram && `<a href="${esc(l.telegram)}" target="_blank" rel="noopener">Telegram</a>`,
        l.email && `<a href="mailto:${esc(l.email)}">Email</a>`,
        t.repo && `<a href="${esc(t.repo)}" target="_blank" rel="noopener">Source</a>`].filter(Boolean).join(' ');
    }
    return t;
  }).catch(() => null);

  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-copy]');
    if (!btn) return;
    const target = document.querySelector(btn.dataset.copy);
    const text = target ? target.textContent.trim() : btn.dataset.copy;
    try { await navigator.clipboard.writeText(text); const old = btn.textContent; btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = old; }, 1400); } catch {}
  });

  window.siteEsc = esc;
})();
