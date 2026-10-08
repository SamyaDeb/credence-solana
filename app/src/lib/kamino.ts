// klend on the fork, from the browser: find the wallet's obligations, decode them with klend-sdk's codegen, build the
// refresh instructions (same order as keeper/src/kamino.ts: refresh_reserve for every reserve, then
// refresh_obligation) and read a freshly refreshed obligation through a simulation, without sending anything.
// The Phase 1 eligibility rules and the snapshot units are those of credence-core's `cover_snapshot` (kamino.rs).
import { Obligation, Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';
import { ComputeBudgetProgram, Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import { KLEND, SF_SHIFT, USDC_MINT, WAD, XSTOCKS_MARKETS } from './credence';

const DEFAULT = '11111111111111111111111111111111';
// sha256("global:<name>")[..8], as keeper/src/kamino.ts computes them.
const REFRESH_RESERVE = Buffer.from([2, 218, 138, 235, 79, 201, 25, 102]);
const REFRESH_OBLIGATION = Buffer.from([33, 132, 147, 228, 151, 192, 72, 89]);
/** klend `PriceStatusFlags::ALL_CHECKS`: what `buy_cover` requires of a refresh. */
export const PRICE_STATUS_ALL_CHECKS = 63;
/** Byte offset of `owner` in a klend Obligation (credence-core `OB_OWNER`). */
export const OB_OWNER = 64;

export type ObligationState = ReturnType<typeof Obligation.decode>;
export type ReserveState = ReturnType<typeof Reserve.decode>;

const meta = (pubkey: PublicKey, isWritable = false) => ({ pubkey, isSigner: false, isWritable });
const orKlend = (a: string) => (a === DEFAULT ? KLEND : new PublicKey(a));

export const decodeObligation = (data: Buffer) => Obligation.decode(data);
export const decodeReserve = (data: Buffer) => Reserve.decode(data);
export const deposits = (o: ObligationState) => o.deposits.filter((d) => d.depositReserve !== DEFAULT).map((d) => new PublicKey(d.depositReserve));
export const borrows = (o: ObligationState) => o.borrows.filter((b) => b.borrowReserve !== DEFAULT).map((b) => new PublicKey(b.borrowReserve));

/** Every klend obligation owned by `owner` in the two xStocks markets, read from the fork. */
export async function obligationsOf(conn: Connection, owner: PublicKey) {
  const accs = await conn.getProgramAccounts(KLEND, { commitment: 'confirmed', filters: [{ memcmp: { offset: OB_OWNER, bytes: owner.toBase58() } }] });
  return accs
    .map((a) => ({ key: a.pubkey, state: decodeObligation(a.account.data as Buffer) }))
    .filter((o) => XSTOCKS_MARKETS[o.state.lendingMarket] !== undefined);
}

export async function loadReserves(conn: Connection, keys: PublicKey[]): Promise<Map<string, ReserveState>> {
  const uniq = [...new Map(keys.map((k) => [k.toBase58(), k])).values()];
  const infos = await conn.getMultipleAccountsInfo(uniq, 'confirmed');
  const m = new Map<string, ReserveState>();
  infos.forEach((a, i) => { if (a) m.set(uniq[i].toBase58(), decodeReserve(a.data as Buffer)); });
  return m;
}

export function refreshReserveIx(key: PublicKey, r: ReserveState): TransactionInstruction {
  const t = r.config.tokenInfo;
  return new TransactionInstruction({
    programId: KLEND,
    data: REFRESH_RESERVE,
    keys: [
      meta(key, true),
      meta(new PublicKey(r.lendingMarket)),
      meta(orKlend(t.pythConfiguration.price)),
      meta(orKlend(t.switchboardConfiguration.priceAggregator)),
      meta(orKlend(t.switchboardConfiguration.twapAggregator)),
      meta(orKlend(t.scopeConfiguration.priceFeed)),
    ],
  });
}

/** refresh_reserve for every reserve of the obligation, then refresh_obligation (what buy_cover needs first). */
export function refreshIxs(obligation: PublicKey, o: ObligationState, reserves: Map<string, ReserveState>): TransactionInstruction[] {
  const deps = deposits(o);
  const bors = borrows(o);
  const uniq = [...new Map([...deps, ...bors].map((k) => [k.toBase58(), k])).values()];
  const ixs = uniq.map((k) => {
    const r = reserves.get(k.toBase58());
    if (!r) throw new Error(`reserve ${k.toBase58()} not loaded`);
    return refreshReserveIx(k, r);
  });
  ixs.push(new TransactionInstruction({
    programId: KLEND,
    data: REFRESH_OBLIGATION,
    keys: [meta(new PublicKey(o.lendingMarket)), meta(obligation, true), ...[...deps, ...bors].map((k) => meta(k))],
  }));
  return ixs;
}

/** The obligation as klend leaves it after the refreshes, from a simulation (nothing is sent). */
export async function simulateRefreshed(conn: Connection, payer: PublicKey, obligation: PublicKey, o: ObligationState, reserves: Map<string, ReserveState>) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: payer, blockhash, lastValidBlockHeight })
    .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...refreshIxs(obligation, o, reserves));
  const r = await conn.simulateTransaction(tx, undefined, [obligation]);
  if (r.value.err) throw new Error(`refresh simulation failed: ${JSON.stringify(r.value.err)} ${(r.value.logs ?? []).slice(-3).join(' | ')}`);
  const acc = r.value.accounts?.[0];
  if (!acc) throw new Error('simulation returned no obligation');
  return { state: decodeObligation(Buffer.from(acc.data[0], 'base64')), cu: r.value.unitsConsumed ?? 0 };
}

