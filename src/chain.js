// A camada de chain e um venue: pons (Robinhood Chain) ou Argus (Arc). Quem
// importa daqui nao sabe qual; so um deles e carregado, escolhido por VENUE.
// Os dois modulos expoem a mesma interface (ver venues/pons.js como referencia).
import { VENUE } from './config.js';

const venue = await import(VENUE === 'argus' ? './venues/argus.js' : './venues/pons.js');

export const {
  NAME, SHORT, MARKET, DOCS_URL, supportsHandover, agentMustLaunch,
  chain, client, links,
  parseAmount, formatAmount, quoteSymbol,
  protocolTerms, termsSummary, canLaunch, holdersShareAllowed,
  quoteLaunch, quoteBuy, fundingCheck, fundingCheckBuy,
  simulate, estimateGas, getBalance, explainRevert,
  getTransaction, waitForReceipt, tokenInfo,
  buildHandoverTx, launchedToken, feeRecipient,
  newAgentKey, agentWrite, agentSendNative, agentSendEth, agentBalance, agentTransferTokens, tokenBalance, burnAddress, escrowBalance,
  AGENT_DEFAULTS, fundingTx, marketFlags, collectFees, pendingFees, buyTokens, recentBuyers, blockNumber, blockHash, buysBetween, sellersSince, releaseToOwner, agentLaunch,
  verifySignedMessage, formatEther, formatUnits, getAddress, ERC20_ABI, DEAD_ADDRESS, QuoteError,
} = venue;
export const VENUE_ID = venue.VENUE;
export const parseEther = venue.parseEther ?? null;
