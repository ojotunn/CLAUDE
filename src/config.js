// Configuracao do Pronto: rede, contratos da pons v2 e limites do produto.
// Tudo que e endereco pode ser sobrescrito por variavel de ambiente, porque a
// pons versiona os contratos (factory + router novos a cada versao).
import path from 'node:path';

export const NETWORKS = {
  mainnet: {
    id: 4663,
    name: 'Robinhood Chain',
    rpc: 'https://rpc.mainnet.chain.robinhood.com',
    explorer: 'https://robinhoodchain.blockscout.com',
  },
  testnet: {
    id: 46630,
    name: 'Robinhood Chain Testnet',
    rpc: 'https://rpc.testnet.chain.robinhood.com',
    explorer: 'https://explorer.testnet.chain.robinhood.com',
  },
};

const NETWORK = process.env.PONS_NETWORK === 'testnet' ? 'testnet' : 'mainnet';
const NET = NETWORKS[NETWORK];

export const CHAIN = {
  id: NET.id,
  network: NETWORK,
  name: NET.name,
  rpc: process.env.RPC_URL || NET.rpc,
  explorer: NET.explorer,
  isTestnet: NETWORK === 'testnet',
};

// pons v2 na mainnet (docs.ponsfamily.com/docs/v2). Na testnet os enderecos
// precisam vir por env; a pons nao publica.
export const CONTRACTS = {
  factory: process.env.PONS_FACTORY || '0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e',
  router: process.env.PONS_LAUNCH_AND_BUY || '0xe33E9E479dF8802cb0866d5d05258bEc4cF62948',
  feeEscrow: process.env.PONS_FEE_ESCROW || '0xd3AFEB2a57f70eF218Aa82451c51B2fb0416Ac9e',
};

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const LIMITS = {
  // Teto da dev buy em pontos-base do supply total (500 = 5%).
  maxDevBuyBps: Number(process.env.MAX_DEV_BUY_BPS || 500),
  defaultCreatorTaxBps: Number(process.env.DEFAULT_CREATOR_TAX_BPS || 0),
  // Um lancamento preparado e nao assinado expira; os termos da pons podem mudar.
  launchTtlMs: Number(process.env.LAUNCH_TTL_HOURS || 24) * 3600 * 1000,
  launchConfigId: BigInt(process.env.PONS_LAUNCH_CONFIG_ID || 0),
};

export const PORT = Number(process.env.PORT || 8436);
export const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
export const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
// Pagina do token na pons. {token} e substituido pelo endereco.
export const PONS_TOKEN_URL = process.env.PONS_TOKEN_URL || 'https://www.ponsfamily.com/launchpad/{token}';
export const APP_NAME = 'Cladeployer';
export const VERSION = '0.1.0';
export const REPO_URL = 'https://github.com/ojotunn/CLAUDE';
// Contatos mostrados no rodape e na pagina de suporte (vazio = nao mostra).
export const LINKS = {
  x: process.env.LINK_X || null,
  telegram: process.env.LINK_TELEGRAM || null,
  email: process.env.SUPPORT_EMAIL || null,
};
