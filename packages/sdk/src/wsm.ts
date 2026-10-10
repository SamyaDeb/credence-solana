// Weekend-safe market (D1): typed builders and readers for the `wsm*` instructions. Unsigned instructions only; the SDK
// never holds a key and never sends. Pricing is the program's: a quote is `quote_cover` simulated (quoteSingle), the
// add-on APR below is that premium over the debt it covers, and the freeze is read from the epoch the program wrote.
// The user's `wsm_repay` / `wsm_withdraw` / `wsm_claim` read no config, pause flag, policy or vault, and nothing here adds
// one: they are always buildable.
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, TransactionInstruction } from '@solana/web3.js';
import { type CoreProgram, EPOCH, FARMS, INSTRUCTIONS_SYSVAR, KLEND, PROGRAM_ID, TOKEN, TOKEN_2022, USDC_MINT, ata, bn, pdas, ticker8, tickerStr } from './core';
import { assertNoJupiterWithKlend } from './guard';
import { type ObligationState, type ReserveState, borrows, deposits, refreshIxs, refreshReserveIx } from './kamino';
import type { EpochView } from './cover';

/** The weekend-safe klend market (credence-core kamino.rs `WSM_MARKET`; fork-only address). */
export const WSM_MARKET = new PublicKey('45PeTGq9mJF9W6zzzSrgNgZjx8stoiYALubvDNTjsHfL');

const pda = (seeds: (Buffer | Uint8Array)[], program = PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds, program)[0];
export const wsmPdas = {
  market: () => pda([Buffer.from('wsm_market')]),
  auth: () => pda([Buffer.from('wsm_auth')]),
  account: (user: PublicKey) => pda([Buffer.from('wsm'), user.toBuffer()]),
  usdc: (user: PublicKey) => pda([Buffer.from('wsm_usdc'), user.toBuffer()]),
  coll: (user: PublicKey) => pda([Buffer.from('wsm_coll'), user.toBuffer()]),
  /** klend's market authority of the weekend-safe market. */
  lma: () => pda([Buffer.from('lma'), WSM_MARKET.toBuffer()], KLEND),
  /** The klend obligation a `["wsm", user]` account owns (tag 0, id 0, no seed accounts). */
  obligation: (account: PublicKey) => pda([Buffer.from([0]), Buffer.from([0]), account.toBuffer(), WSM_MARKET.toBuffer(), PublicKey.default.toBuffer(), PublicKey.default.toBuffer()], KLEND),
  userMetadata: (account: PublicKey) => pda([Buffer.from('user_meta'), account.toBuffer()], KLEND),
};

/** What the market is made of, from the `WsmMarket` account and the reserves it lists. */
export type WsmMarketView = {
  key: PublicKey; usdcReserve: PublicKey; maxDcpWad: bigint; freezeSecs: number; marketDebtCap: bigint; worstLossRatioWad: bigint;
  assets: { ticker: string; reserve: PublicKey; normalLtvWad: bigint; enabled: boolean }[];
};

export async function readWsmMarket(prog: CoreProgram): Promise<WsmMarketView | null> {
  const key = wsmPdas.market();
  const m = await prog.account.wsmMarket.fetchNullable(key);
  if (!m) return null;
  return {
    key, usdcReserve: m.usdcReserve, maxDcpWad: BigInt(m.maxDcpWad.toString()), freezeSecs: m.freezeSecs, marketDebtCap: BigInt(m.marketDebtCap.toString()),
    worstLossRatioWad: BigInt(m.worstLossRatioWad.toString()),
    assets: m.assets.slice(0, m.nAssets).map((a: { ticker: number[]; reserve: PublicKey; normalLtvWad: { toString(): string }; enabled: boolean }) => (
      { ticker: tickerStr(a.ticker), reserve: a.reserve, normalLtvWad: BigInt(a.normalLtvWad.toString()), enabled: a.enabled })),
  };
}

export type WsmAccountView = {
  key: PublicKey; user: PublicKey; ticker: string; obligation: PublicKey; coveredClosure: number; coverFailedClosure: number; addonPaidTotal: bigint;
  /** 'covered' for the closure the caller asks about, 'flagged' when its cover was refused, else 'uncovered'. */
  status: (closureId: number) => 'covered' | 'flagged' | 'uncovered';
};

