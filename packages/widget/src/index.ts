// @credence/widget: embed gap protection next to a lending position. The host owns the connection and the wallet; the widget
// never creates a connection, never holds a key and never signs on its own.
export { CredenceProtect, GapLine, RiskTable, QuoteBuy, CoverStatus, type CredenceProtectProps } from './components';
export { loadPosition, type LoadOptions, type ProtectState } from './load';
export { quoteFor, type WidgetQuote } from './quote';
export { buildPurchase, type Built } from './build';
export { purchase, type PurchaseResult } from './purchase';
export { followPolicy, type PolicyEvent } from './status';
export { MAINNET_GENESIS, assertSupportedCluster, assertProgram } from './cluster';
export { InputError, ProgramMismatchError, SingleCopyError, UnsupportedClusterError, UnsupportedPositionError } from './errors';
export { parseLender, toPublicKey, type Lender } from './inputs';
export { fmtUsdc, fmtAge } from './format';
export type { WalletLike } from './types';
