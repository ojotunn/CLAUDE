// ABIs da Argus (Arc), reconstruidas a partir do bytecode e de transacoes
// reais em 16/09/2026 (o fonte nao esta verificado). Cada assinatura abaixo foi
// conferida: o seletor do launch bate com as transacoes na chain, os eventos
// foram lidos em recibos reais, e as views devolveram valores coerentes.
const str = (name) => ({ name, type: 'string' });
const addr = (name) => ({ name, type: 'address' });
const u256 = (name) => ({ name, type: 'uint256' });
const u16 = (name) => ({ name, type: 'uint16' });
const bool = (name) => ({ name, type: 'bool' });
const view = (name, inputs, outputs) => ({ type: 'function', name, stateMutability: 'view', inputs, outputs });
const err = (name, inputs = []) => ({ type: 'error', name, inputs });

// Struct do lancamento. Ordem dos campos confirmada no calldata:
// nome, ticker, supply, mcap inicial, mcap de bond (USDC, 6 casas), taxa de
// compra, taxa de venda, split (criador, queima, holders, liquidez), dev buy
// (USDC, 6 casas), quote e um modo (sempre 1 nos lancamentos observados).
export const LAUNCH_PARAMS = {
  name: 'p', type: 'tuple', components: [
    str('name'), str('symbol'), u256('supply'), u256('startMcap'), u256('bondMcap'),
    u16('buyTaxBps'), u16('sellTaxBps'), u16('creatorBps'), u16('burnBps'), u16('holdersBps'), u16('liquidityBps'),
    u256('devBuy'), addr('quote'), { name: 'mode', type: 'uint8' },
  ],
};
export const LAUNCH_META = {
  name: 'm', type: 'tuple', components: [str('image'), str('website'), str('twitter'), str('telegram'), str('description')],
};

export const PORTAL_ERRORS = [
  err('QuoteNotApproved'), err('QuoteConsumed'), err('SupplyTooLarge'), err('ZeroAddress'), err('NotAdmin'),
  err('PoolMispriced'), err('NotSingleSided'), err('PositionNotDelivered'), err('PositionRangeMismatch'), err('PositionLiquidityMismatch'),
  err('ReentrancyGuardReentrantCall'), err('FailedDeployment'), err('UnexpectedCallback'),
  // Construtor do hook (revertem dentro do launch)
  err('HookAddressMismatch', [addr('hook')]), err('TaxTooHigh'), err('NoTax'),
  err('InsufficientBalance', [u256('balance'), u256('needed')]), err('SafeERC20FailedOperation', [addr('token')]),
  // 0xf44fdf02: o portal exige o tracker de dividendos quando ha fatia para holders e o lancador nao tem rewardMode
  { type: 'error', name: 'RewardTrackerMissing_0xf44fdf02', inputs: [] },
];

export const PORTAL_ABI = [
  { type: 'function', name: 'launch', stateMutability: 'nonpayable', inputs: [LAUNCH_PARAMS, LAUNCH_META, { name: 'tokenSalt', type: 'bytes32' }, { name: 'hookSalt', type: 'bytes32' }], outputs: [addr('token')] },
  view('launches', [addr('token')], [
    addr('creator'), { name: 'startTick', type: 'int24' }, bool('tokenIsCurrency0'), addr('locker'), addr('hook'), addr('splitter'),
    u16('buyTaxBps'), u16('sellTaxBps'), u256('positionId'), { name: 'bondTick', type: 'int24' }, addr('quote'),
  ]),
  view('predictSplitter', [addr('creator'), { name: 'tokenSalt', type: 'bytes32' }], [addr('')]),
  view('treasury', [], [addr('')]),
  view('treasuryBps', [], [u256('')]),
  view('MAX_TAX_BPS', [], [u256('')]),
  view('devBuyMaxBps', [], [u256('')]),
  view('defaultQuoteAsset', [], [addr('')]),
  view('tokenCount', [], [u256('')]),
  view('tokenImpl', [], [addr('')]),
  view('launchConfig', [], [addr('')]),
  view('poolManager', [], [addr('')]),
  view('POOL_FEE', [], [{ name: '', type: 'uint24' }]),
  view('TICK_SPACING', [], [{ name: '', type: 'int24' }]),
  {
    type: 'event', name: 'TokenLaunched', anonymous: false, inputs: [
      { indexed: true, name: 'token', type: 'address' }, { indexed: true, name: 'creator', type: 'address' },
      { indexed: false, name: 'name', type: 'string' }, { indexed: false, name: 'symbol', type: 'string' }, { indexed: false, name: 'poolId', type: 'bytes32' },
      { indexed: false, name: 'image', type: 'string' }, { indexed: false, name: 'website', type: 'string' }, { indexed: false, name: 'twitter', type: 'string' }, { indexed: false, name: 'telegram', type: 'string' },
    ],
  },
  {
    type: 'event', name: 'DevBuy', anonymous: false, inputs: [
      { indexed: true, name: 'token', type: 'address' }, { indexed: true, name: 'buyer', type: 'address' },
      { indexed: false, name: 'quoteIn', type: 'uint256' }, { indexed: false, name: 'tokensOut', type: 'uint256' },
    ],
  },
  ...PORTAL_ERRORS,
];

// Configuracao por lancador (token.launchConfig()). rewardMode 1 = cria o tracker de
// dividendos (fatia para holders). So a Argus cadastra lancadores nele.
export const LAUNCH_CONFIG_ABI = [
  view('configFor', [addr('creator')], [{ name: 'rewardMode', type: 'uint8' }, { name: 'flags', type: 'uint8' }]),
];

