// Reads everything the widget shows about one position, through the host's connection: the Gap Oracle feed, the position's
// C′ and D (klend's refresh simulated), the asset's scenario set and the risk view built from them, the sale and any
// Policy. It builds no transaction and signs nothing.
import type { Connection, PublicKey } from '@solana/web3.js';
import { PublicKey as Key } from '@solana/web3.js';
import {
  EPOCH, KLEND, type Asset, type BookLegRef, type CoreProgram, type EpochView, type GapFeedView, type ObligationState, type PolicyView, type ProgramCheck,
  type ReserveState, type RiskView, chainNow, decodeObligation, feedProblems, ineligibility, loadAssets, loadEpochs, loadReserves, loadScenarioZ, pdas,
  policyView, program, readBookLeg, readFeeds, reserveToAsset, riskView, scopeChains, simulateRefreshed, snapshot,
} from '@credence/sdk';
import { assertProgram, assertSupportedCluster } from './cluster';
import { UnsupportedPositionError } from './errors';
import { type Lender, parseLender, toPublicKey } from './inputs';
import type { ForkUpkeep } from './types';

const WEEKEND = 2;

export type LoadOptions = {
  position: unknown;
  lender: unknown;
  /** Fork upkeep the host provides (restamping Scope prices to the fork clock). Never a signer. */
  upkeep?: ForkUpkeep;
};

export type ProtectState = {
  lender: Lender;
  position: PublicKey;
  owner: PublicKey;
  ticker: string;
  now: number;
  program: ProgramCheck;
  feed: GapFeedView | null;
  feedProblems: string[];
  /** Null when no weekend epoch is on sale, with the reason in `saleNote`. */
  epoch: EpochView | null;
  saleNote: string | null;
  /** An owner Policy for this epoch (the position is protected), or null. */
  policy: PolicyView | null;
  /** The position is a leg of a curator's book: buying releases it first. */
  bookLeg: BookLegRef | null;
  risk: RiskView | null;
  /** Internals for the quote and the buy (not part of the display contract). */
  ctx: { prog: CoreProgram; asset: Asset; o: ObligationState; reserves: Map<string, ReserveState>; upkeep?: ForkUpkeep };
};

export async function loadPosition(conn: Connection, opts: LoadOptions): Promise<ProtectState> {
  const lender = parseLender(opts.lender);
  const position = toPublicKey(opts.position, 'position');
  await assertSupportedCluster(conn);
  const check = await assertProgram(conn);
  if (lender === 'jupiter') throw new UnsupportedPositionError('Jupiter Lend positions are not in this widget yet: protect them with the Protect Action (see the README).');

  const acc = await conn.getAccountInfo(position, 'confirmed');
  if (!acc) throw new UnsupportedPositionError('No account exists at this position address on this cluster.');
  if (!acc.owner.equals(KLEND)) throw new UnsupportedPositionError('This address is not a Kamino lending obligation.');
  let o: ObligationState;
  try { o = decodeObligation(acc.data); } catch { throw new UnsupportedPositionError('This Kamino account could not be read as an obligation.'); }
  const owner = new Key(o.owner);

  const prog = program(conn);
  const [assets, epochs, now] = await Promise.all([loadAssets(prog), loadEpochs(prog), chainNow(conn)]);
  const byReserve = reserveToAsset(assets);
  const none = Key.default.toBase58();
  const deps = o.deposits.map((d) => d.depositReserve).filter((r) => r !== none);
  const bors = o.borrows.map((b) => b.borrowReserve).filter((r) => r !== none);
  const reserves = await loadReserves(conn, [...deps, ...bors].map((r) => new Key(r)));
  const why = ineligibility(o, reserves, new Map([...byReserve].map(([r, a]) => [r, a.ticker])));
  const asset = deps.length ? byReserve.get(deps[0]) : undefined;
  if (why !== null || !asset) {
    throw new UnsupportedPositionError(why ?? 'This obligation holds no covered xStock. Multi-collateral books are covered by the Protect Action.');
  }

  const epoch = epochs.find((e) => e.ticker === asset.ticker && e.closureType === WEEKEND && e.state === EPOCH.OPEN && now >= e.saleOpen && now < e.bell) ?? null;
  const feeds = await readFeeds(prog);
  const feed = feeds.find((f) => f.ticker === asset.ticker) ?? null;
  const problems = feed ? feedProblems(feed, now, feed.maxInputAgeSecs) : ['no Gap Oracle feed for this asset'];

  let policy: PolicyView | null = null;
  let bookLeg: BookLegRef | null = null;
  if (epoch) {
    const key = pdas.policy(epoch.key, position);
    const raw = await prog.account.policy.fetchNullable(key);
    if (raw) {
      bookLeg = await readBookLeg(prog, epoch.key, position);
      if (!bookLeg) policy = policyView({ publicKey: key, account: raw });
    }
  }

  let risk: RiskView | null = null;
  if (epoch && !policy) {
    await opts.upkeep?.scopeFresh?.(scopeChains([...reserves.values()]));
    const r = await simulateRefreshed(conn, owner, position, o, reserves);
    const z = await loadScenarioZ(conn, asset.ticker, epoch.closureType);
    risk = riskView(snapshot(r.state), z, asset.sigmaWad);
  }

  return {
    lender, position, owner, ticker: asset.ticker, now, program: check, feed, feedProblems: problems, epoch,
    saleNote: epoch ? null : 'No weekend epoch is on sale for this asset right now.',
    policy, bookLeg, risk, ctx: { prog, asset, o, reserves, upkeep: opts.upkeep },
  };
}