export async function readWsmAccount(prog: CoreProgram, user: PublicKey): Promise<WsmAccountView | null> {
  const key = wsmPdas.account(user);
  const a = await prog.account.wsmAccount.fetchNullable(key);
  if (!a) return null;
  return {
    key, user: a.user, ticker: tickerStr(a.ticker), obligation: a.obligation, coveredClosure: a.coveredClosure, coverFailedClosure: a.coverFailedClosure,
    addonPaidTotal: BigInt(a.addonPaidTotal.toString()),
    status: (c) => (a.coveredClosure === c ? 'covered' : a.coverFailedClosure === c ? 'flagged' : 'uncovered'),
  };
}

/** The weekend status a page shows: the freeze runs from `freezeSecs` before the bell until the open's settlement window
 * ends (the program's `in_freeze`; this reads the epoch it wrote, so it is display only - the program decides). */
export type WeekendStatus = { phase: 'open' | 'frozen'; closureId: number | null; freezeStart: number | null; bell: number | null; until: number | null };
export function weekendStatus(epochs: EpochView[], ticker: string, now: number, freezeSecs: number): WeekendStatus {
  const next = epochs
    .filter((e) => e.ticker === ticker && (e.closureType === 2 || e.closureType === 3) && e.state !== EPOCH.VOIDED && e.settleAfter > now)
    .sort((a, b) => a.settleAfter - b.settleAfter)[0];
  if (!next) return { phase: 'open', closureId: null, freezeStart: null, bell: null, until: null };
  const freezeStart = next.bell - freezeSecs;
  const frozen = now >= freezeStart && now < next.settleAfter;
  return { phase: frozen ? 'frozen' : 'open', closureId: next.closureId, freezeStart, bell: next.bell, until: frozen ? next.settleAfter : freezeStart };
}

/** The add-on as a yearly rate on the debt it covers: premium × 52 / debt, in basis points, rounded up (a display figure;
 * the premium itself is the program's `quote_cover`). */
export const addonAprBps = (premium: bigint, debt: bigint): bigint => (debt === 0n ? 0n : (premium * 52n * 10_000n + debt - 1n) / debt);

const meta = (pubkey: PublicKey, isWritable = false, isSigner = false) => ({ pubkey, isSigner, isWritable });

function klendAccounts(lma = wsmPdas.lma()) {
  return { klend: { klendMarket: WSM_MARKET, klendLma: lma, klendProgram: KLEND, farmsProgram: FARMS, instructionSysvar: INSTRUCTIONS_SYSVAR } };
}

/** Everything a user instruction needs to know about the market's reserves. */
export type WsmReserves = { collateral: PublicKey; usdc: PublicKey; collateralState: ReserveState; usdcState: ReserveState };

const reserveAccts = (r: ReserveState) => ({
  liquiditySupply: new PublicKey(r.liquidity.supplyVault),
  feeVault: new PublicKey(r.liquidity.feeVault),
  collateralMint: new PublicKey(r.collateral.mintPubkey),
  collateralSupply: new PublicKey(r.collateral.supplyVault),
});

export async function wsmOpen(prog: CoreProgram, a: { user: PublicKey; ticker: string; coll: PublicKey }): Promise<TransactionInstruction> {
  const account = wsmPdas.account(a.user);
  return prog.methods.wsmOpen(ticker8(a.ticker)).accountsPartial({
    user: a.user, asset: pdas.asset(a.ticker), wsmAccount: account, wsmUsdc: wsmPdas.usdc(a.user), wsmColl: wsmPdas.coll(a.user),
    usdcMint: USDC_MINT, collMint: a.coll, klendMarket: WSM_MARKET, klendLma: wsmPdas.lma(), userMetadata: wsmPdas.userMetadata(account),
    obligation: wsmPdas.obligation(account), klendProgram: KLEND, farmsProgram: FARMS, instructionSysvar: INSTRUCTIONS_SYSVAR, rent: SYSVAR_RENT_PUBKEY,
    tokenProgram: TOKEN, token2022Program: TOKEN_2022, systemProgram: SystemProgram.programId,
  }).instruction();
}

export async function wsmReopen(prog: CoreProgram, a: { user: PublicKey }): Promise<TransactionInstruction> {
  const account = wsmPdas.account(a.user);
  return prog.methods.wsmReopen().accountsPartial({
    user: a.user, wsmAccount: account, userMetadata: wsmPdas.userMetadata(account), obligation: wsmPdas.obligation(account), klendMarket: WSM_MARKET,
    klendLma: wsmPdas.lma(), klendProgram: KLEND, farmsProgram: FARMS, instructionSysvar: INSTRUCTIONS_SYSVAR, rent: SYSVAR_RENT_PUBKEY, systemProgram: SystemProgram.programId,
  }).instruction();
}

