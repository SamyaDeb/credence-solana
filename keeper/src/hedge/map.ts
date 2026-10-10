// The vault's xStocks and the venue instruments that stand for them (D3, testnet hedge, research). An index perp for an ETF
// token (SP500 for SPYx, XYZ100 for QQQx) is a hedge with basis risk, not an identity: the program cross-checks every
// leg's return against the lender oracle's, within the tolerance in `HedgeConfig`, and refuses what disagrees.
export const INSTRUMENT: Record<string, string> = {
  SPYx: 'xyz:SP500',
  QQQx: 'xyz:XYZ100',
  NVDAx: 'xyz:NVDA',
  TSLAx: 'xyz:TSLA',
  GOOGLx: 'xyz:GOOGL',
  AAPLx: 'xyz:AAPL',
  MSTRx: 'xyz:MSTR',
  HOODx: 'xyz:HOOD',
};
