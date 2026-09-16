# Claudearc (ex-Claudeploy)

No ar em **https://claudearc.com** (Argus na Arc). O nome do produto vem de
`APP_NAME` ou do venue: Claudearc na Argus, Claudeploy na pons. O símbolo da era
Arc é o "olho de Argus com o robô de pupila" (`brand/candidates-arc/A.png`,
peças em `public/brand/`, capa do X em `brand/x-cover-3000x1000.png`).

Lança token conversando com o Claude, em dois venues: **pons v2** (Robinhood
Chain) e **Argus** (Arc, a chain da Circle). É o equivalente do Brdy (ChatGPT)
do lado do Claude: um **conector MCP** que o usuário adiciona no claude.ai,
mais um site com página de assinatura onde a carteira dele assina. Projeto
independente, sem nada do Blizzard.

Repositório: https://github.com/ojotunn/CLAUDE

## Um código, dois deploys

`VENUE=argus` (padrão; é o que está em claudeploy.fun) ou `VENUE=pons`. Cada
processo serve um venue só, com o seu `DATA_DIR`. O site em modo Argus não cita
pons nem Ethereum; o venue pons continua no código e no serviço Railway antigo
(`claudeploy-production.up.railway.app`), sem domínio próprio. O que muda de um para o outro mora em `src/venues/pons.js` e
`src/venues/argus.js`; `src/chain.js` carrega um deles e o resto do código
(`launches.js`, `agent.js`, `mcp.js`, `server.js`, páginas) é comum. As páginas
HTML têm blocos `{{#pons}}…{{/pons}}` / `{{#argus}}…{{/argus}}` e variáveis
`{{CHAVE}}` que o servidor resolve.

| | pons v2 | Argus |
|---|---|---|
| chain | Robinhood Chain (4663), gás ETH | Arc (5042), gás **USDC** |
| mercado | bonding curve → Uniswap v4 na graduação | pool Uniswap v4 desde o primeiro trade; trava a liquidez a US$ 45k |
| lançamento | factory / launch-and-buy router, taxa da pons em ETH | portal da Argus; sem taxa de lançamento; taxa de compra/venda fixa (0–10% cada, ≥1 > 0) repartida entre criador, queima e liquidez |
| dev buy | na mesma tx (router), teto 5% do supply | na mesma tx (portal), `approve` de USDC antes, teto 5% |
| compra | `buy` na curva | Universal Router (V4_SWAP) + Permit2 (2 aprovações únicas, depois 1 assinatura) |
| agente | handover das creator fees (`transferCreatorFeeRecipient`) | **o agente lança o token** (criador não pode ser trocado na Argus); o dono manda USDC pra carteira dele |

## Como funciona

1. O usuário descreve o token no Claude. O Claude chama `preview_launch`, que
   simula o lançamento na chain (eth_call com state override) e devolve os
   termos: supply, taxa, dev buy e fatia do supply, custo total.
2. Com o "ok" do usuário, o Claude chama `prepare_launch`. O servidor guarda o
   pedido e devolve um link `/l/<id>`.
3. Na página, o usuário conecta a carteira (MetaMask, Rabby, Phantom EVM...).
   O servidor simula de novo **a partir dessa carteira**, mostra o endereço
   exato do token que vai nascer, estima gás e confere saldo. Na Argus, se há
   dev buy, a página pede primeiro o `approve` de USDC e depois o `launch`.
4. A carteira assina. O servidor espera o recibo, lê o evento `TokenLaunched`
   e o `launch_status` passa a devolver o CA para o chat.

Nenhuma chave do usuário passa pelo servidor. As únicas chaves aqui são as das
carteiras dos agentes, cifradas com `AGENT_SECRET`.

## O que a Argus é (lido da chain, 16/09/2026)

O fonte da Argus não está verificado e a doc do site fica atrás de um captcha,
então tudo em `src/venues/argus.js` foi reconstruído a partir do bytecode, do
storage e de transações reais, e conferido contra lançamentos reais:

- `portal.launch(params, meta, tokenSalt, hookSalt)` (seletor `0x11b8f0f1`).
  Struct: nome, ticker, supply (1e27), mcap inicial (US$ 2.500), mcap de bond
  (US$ 45.000), taxa compra, taxa venda, split (criador, queima, holders,
  liquidez), dev buy (USDC 6 casas), quote (USDC `0x3600…`), modo (1).