/** The refreshes klend wants before an action on the account's obligation: `refresh_reserve` of every reserve it holds and of
 * each `extra` (the USDC reserve before a first borrow, and the program checks it was refreshed in the same slot), then
 * `refresh_obligation`. An obligation that is empty gets only the refresh of the extras and the obligation itself, so pass
 * `o = null` with its (empty) state absent only before the first deposit. */
export function wsmRefreshes(account: PublicKey, o: ObligationState | null, reserves: Map<string, ReserveState>, extra: PublicKey[] = []): TransactionInstruction[] {
  const held = o ? [...deposits(o), ...borrows(o)].map((k) => k.toBase58()) : [];
  const ixs: TransactionInstruction[] = [];
  for (const k of extra) {
    const r = reserves.get(k.toBase58());
    if (!r) throw new Error(`reserve ${k.toBase58()} not loaded`);
    if (!held.includes(k.toBase58())) ixs.push(refreshReserveIx(k, r));
  }
  if (!o) return ixs;
  return [...ixs, ...refreshIxs(wsmPdas.obligation(account), o, reserves)];
}

/** Deposit `amount` (the xStock's base units) as collateral. Allowed while paused. */
export async function wsmDeposit(prog: CoreProgram, a: { user: PublicKey; ticker: string; coll: PublicKey; amount: bigint; reserve: PublicKey; reserveState: ReserveState; refreshes?: TransactionInstruction[] }) {
  const account = wsmPdas.account(a.user);
  const r = reserveAccts(a.reserveState);
  const ix: TransactionInstruction = await prog.methods.wsmDeposit(bn(a.amount)).accountsPartial({
    user: a.user, wsmAccount: account, wsmColl: wsmPdas.coll(a.user), userColl: ata(a.user, a.coll, TOKEN_2022), collMint: a.coll, obligation: wsmPdas.obligation(account),
    reserve: a.reserve, reserveLiquiditySupply: r.liquiditySupply, reserveCollateralMint: r.collateralMint, reserveCollateralSupply: r.collateralSupply,
    ...klendAccounts(), collateralTokenProgram: TOKEN, token2022Program: TOKEN_2022,
  }).instruction();
  return assertNoJupiterWithKlend([...(a.refreshes ?? []), ix]);
}

/** Borrow `amount` USDC. The program refuses it in a weekend freeze, past the market's D/C′ limit and debt cap, and
 * when the vault could not carry the market's debt. */
export async function wsmBorrow(prog: CoreProgram, a: { user: PublicKey; amount: bigint; usdcReserve: PublicKey; usdcState: ReserveState; refreshes: TransactionInstruction[] }) {
  const account = wsmPdas.account(a.user);
  const r = reserveAccts(a.usdcState);
  const ix: TransactionInstruction = await prog.methods.wsmBorrow(bn(a.amount)).accountsPartial({
    user: a.user, wsmAccount: account, vault: pdas.vault(), shareMint: pdas.shares(), wsmUsdc: wsmPdas.usdc(a.user), userUsdc: ata(a.user, USDC_MINT), usdcMint: USDC_MINT,
    obligation: wsmPdas.obligation(account), usdcReserve: a.usdcReserve, reserveLiquiditySupply: r.liquiditySupply, reserveFeeVault: r.feeVault,
    wsmAuth: wsmPdas.auth(), calendar: pdas.calendar(), ...klendAccounts(), tokenProgram: TOKEN,
  }).instruction();
  return assertNoJupiterWithKlend([...a.refreshes, ix]);
}

/** Repay up to `amount` USDC (`2^64 - 1` = all). An exit: no config, pause or policy is read. */
export async function wsmRepay(prog: CoreProgram, a: { user: PublicKey; amount: bigint; usdcReserve: PublicKey; usdcState: ReserveState; refreshes: TransactionInstruction[] }) {
  const account = wsmPdas.account(a.user);
  const r = reserveAccts(a.usdcState);
  const ix: TransactionInstruction = await prog.methods.wsmRepay(bn(a.amount)).accountsPartial({
    user: a.user, wsmAccount: account, wsmUsdc: wsmPdas.usdc(a.user), userUsdc: ata(a.user, USDC_MINT), usdcMint: USDC_MINT, obligation: wsmPdas.obligation(account),
    usdcReserve: a.usdcReserve, reserveLiquiditySupply: r.liquiditySupply, ...klendAccounts(), tokenProgram: TOKEN,
  }).instruction();
  return assertNoJupiterWithKlend([...a.refreshes, ix]);
}

