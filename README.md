# Pronto

Lança token na pons (Robinhood Chain, pons v2) conversando com o Claude. É o
equivalente do Brdy (ChatGPT) do lado do Claude: um **conector MCP** que o
usuário adiciona no claude.ai, mais uma página de assinatura onde a carteira
dele assina. Projeto independente, sem nada do Blizzard.

## Como funciona

1. O usuário descreve o token no Claude. O Claude chama `preview_launch`, que
   simula o lançamento na chain (eth_call com state override) e devolve os
   termos: supply, taxa da pons, dev buy e fatia do supply, custo total.
2. Com o "ok" do usuário, o Claude chama `prepare_launch`. O servidor guarda o
   pedido e devolve um link `/l/<id>`.
3. Na página, o usuário conecta a carteira (MetaMask, Rabby, Phantom EVM...).
   O servidor simula de novo **a partir dessa carteira**, mostra o endereço
   exato do token que vai nascer, estima gás e confere saldo.
4. A carteira assina uma transação. Com dev buy, vai pelo **launch-and-buy
   router** da pons (lançamento + compra na mesma transação, sem janela para
   sniper). Sem dev buy, vai direto na factory.
5. O servidor espera o recibo, lê o evento `TokenLaunched` e o `launch_status`
   passa a devolver o CA para o chat.

Nenhuma chave passa pelo servidor. Ele só monta calldata e assiste.

## Rodar local

```
npm install
copy .env.example .env
npm start
```

Ou `START-Windows.bat`. Sobe em `http://localhost:8436`. O endpoint do conector
é `http://localhost:8436/mcp`, mas o claude.ai precisa de uma URL pública
(HTTPS), então local serve só para testar com o cliente MCP.

## Testes

```
npm test
```

Sobe o servidor de verdade numa porta livre, conecta um cliente MCP e exercita
o caminho inteiro contra a mainnet (só leitura e simulação, nada assinado):
handshake, termos, prévia com e sem dev buy, clamp do teto de 5%, preparação,
página de assinatura, bind de carteira com endereço previsto, status, token
info e compra na curva.

## Conectar no Claude

Customize → Connectors → Add custom connector → colar `https://<dominio>/mcp`.
Funciona no Free (um conector), Pro e Max. No Team/Enterprise só o owner
adiciona. Para aparecer no diretório oficial precisa de organização
Team/Enterprise e passar pela revisão.

## Deploy (Railway)

- Dockerfile pronto; `railway.toml` com healthcheck em `/api/health`.
- Variáveis: `PUBLIC_URL=https://<dominio>` (sem barra no fim), `DATA_DIR=/app/data`
  e um volume montado em `/app/data`. Sem volume os lançamentos somem no redeploy.
- `PORT` o Railway injeta.

## Ferramentas do conector

| tool | o que faz |
|---|---|
| `launch_terms` | taxa, supply, teto de creator tax, se está aberto a todos |
| `preview_launch` | simula e devolve termos + custo (não guarda nada) |
| `prepare_launch` | guarda e devolve o link de assinatura |
| `launch_status` | estado por id; devolve o CA quando `live` |
| `token_info` | preço, ETH captado, progresso de graduação de qualquer token pons v2 |
| `prepare_buy` | link para comprar na curva de um token já lançado |
| `recent_launches` | últimos lançamentos feitos pelo Pronto |

## Regras embutidas

- Dev buy limitada a `MAX_DEV_BUY_BPS` do supply (padrão 5%); acima disso o
  servidor reduz por busca binária e avisa.
- `expectedEconomics` pinado: se a pons mudar os termos entre a prévia e a
  assinatura, a transação reverte em vez de repreçar.
- Slippage: 1% no dev buy (curva nasce na mesma transação), 3% na compra avulsa.
- Link expira em `LAUNCH_TTL_HOURS` (24h).
- `canLaunch(wallet)` é checado: a pons pode ligar whitelist a qualquer momento.

## Limitações conhecidas

- Só par nativo (ETH). Lançamentos pareados com ERC-20 não são oferecidos.
- Compra só na bonding curve. Depois da graduação (Uniswap v4) o `prepare_buy`
  recusa.
- Página de assinatura exige carteira injetada no navegador (ou o navegador
  interno da carteira no celular). Não há WalletConnect.
- A URL da página do token na pons (`PONS_TOKEN_URL`) foi verificada com
  `/launchpad/<endereço>`; se a pons mudar, é uma variável.
- Testnet: `PONS_NETWORK=testnet` troca chain e RPC, mas a pons não publica os
  endereços dos contratos lá; precisam vir por env.