- token = CREATE2(portal, keccak(abi.encode(criador, tokenSalt)), clone EIP-1167
  do `tokenImpl`); splitter = `portal.predictSplitter(criador, tokenSalt)`.
- o hook é criado por CREATE2 com o creation code guardado num contrato-cofre
  (slot 4 do portal, começa com `0x00`), args (poolManager, portal, splitter,
  treasury, USDC, 10000, 200, buyTax, sellTax), salt keccak(abi.encode(criador,
  hookSalt)), e o endereço **precisa** terminar nos bits `0x2044`: o cliente
  minera o `hookSalt` (~250 ms aqui).
- dev buy = swap numa faixa única (TickMath portado em BigInt; 1% de fee no
  input, taxa de compra sobre a saída), batendo com os eventos `DevBuy` reais.
- fatia para holders (dividendos em USDC): o token só cria o tracker se
  `launchConfig.configFor(criador).rewardMode > 0`, cadastrado pela Argus
  (só a ubi.fun em 16/09). Carteira comum → erro claro antes de simular.
- fees do criador: `splitter.distribute()` (qualquer um) e
  `splitter.claim(criador)`; não há função para trocar o criador.
- state override funciona na RPC pública: saldo nativo, `allowance` do USDC
  (slot 10 do proxy) e `allowance` do Permit2 (slot 1).

## Rodar local

```
npm install
copy .env.example .env
npm start
```

Ou `START-Windows.bat`. Sobe em `http://localhost:8436`. Para a Argus:
`VENUE=argus` no `.env` (e outro `DATA_DIR`).

## Testes

```
npm test
```

Duas suítes, cada uma sobe o servidor de verdade numa porta livre, conecta um
cliente MCP e exercita o caminho inteiro contra a mainnet (só leitura e
simulação, nada assinado): `test/e2e.test.js` (pons, 24 provas) e
`test/argus.e2e.test.js` (Argus, 16 provas: termos, cotação com taxas e split,
clamp, erros, bind com endereço previsto e passo de approve, token info nos
dois lados da pool, compra pelo Universal Router com Permit2, lançamento pelo
agente, páginas, observador, matemática do Uniswap contra valores da chain).

## Conectar no Claude

Customize → Connectors → Add custom connector → colar `https://<dominio>/mcp`.
Funciona no Free (um conector), Pro e Max. No Team/Enterprise só o owner
adiciona.

## Deploy (Railway)

- Dockerfile pronto; `railway.toml` com healthcheck em `/api/health`.
- Um serviço por venue. Variáveis: `VENUE`, `PUBLIC_URL=https://<dominio>` (sem
  barra no fim), `DATA_DIR=/app/data` e um volume montado em `/app/data`.
- Agentes: `AGENT_SECRET` (nunca trocar), `TREASURY_ADDRESS`, `ANTHROPIC_API_KEY`.
- Opcionais: `LINK_X`, `LINK_TELEGRAM`, `SUPPORT_EMAIL`, `OTHER_VENUE_URL`,
  `OFFICIAL_TOKEN`, `CANONICAL_HOST`.

## Ferramentas do conector

| tool | o que faz |
|---|---|
| `launch_terms` | termos do venue (taxa, supply, teto de tax, contratos) |
| `preview_launch` | simula e devolve termos + custo (não guarda nada) |
| `prepare_launch` | guarda e devolve o link de assinatura (Argus: `withAgent` cria o agente e devolve o link de financiamento) |
| `launch_status` | estado por id; devolve o CA quando `live` |
| `token_info` | preço, mcap, progresso (graduação na pons, bond na Argus) |
| `prepare_buy` | link para comprar (curva na pons; pool v4 na Argus) |
| `recent_launches` | últimos lançamentos feitos pelo Claudeploy |
| `attach_agent` | pons: agente para token existente (handover). Argus: explica que o agente lança |
| `set_agent_rules`, `agent_status`, `ask_agent`, `release_agent` | regras, estado, pergunta, saída do agente |

## Limitações conhecidas

- Argus: fatia para holders só para lançadores cadastrados pela Argus.
- Argus: `explorer.arc.io` falha no curl do Windows por revogação de
  certificado, mas abre no navegador; a doc `argus.world/docs` está atrás de
  um Turnstile (não automatizável).
- Página de assinatura exige carteira injetada no navegador (ou o navegador
  interno da carteira no celular). Não há WalletConnect.
- O ciclo real do agente com dinheiro (pons e Argus) ainda não foi exercitado
  com saldo de verdade.