/** Withdraw `collateral` cTokens (`2^64 - 1` = all klend allows). An exit; in a freeze it may not leave a debt above
 * the market's normal limit (repay first and it passes). */
export async function wsmWithdraw(prog: CoreProgram, a: { user: PublicKey; coll: PublicKey; collateral: bigint; reserve: PublicKey; reserveState: ReserveState; refreshes: TransactionInstruction[] }) {
  const account = wsmPdas.account(a.user);
  const r = reserveAccts(a.reserveState);
  const ix: TransactionInstruction = await prog.methods.wsmWithdraw(bn(a.collateral)).accountsPartial({
    user: a.user, wsmAccount: account, calendar: pdas.calendar(), wsmColl: wsmPdas.coll(a.user), userColl: ata(a.user, a.coll, TOKEN_2022), collMint: a.coll,
    obligation: wsmPdas.obligation(account), reserve: a.reserve, reserveLiquiditySupply: r.liquiditySupply, reserveCollateralMint: r.collateralMint,
    reserveCollateralSupply: r.collateralSupply, ...klendAccounts(), collateralTokenProgram: TOKEN, token2022Program: TOKEN_2022,
  }).instruction();
  return assertNoJupiterWithKlend([...a.refreshes, ix]);
}

/** Moves the account's own USDC (a payout's rest, an unused repayment) to the owner's wallet. */
export async function wsmClaim(prog: CoreProgram, a: { user: PublicKey }): Promise<TransactionInstruction> {
  return prog.methods.wsmClaim().accountsPartial({
    user: a.user, wsmAccount: wsmPdas.account(a.user), wsmUsdc: wsmPdas.usdc(a.user), userUsdc: ata(a.user, USDC_MINT), usdcMint: USDC_MINT, tokenProgram: TOKEN,
  }).instruction();
}

/** The Friday cover (anyone may send it, from `freezeSecs` before the bell): the refreshes, then `wsm_auto_cover`. */
export async function wsmAutoCover(prog: CoreProgram, a: {
  payer: PublicKey; user: PublicKey; ticker: string; epoch: EpochView; usdcReserve: PublicKey; usdcState: ReserveState; collateralReserve: PublicKey;
  feeAccount: PublicKey; refreshes: TransactionInstruction[];
}) {
  const account = wsmPdas.account(a.user);
  const obligation = wsmPdas.obligation(account);
  const r = reserveAccts(a.usdcState);
  const ix: TransactionInstruction = await prog.methods.wsmAutoCover(ticker8(a.ticker), a.epoch.closureId).accountsPartial({
    payer: a.payer, wsmAccount: account, wsmUsdc: wsmPdas.usdc(a.user), asset: pdas.asset(a.ticker), scenarios: pdas.scen(a.ticker, a.epoch.closureType ?? 2),
    epoch: a.epoch.key, earnings: pdas.earnings(a.ticker), loss: pdas.loss(a.epoch.closureId), vault: pdas.vault(), vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(),
    feeAccount: a.feeAccount, usdcMint: USDC_MINT, obligation, depositReserve: a.collateralReserve, usdcReserve: a.usdcReserve, reserveLiquiditySupply: r.liquiditySupply,
    reserveFeeVault: r.feeVault, wsmAuth: wsmPdas.auth(), policy: pdas.policy(a.epoch.key, obligation), ...klendAccounts(), tokenProgram: TOKEN, systemProgram: SystemProgram.programId,
  }).instruction();
  return { ixs: assertNoJupiterWithKlend([...a.refreshes, ix]), policy: pdas.policy(a.epoch.key, obligation) };
}

/** The accounts' state, the weekend and the add-on for a page: reads only. */
export type WsmPosition = {
  account: WsmAccountView; collateralUsd: number; debtUsd: number; allowedBorrowUsd: number; liquidationUsd: number;
  /** debt / (LT × collateral), the D/C′ the market caps. */
  dcp: number;
};
export function wsmPosition(account: WsmAccountView, o: ObligationState): WsmPosition {
  const f = (b: { toString(): string }) => Number(BigInt(b.toString()) >> 40n) / 2 ** 20; // U68F60 -> number, display only
  const collateralUsd = f(o.depositedValueSf);
  const debtUsd = f(o.borrowedAssetsMarketValueSf);
  const liquidationUsd = f(o.unhealthyBorrowValueSf);
  return { account, collateralUsd, debtUsd, allowedBorrowUsd: f(o.allowedBorrowValueSf), liquidationUsd, dcp: liquidationUsd > 0 ? debtUsd / liquidationUsd : 0 };
}
