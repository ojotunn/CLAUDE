// Configuracao do Claudeploy/Claudearc: venue (pons ou Argus), rede, contratos e limites.
// Um processo serve UM venue, escolhido por VENUE=argus|pons (padrao: argus). Cada deploy tem
// o seu DATA_DIR, porque os registros de um venue nao fazem sentido no outro.
import path from 'node:path';

export const VENUE = process.env.VENUE === 'pons' ? 'pons' : 'argus';

// ---------------------------------------------------------------------------
// pons v2 na Robinhood Chain.
const PONS = {
  venue: 'pons',
  name: 'pons v2',
  short: 'pons',
  chain: {
    id: 4663, name: 'Robinhood Chain',
    rpc: process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
    explorer: 'https://robinhoodchain.blockscout.com',
    native: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  },
  // Unidade em que o usuario fala de valores (dev buy, compras, taxas do agente).
  quote: { symbol: 'ETH', decimals: 18 },
  // Contratos (docs.ponsfamily.com/docs/v2). A pons versiona factory + router.
  contracts: {
    factory: process.env.PONS_FACTORY || '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
    router: process.env.PONS_LAUNCH_AND_BUY || '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948',
    feeEscrow: process.env.PONS_FEE_ESCROW || '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
  },
  tokenUrl: process.env.PONS_TOKEN_URL || 'https://www.ponsfamily.com/launchpad/{token}',
  docsUrl: 'https://docs.ponsfamily.com/docs/v2',
  market: 'bonding curve',
};

// ---------------------------------------------------------------------------
// Argus na Arc (chain da Circle; o gas e USDC). Sem curva: o token nasce numa
// pool Uniswap v4 com taxa fixa, repartida entre criador, queima, holders e
// liquidez. Enderecos lidos da chain em 16/09/2026 (portal em slot/views).
const ARGUS = {
  venue: 'argus',
  name: 'Argus',
  short: 'Argus',
  chain: {
    id: 5042, name: 'Arc',
    rpc: process.env.RPC_URL || 'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
    native: { name: 'USD Coin', symbol: 'USDC', decimals: 18 },
  },
  quote: { symbol: 'USDC', decimals: 6 },
  contracts: {
    portal: process.env.ARGUS_PORTAL || '0xB021Be536808f551b31789422Fd28a6c9c6e97Da',
    // Cofre com o creation code do hook (portal.slot 4). Comeca com 0x00.
    hookCode: process.env.ARGUS_HOOK_CODE || '0xe5815bd5584eb18e8b37157f26c732df1445a944',
    tokenImpl: process.env.ARGUS_TOKEN_IMPL || '0x1b74922c01ddfd9c77b37d02c0a236611e8fe500',
    poolManager: '0x8366a39CC670B4001A1121B8F6A443A643e40951',
    stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b',
    universalRouter: '0x4fcA4a51Ab4F23A7447b3284fBd7D73289A89Fb1',
    permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
    usdc: '0x3600000000000000000000000000000000000000',
  },
  tokenUrl: process.env.ARGUS_TOKEN_URL || 'https://argus.world/token/{token}',
  docsUrl: 'https://argus.world/docs',
  market: 'Uniswap v4 pool',
};

export const VENUES = { pons: PONS, argus: ARGUS };
export const V = VENUES[VENUE];
export const CHAIN = { ...V.chain, network: 'mainnet', isTestnet: false };
export const CONTRACTS = V.contracts;
export const QUOTE = V.quote;
export const NATIVE = V.chain.native;
export const TOKEN_URL = V.tokenUrl;

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const LIMITS = {
  // Teto da dev buy em pontos-base do supply total (500 = 5%).
  maxDevBuyBps: Number(process.env.MAX_DEV_BUY_BPS || 500),
  // pons: creator tax padrao 0. Argus: a taxa e obrigatoria (pelo menos uma
  // perna > 0), padrao 3% compra / 3% venda, como a maioria dos lancamentos la.
  defaultCreatorTaxBps: Number(process.env.DEFAULT_CREATOR_TAX_BPS || (VENUE === 'argus' ? 300 : 0)),
  // Um lancamento preparado e nao assinado expira; os termos do protocolo podem mudar.
  launchTtlMs: Number(process.env.LAUNCH_TTL_HOURS || 24) * 3600 * 1000,
  launchConfigId: BigInt(process.env.PONS_LAUNCH_CONFIG_ID || 0),
  // Argus: parametros fixos por lancamento (os mesmos do site da Argus).
  argusSupply: 10n ** 27n,               // 1 bilhao, 18 casas
  argusStartMcap: 2_500_000000n,         // abre a US$ 2.500 (USDC, 6 casas)
  argusBondMcap: 45_000_000000n,         // trava permanente a US$ 45.000
};

export const PORT = Number(process.env.PORT || 8436);
export const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
export const APP_NAME = process.env.APP_NAME || (VENUE === 'argus' ? 'Claudearc' : 'Claudeploy');
export const VERSION = '0.2.0';
// Link do codigo-fonte no rodape. Vazio = o site nao expoe repositorio nenhum.
export const REPO_URL = process.env.REPO_URL || null;
// Contatos mostrados no rodape e na pagina de suporte (vazio = nao mostra).
export const LINKS = {
  x: process.env.LINK_X || null,
  telegram: process.env.LINK_TELEGRAM || null,
  email: process.env.SUPPORT_EMAIL || null,
};
// Token oficial da casa (lancado fora do fluxo): aparece no topo do site.
export const OFFICIAL_TOKEN = /^0x[0-9a-fA-F]{40}$/.test(process.env.OFFICIAL_TOKEN || '')
  ? { address: process.env.OFFICIAL_TOKEN, symbol: (process.env.OFFICIAL_SYMBOL || (VENUE === 'argus' ? 'CLAUDEARC' : 'CLAUDEPLOY')).replace(/^\$/, '').toUpperCase() }
  : null;
