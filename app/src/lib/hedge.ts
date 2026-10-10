// The hedge book as the Underwrite page shows it (D3, testnet hedge, research). Every figure is a stored field of a
// HedgeBook or the HedgeConfig, or a stated function of them:
//   margin cap     = ⌊cover equity × margin_cap_bps / 10,000⌋  (cover equity at the time a hedge is declared)
//   gain cap       = ⌊equity at declaration × pnl_cap_bps / 10,000⌋
//   notional       = Σ leg notionals
// The program trusts the keeper only for the reported P&L, within these caps, after the weekend settles and the delay.
import { PublicKey } from '@solana/web3.js';
import { PROGRAM_ID, type CoreProgram } from '@credence/sdk';

export const HEDGE_STATE = ['declared', 'reported', 'final', 'void'] as const;
export const HEDGE_VENUE = 'Hyperliquid testnet (HIP-3 xyz dex)';

export type HedgeLegView = { ticker: string; notional: bigint; entry: bigint; exit: bigint };
export type HedgeBookView = {
  key: PublicKey; group: number; state: number; stateName: string; margin: bigint; notional: bigint; equityAtOpen: bigint;
  pnl: bigint; settledPnl: bigint; reportedAt: number; earliestReport: number; reporter: PublicKey; evidence: string; legs: HedgeLegView[];
};
export type HedgeConfigView = { marginCapBps: number; pnlCapBps: number; maxLeverage: number; delaySecs: number; expirySecs: number; returnTol: bigint };
export type HedgeView = { config: HedgeConfigView | null; books: HedgeBookView[]; pending: number; lastPnl: bigint | null };

export const hedgeCfgPda = () => PublicKey.findProgramAddressSync([Buffer.from('hedgecfg')], PROGRAM_ID)[0];

const big = (x: { toString(): string }) => BigInt(x.toString());
const tick = (t: number[]) => Buffer.from(t).toString('ascii').replace(/\0+$/, '');

/** ⌊equity × bps / 10,000⌋ — as the program computes the margin and gain caps. */
export const capOf = (equity: bigint, bps: number) => (equity * BigInt(bps)) / 10_000n;

export function bookView(key: PublicKey, b: any): HedgeBookView { // eslint-disable-line @typescript-eslint/no-explicit-any
  const legs: HedgeLegView[] = (b.legs as any[]).slice(0, b.nLegs).map((l) => ({ ticker: tick(l.ticker), notional: big(l.notional), entry: big(l.entryWad), exit: big(l.exitWad) })); // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    key, group: b.group, state: b.state, stateName: HEDGE_STATE[b.state] ?? '?', margin: big(b.margin), notional: legs.reduce((a, l) => a + l.notional, 0n),
    equityAtOpen: big(b.equityAtOpen), pnl: big(b.pnl), settledPnl: big(b.settledPnl), reportedAt: Number(big(b.reportedAt)), earliestReport: Number(big(b.earliestReport)),
    reporter: b.reporter, evidence: Buffer.from(b.evidence).toString('hex'), legs,
  };
}

export async function loadHedge(prog: CoreProgram, pending: number): Promise<HedgeView> {
  const accounts = prog.account as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const c = await accounts.hedgeConfig.fetchNullable(hedgeCfgPda());
  const rows = (await accounts.hedgeBook.all()) as { publicKey: PublicKey; account: any }[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const books = rows.map((r) => bookView(r.publicKey, r.account)).sort((a, b) => b.group - a.group);
  const last = books.find((b) => b.state === 2);
  return {
    config: c && { marginCapBps: c.marginCapBps, pnlCapBps: c.pnlCapBps, maxLeverage: c.maxLeverage, delaySecs: c.delaySecs, expirySecs: c.expirySecs, returnTol: big(c.returnTolWad) },
    books, pending, lastPnl: last ? last.settledPnl : null,
  };
}

/** Plain-words trust disclosure shown next to the numbers and repeated in the README. */
export const HEDGE_DISCLOSURE =
  'Testnet hedge, research. The vault does not hold the hedge: a keeper shorts equity perps on a test network under its own key, and its margin sits there, outside this program. ' +
  'That is a trust assumption, so it is bounded: margin is capped as a share of vault equity, a reported gain is capped and must match the lender-oracle prices of the same weekend, ' +
  'nothing reaches equity before the weekend has settled and a challenge delay has passed, the guardian can void any report, and the guardian pause stops new hedges. ' +
  'A hedge never raises the capacity to sell cover.';