/** credence-core `snapshot_values` (kamino.rs), same units and rounding: D = ⌈borrowed_sf / 2^60⌉ USDC base units;
 * C = ⌊deposit_mv_sf × 1e6 / 2^60⌋; C′ = ⌊unhealthy_sf × borrowed_sf / (borrow_mv_sf × 2^60)⌋; LT = ⌊unhealthy × 1e18 /
 * deposited⌋ (WAD). Display and quote inputs only: buy_cover recomputes them on-chain from the same refresh. */
export function snapshot(o: ObligationState) {
  const dep = o.deposits.find((d) => d.depositReserve !== DEFAULT);
  const bor = o.borrows.find((b) => b.borrowReserve !== DEFAULT);
  const depositMvSf = dep ? BigInt(dep.marketValueSf.toString()) : 0n;
  const borrowedSf = bor ? BigInt(bor.borrowedAmountSf.toString()) : 0n;
  const borrowMvSf = bor ? BigInt(bor.marketValueSf.toString()) : 0n;
  const unhealthySf = BigInt(o.unhealthyBorrowValueSf.toString());
  const depositedSf = BigInt(o.depositedValueSf.toString());
  const one = 1n << SF_SHIFT;
  const debt = (borrowedSf + one - 1n) >> SF_SHIFT;
  const collateralValue = (depositMvSf * 1_000_000n) >> SF_SHIFT;
  const coveredValue = borrowMvSf > 0n ? (unhealthySf * borrowedSf) / (borrowMvSf << SF_SHIFT) : 0n;
  const ltWad = depositedSf > 0n ? (unhealthySf * WAD) / depositedSf : 0n;
  return { debt, collateralValue, coveredValue, ltWad, depositAmount: dep ? BigInt(dep.depositedAmount.toString()) : 0n };
}

/** Why `buy_cover` would reject this obligation (CoreError::UnsupportedObligation / MarketNotAllowed), or null.
 * `assetReserves` are the covered xStocks' Kamino reserves from their AssetConfig. */
export function ineligibility(o: ObligationState, reserves: Map<string, ReserveState>, assetReserves: Map<string, string>): string | null {
  if (XSTOCKS_MARKETS[o.lendingMarket] === undefined) return 'not in one of the two xStocks markets';
  const deps = deposits(o);
  const bors = borrows(o);
  if (deps.length !== 1) return `${deps.length} deposits: Phase 1 covers one xStock deposit (multi-collateral would overpay)`;
  if (bors.length !== 1) return `${bors.length} borrows: Phase 1 covers one USDC borrow`;
  if (!assetReserves.has(deps[0].toBase58())) return 'the deposit is not SPYx, QQQx or NVDAx in this market';
  const br = reserves.get(bors[0].toBase58());
  if (!br || br.liquidity.mintPubkey !== USDC_MINT.toBase58()) return 'the borrow is not USDC';
  if (BigInt(br.config.borrowFactorPct.toString()) !== 100n) return 'borrow factor is not 100%';
  if (BigInt(o.borrowFactorAdjustedDebtValueSf.toString()) !== BigInt(o.borrowedAssetsMarketValueSf.toString())) return 'borrow-factor-adjusted debt differs from the USDC debt';
  return null;
}