export const HOOK_ABI = [
  view('bonded', [], [bool('')]),
  view('launchedAt', [], [u256('')]),
  view('buyTaxBps', [], [u16('')]),
  view('sellTaxBps', [], [u16('')]),
  view('currentSnipeTaxBps', [], [u256('')]),
  view('poolId', [], [{ name: '', type: 'bytes32' }]),
  view('splitter', [], [addr('')]),
  view('quoteIsToken0', [], [bool('')]),
];

export const SPLITTER_ABI = [
  view('creator', [], [addr('')]),
  view('creatorBps', [], [u256('')]),
  view('burnBps', [], [u256('')]),
  view('dividendBps', [], [u256('')]),
  view('liquidityBps', [], [u256('')]),
  view('treasuryBps', [], [u256('')]),
  view('poolId', [], [{ name: '', type: 'bytes32' }]),
  view('hook', [], [addr('')]),
  view('locker', [], [addr('')]),
  // Reparte o que entrou (USDC e tokens de taxa) entre criador, queima, holders,
  // liquidez e tesouro. Qualquer um pode chamar. Devolve (quote, tokens) repartidos.
  { type: 'function', name: 'distribute', stateMutability: 'nonpayable', inputs: [], outputs: [u256('quote'), u256('tokens')] },
  // Paga ao beneficiario o que esta creditado para ele. Qualquer um pode chamar.
  { type: 'function', name: 'claim', stateMutability: 'nonpayable', inputs: [addr('beneficiary')], outputs: [] },
  err('NothingToClaim'), err('NoRoute'), err('NoKeeper'), err('TierDisabled'), err('QuoteOverspent'), err('PayoutAssetMismatch'),
];

export const STATE_VIEW_ABI = [
  view('getSlot0', [{ name: 'poolId', type: 'bytes32' }], [{ name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' }, { name: 'protocolFee', type: 'uint24' }, { name: 'lpFee', type: 'uint24' }]),
  view('getLiquidity', [{ name: 'poolId', type: 'bytes32' }], [{ name: 'liquidity', type: 'uint128' }]),
];

export const ERC20_ABI = [
  view('name', [], [str('')]),
  view('symbol', [], [str('')]),
  view('decimals', [], [{ name: '', type: 'uint8' }]),
  view('totalSupply', [], [u256('')]),
  view('balanceOf', [addr('owner')], [u256('')]),
  view('allowance', [addr('owner'), addr('spender')], [u256('')]),
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [addr('to'), u256('amount')], outputs: [bool('')] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [addr('spender'), u256('amount')], outputs: [bool('')] },
];

export const PERMIT2_ABI = [
  view('allowance', [addr('owner'), addr('token'), addr('spender')], [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }]),
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [addr('token'), addr('spender'), { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }], outputs: [] },
];

// Universal Router (versao com sqrtPriceLimitX96 no ExactInputSingleParams,
// conferida contra uma compra real na Arc).
export const UR_ABI = [
  { type: 'function', name: 'execute', stateMutability: 'payable', inputs: [{ name: 'commands', type: 'bytes' }, { name: 'inputs', type: 'bytes[]' }, { name: 'deadline', type: 'uint256' }], outputs: [] },
  err('V4TooLittleReceived', [u256('minAmountOutReceived'), u256('amountReceived')]),
  err('V4TooMuchRequested', [u256('maxAmountInRequested'), u256('amountRequested')]),
  err('TransactionDeadlinePassed'), err('ExecutionFailed', [u256('commandIndex'), { name: 'message', type: 'bytes' }]),
  err('AllowanceExpired', [u256('deadline')]), err('InsufficientAllowance', [u256('amount')]),
  err('HookAddressNotValid', [addr('hooks')]), err('CurrencyNotSettled'), err('DeltaNotPositive', [addr('currency')]), err('DeltaNotNegative', [addr('currency')]),
];
export const V4_SWAP_PARAMS = [{
  type: 'tuple', components: [
    { type: 'tuple', name: 'poolKey', components: [addr('currency0'), addr('currency1'), { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, addr('hooks')] },
    bool('zeroForOne'), { name: 'amountIn', type: 'uint128' }, { name: 'amountOutMinimum', type: 'uint128' }, { name: 'sqrtPriceLimitX96', type: 'uint160' }, { name: 'hookData', type: 'bytes' },
  ],
}];

export const TRANSFER_EVENT = { type: 'event', name: 'Transfer', inputs: [{ indexed: true, name: 'from', type: 'address' }, { indexed: true, name: 'to', type: 'address' }, { indexed: false, name: 'value', type: 'uint256' }] };
// PoolManager.Swap(id, sender, amount0, amount1, sqrtPriceX96, liquidity, tick, fee)
export const SWAP_EVENT = {
  type: 'event', name: 'Swap', inputs: [
    { indexed: true, name: 'id', type: 'bytes32' }, { indexed: true, name: 'sender', type: 'address' },
    { indexed: false, name: 'amount0', type: 'int128' }, { indexed: false, name: 'amount1', type: 'int128' },
    { indexed: false, name: 'sqrtPriceX96', type: 'uint160' }, { indexed: false, name: 'liquidity', type: 'uint128' }, { indexed: false, name: 'tick', type: 'int24' }, { indexed: false, name: 'fee', type: 'uint24' },
  ],
};

export const ALL_ERRORS = [...PORTAL_ERRORS, ...SPLITTER_ABI.filter((x) => x.type === 'error'), ...UR_ABI.filter((x) => x.type === 'error')];
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD';
