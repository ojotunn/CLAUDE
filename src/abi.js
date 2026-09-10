// ABIs da pons v2, conferidas no fonte verificado (Sourcify, chain 4663):
// PonsV2LaunchFactory, PonsV2LaunchAndBuy (router) e PonsV2BondingCurve.
const str = (name) => ({ name, type: 'string' });
const addr = (name) => ({ name, type: 'address' });
const u256 = (name) => ({ name, type: 'uint256' });
const bool = (name) => ({ name, type: 'bool' });
const view = (name, inputs, outputs) => ({ type: 'function', name, stateMutability: 'view', inputs, outputs });
const err = (name, inputs = []) => ({ type: 'error', name, inputs });

export const TOKEN_PARAMS = {
  name: 'params', type: 'tuple', components: [
    str('name'), str('symbol'), str('logo'), str('description'),
    { name: 'socials', type: 'tuple', components: [str('twitter'), str('telegram'), str('discord'), str('website'), str('farcaster')] },
    addr('creatorFeeRecipient'), { name: 'creatorTaxBps', type: 'uint16' }, bool('buybackEnabled'),
    { name: 'expectedEconomics', type: 'bytes32' }, { name: 'salt', type: 'bytes32' },
  ],
};

export const LAUNCHED_TOKEN = {
  name: '', type: 'tuple', components: [
    addr('token'), addr('curve'), addr('deployer'), addr('creatorFeeRecipient'), addr('pairToken'),
    u256('graduationThreshold'), { name: 'poolFee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' },
    { name: 'creatorTaxBps', type: 'uint16' }, bool('buybackEnabled'), { name: 'phase', type: 'uint8' },
    u256('sweptQuote'), u256('sweptTokens'), u256('sweptAt'), bool('exists'),
  ],
};

export const FACTORY_ERRORS = [
  err('CreatorTaxTooHigh'), err('InvalidLaunchConfigId'), err('InvalidTokenParams'), err('LaunchConfigDisabled'),
  err('LaunchDependenciesNotWired'), err('LaunchDeployerNotSet'), err('LaunchFeeNotPaid'), err('NotWhitelisted'),
  err('PairTokenNotApproved'), err('ExemptionListTooLong'), err('NotLaunchForwarder'), err('ZeroAddress'), err('ZeroAmount'),
  err('CombinedFeeTooHigh'), err('CurveNotQuotable'), err('SupplyTooHigh'), err('SupplyTooLow'),
  err('LaunchEconomicsMismatch', [{ name: 'expected', type: 'bytes32' }, { name: 'actual', type: 'bytes32' }]),
  err('ReentrancyGuardReentrantCall'),
];

export const ROUTER_ERRORS = [
  err('NotApprovedLauncher'), err('RefundFailed'),
  err('NativeValueMismatch', [u256('sent'), u256('expected')]),
];

export const FACTORY_ABI = [
  {
    type: 'function', name: 'launchToken', stateMutability: 'payable',
    inputs: [TOKEN_PARAMS, u256('launchConfigId'), addr('pairToken')],
    outputs: [addr('token'), addr('curve')],
  },
  view('launchFee', [], [u256('')]),
  view('launchEnabled', [], [bool('')]),
  view('canLaunch', [addr('launcher')], [bool('')]),
  view('launchConfigCount', [], [u256('')]),
  view('maxCreatorTaxBps', [], [u256('')]),
  view('previewLaunchEconomics', [u256('launchConfigId'), addr('pairToken')], [{ name: '', type: 'bytes32' }]),
  view('getLaunchConfig', [u256('id')], [{
    name: '', type: 'tuple', components: [
      u256('supply'), u256('curveFeeBps'), u256('phantomQuote'), u256('graduationThreshold'),
      { name: 'poolFee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, bool('enabled'),
    ],
  }]),
  view('getLaunchedToken', [addr('token')], [LAUNCHED_TOKEN]),
  {
    type: 'event', name: 'TokenLaunched', anonymous: false, inputs: [
      { indexed: true, name: 'token', type: 'address' },
      { indexed: true, name: 'curve', type: 'address' },
      { indexed: true, name: 'deployer', type: 'address' },
      { indexed: false, name: 'pairToken', type: 'address' },
      { indexed: false, name: 'launchConfigId', type: 'uint256' },
      { indexed: false, name: 'graduationThreshold', type: 'uint256' },
    ],
  },
  ...FACTORY_ERRORS,
];

export const ROUTER_ABI = [
  {
    type: 'function', name: 'launchAndBuy', stateMutability: 'payable',
    inputs: [TOKEN_PARAMS, u256('launchConfigId'), addr('pairToken'), u256('quoteIn'), u256('minTokensOut'), addr('recipient'),
      { name: 'snipeTaxExemptions', type: 'address[]' }],
    outputs: [addr('token'), addr('curve'), u256('tokensOut')],
  },
  {
    type: 'event', name: 'Launched', anonymous: false, inputs: [
      { indexed: true, name: 'token', type: 'address' },
      { indexed: true, name: 'curve', type: 'address' },
      { indexed: true, name: 'recipient', type: 'address' },
      { indexed: false, name: 'launcher', type: 'address' },
      { indexed: false, name: 'quoteSpent', type: 'uint256' },
      { indexed: false, name: 'tokensReceived', type: 'uint256' },
    ],
  },
  ...ROUTER_ERRORS,
  ...FACTORY_ERRORS,
];

export const CURVE_ABI = [
  {
    type: 'function', name: 'buy', stateMutability: 'payable',
    inputs: [u256('quoteIn'), u256('minTokensOut'), addr('recipient')], outputs: [u256('tokensOut')],
  },
  view('getReserves', [], [u256('quoteReserve'), u256('tokenReserve')]),
  view('realQuoteReserve', [], [u256('')]),
  view('sellableTokens', [], [u256('')]),
  view('graduationThreshold', [], [u256('')]),
  view('feeBps', [], [u256('')]),
  view('creatorTaxBps', [], [u256('')]),
  view('currentSnipeTaxBps', [addr('recipient')], [u256('')]),
  view('graduated', [], [bool('')]),
  view('readyToGraduate', [], [bool('')]),
  view('isNativeQuote', [], [bool('')]),
  {
    type: 'event', name: 'CurveBuy', anonymous: false, inputs: [
      { indexed: true, name: 'buyer', type: 'address' },
      { indexed: true, name: 'recipient', type: 'address' },
      { indexed: false, name: 'quoteIn', type: 'uint256' },
      { indexed: false, name: 'tokensOut', type: 'uint256' },
      { indexed: false, name: 'fee', type: 'uint256' },
      { indexed: false, name: 'tax', type: 'uint256' },
    ],
  },
];

export const ERC20_ABI = [
  view('name', [], [str('')]),
  view('symbol', [], [str('')]),
  view('totalSupply', [], [u256('')]),
  view('balanceOf', [addr('owner')], [u256('')]),
];

export const ALL_ERRORS = [...FACTORY_ERRORS, ...ROUTER_ERRORS];
