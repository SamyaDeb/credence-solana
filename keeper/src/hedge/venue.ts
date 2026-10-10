// The hedge venue interface (D3, testnet hedge, research). The keeper hedges through this and nothing else: one adapter
// per venue, today one (hyperliquid.ts, TESTNET ONLY). Amounts: notional and P&L in USDC with 6 decimals as bigint; prices
// are decimal strings in the venue's own scale (only the ratio of entry to exit is used on-chain).

export type HedgeLegOrder = {
  /** The xStock ticker the vault is exposed to (SPYx), for reporting. */
  ticker: string;
  /** The venue instrument that stands for it (xyz:SP500). */
  instrument: string;
  /** USDC base units of the short to open. */
  notional: bigint;
};

export type Fill = {
  instrument: string;
  side: 'sell' | 'buy';
  px: string;
  sz: string;
  /** Venue time, ms. */
  time: number;
  /** Fee paid, USDC (decimal string, may be negative for a rebate). */
  fee: string;
  /** Realised P&L the venue booked on this fill, USDC, before fees. */
  closedPnl: string;
  oid: number;
  hash: string;
};

export type Position = { instrument: string; sz: string; entryPx: string; marginUsed: string };

export type OpenResult = { ticker: string; instrument: string; filledSz: string; avgPx: string; notional: bigint };
export type CloseResult = { instrument: string; filledSz: string; avgPx: string };

export interface HedgeVenue {
  readonly name: string;
  /** Sells (shorts) each leg at the market, IOC with a price band. Throws if a leg does not fill completely. */
  openHedge(legs: HedgeLegOrder[]): Promise<OpenResult[]>;
  /** Buys back every open position of the hedge instruments, reduce-only. */
  closeHedge(instruments: string[]): Promise<CloseResult[]>;
  /** Which of `instruments` the venue lists and trades today (a delisted or missing one is dropped, not an error). */
  listed(instruments: string[]): Promise<string[]>;
  positions(): Promise<Position[]>;
  /** The account's fills since `sinceMs`. */
  fills(sinceMs: number): Promise<Fill[]>;
  /** Funding paid (−) or received (+) on the instruments since `sinceMs`, USDC as a decimal string. */
  funding(sinceMs: number, instruments: string[]): Promise<string>;
}

/** Decimal USDC string -> base units, rounded toward the loss side of a P&L (floor of the signed value). */
export function usdcToBase(s: string): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`not a decimal: ${s}`);
  const frac = (m[3] ?? '').padEnd(6, '0');
  let v = BigInt(m[2]) * 1_000_000n + BigInt(frac.slice(0, 6));
  const rest = frac.slice(6).replace(/0+$/, '') !== '';
  if (m[1]) {
    v = -v;
    if (rest) v -= 1n;
  }
  return v;
}

/** The weekend's net P&L from the venue's own records: Σ closedPnl − Σ fees + funding, in USDC base units, floored. */
export function netPnl(fills: Fill[], funding: string): bigint {
  const sum = (xs: string[]) => xs.reduce((a, x) => a + scaled(x), 0n);
  const total = sum(fills.map((f) => f.closedPnl)) - sum(fills.map((f) => f.fee)) + scaled(funding);
  // `scaled` carries 12 decimals; floor to 6.
  const q = total / 1_000_000n;
  return total % 1_000_000n < 0n ? q - 1n : q;
}
function scaled(s: string): bigint {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s.trim());
  if (!m) throw new Error(`not a decimal: ${s}`);
  const v = BigInt(m[2]) * 10n ** 12n + BigInt((m[3] ?? '').padEnd(12, '0').slice(0, 12));
  return m[1] ? -v : v;
}
