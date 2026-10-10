// Weekend-safe market (D1) keeper job. Per pass:
//   - from `freeze_secs` before the next weekend closure's bell until the bell, every account that is not yet covered for
//     the closure gets `wsm_auto_cover` (refreshes + the instruction). Permissionless: any wallet may send it, and the user
//     can send it themselves. A refused cover (vault capacity, no headroom for the premium) does not fail: the program
//     flags the account (`cover_failed_closure`), borrows nothing and creates nothing; this job reports it and tries again
//     on the next pass until the bell (capacity may have been freed), so a flag is never final before the bell.
//   - Shield and settlement of the accounts' policies are the generic jobs' (jobs.ts): a wsm policy is an ordinary policy
//     whose owner is the account; their payout destination is `["wsm_usdc", user]` (audit A-190, `payDest`).
// Nothing here can move a user's collateral or debt: the program has no instruction that does but the user's own, the
// Shield/settlement repay and klend's liquidation.
import anchor from '@anchor-lang/core';
const { web3 } = anchor;
import { type Chain, DEFAULT_KEY, EPOCH, FARMS, USDC_MINT, INSTRUCTIONS_SYSVAR, KLEND, WSM_MARKET, chainNow, fmtTime, log, pdas, send, tickerStr } from './chain.js';
import { loadObligation, loadReserve, refreshIxs } from './kamino.js';
import { sendV0 } from './jupiter.js';

type Pk = InstanceType<typeof web3.PublicKey>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = { publicKey: Pk; account: any };
export type Report = { sent: string[]; failed: string[]; waiting: string[] };
const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());

/** Where a payout or refund "to the owner" goes: `["wsm_usdc", user]` for a weekend-safe market policy (its `rent_payer`
 * carries the user, no book), else the owner's associated token account. (audit A-190) */
export function isWsmPolicy(pol: { book?: Pk; rentPayer?: Pk }): boolean {
  return !!pol.rentPayer && pol.rentPayer.toBase58() !== DEFAULT_KEY && (!pol.book || pol.book.toBase58() === DEFAULT_KEY);
}
export const payDest = (pol: { book?: Pk; rentPayer?: Pk }): Pk | null => (isWsmPolicy(pol) ? pdas.wsmUsdc(pol.rentPayer!) : null);

/** The reason codes of `WsmCoverFailed`. */
export const COVER_FAILED = { 1: 'vault capacity', 2: 'asset concentration limit', 3: 'no headroom for the premium' } as Record<number, string>;

/** The weekend closure whose freeze is running or next: the earliest WEEKEND / HOLIDAY_WEEKEND epoch of `ticker` that is
 * still open for sales (bell ahead). */
export function nextCoverEpoch(epochs: Row[], ticker: string, now: number): Row | undefined {
  return epochs
    .filter((e) => tickerStr(e.account.ticker) === ticker && (e.account.closureType === 2 || e.account.closureType === 3) && e.account.state === EPOCH.OPEN && n(e.account.bell) > now)
    .sort((a, b) => n(a.account.bell) - n(b.account.bell))[0];
}

// refresh ×2 + refresh_obligation + wsm_auto_cover is a few bytes over a legacy transaction: a v0 transaction with a lookup
// table of the accounts every cover shares (created once per process; active from the next slot).
let table: Awaited<ReturnType<Chain['conn']['getAddressLookupTable']>>['value'] = null;
async function sharedTable(c: Chain, keys: Pk[]) {
  if (table) return table;
  const slot = await c.conn.getSlot('processed');
  const [create, key] = web3.AddressLookupTableProgram.createLookupTable({ authority: c.payer.publicKey, payer: c.payer.publicKey, recentSlot: Math.max(0, slot - 1) });
  await send(c, [create]);
  const uniq = [...new Map(keys.map((k) => [k.toBase58(), k])).values()];
  for (let i = 0; i < uniq.length; i += 20) await send(c, [web3.AddressLookupTableProgram.extendLookupTable({ lookupTable: key, authority: c.payer.publicKey, payer: c.payer.publicKey, addresses: uniq.slice(i, i + 20) })]);
  for (let t = 0; t < 40; t++) {
    const a = (await c.conn.getAddressLookupTable(key)).value;
    if (a && a.state.addresses.length === uniq.length && (await c.conn.getSlot()) > slot + 1) return (table = a);
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('lookup table did not activate');
}

export async function wsmJob(c: Chain): Promise<Report> {
  const r: Report = { sent: [], failed: [], waiting: [] };
  const m = await c.program.account.wsmMarket.fetchNullable(pdas.wsmMarket());
  if (!m) return r;
  const accounts = (await c.program.account.wsmAccount.all()) as Row[];
  if (accounts.length === 0) return r;
  const now = await chainNow(c);
  const epochs = (await c.program.account.epoch.all()) as Row[];
  const vault = await c.program.account.vault.fetch(pdas.vault());
  const usdcReserve = await loadReserve(c, m.usdcReserve);
  const assets = new Map<string, Row>(((await c.program.account.assetConfig.all()) as Row[]).map((a) => [tickerStr(a.account.ticker), a]));
  for (const a of accounts) {
    const w = a.account;
    const ticker = tickerStr(w.ticker);
    const id = `wsm ${w.user.toBase58().slice(0, 8)} ${ticker}`;
    const ep = nextCoverEpoch(epochs, ticker, now);
    if (!ep) continue;
    const freezeStart = n(ep.account.bell) - m.freezeSecs;
    if (now < freezeStart) continue;
    const closure = ep.account.closureId as number;
    if (w.coveredClosure === closure) continue;
    const ob = await loadObligation(c, w.obligation);
    if (!ob || ob.borrows.every((b) => b.borrowedAmountSf.toString() === '0')) continue; // no debt, nothing to cover
    const asset = assets.get(ticker);
    const wa = m.assets.slice(0, m.nAssets).find((x: { ticker: number[] }) => tickerStr(x.ticker) === ticker);
    if (!asset || !wa) { r.waiting.push(`${id}: asset not in the market`); continue; }
    const refreshes = await refreshIxs(c, w.obligation, ob);
    const ix = await c.program.methods.wsmAutoCover(asset.account.ticker, closure).accountsPartial({
      payer: c.payer.publicKey, wsmAccount: a.publicKey, wsmUsdc: pdas.wsmUsdc(w.user), asset: asset.publicKey, scenarios: pdas.scen(ticker, ep.account.closureType),
      epoch: ep.publicKey, earnings: pdas.earnings(ticker), loss: pdas.loss(closure), vault: pdas.vault(), vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(),
      feeAccount: vault.feeAccount, usdcMint: USDC_MINT, obligation: w.obligation, depositReserve: wa.reserve, usdcReserve: m.usdcReserve,
      reserveLiquiditySupply: new web3.PublicKey(usdcReserve.liquidity.supplyVault), reserveFeeVault: new web3.PublicKey(usdcReserve.liquidity.feeVault),
      policy: pdas.policy(ep.publicKey, w.obligation),
      klend: { klendMarket: WSM_MARKET, klendLma: web3.PublicKey.findProgramAddressSync([Buffer.from('lma'), WSM_MARKET.toBuffer()], KLEND)[0], klendProgram: KLEND, farmsProgram: FARMS, instructionSysvar: INSTRUCTIONS_SYSVAR },
    }).instruction();
    try {
      const alt = await sharedTable(c, [
        new web3.PublicKey(KLEND), FARMS, WSM_MARKET, USDC_MINT, INSTRUCTIONS_SYSVAR, pdas.config(), pdas.wsmMarket(), pdas.wsmAuth(), pdas.vault(), pdas.vaultUsdc(), pdas.shares(),
        vault.feeAccount, m.usdcReserve, new web3.PublicKey(usdcReserve.liquidity.supplyVault), new web3.PublicKey(usdcReserve.liquidity.feeVault), pdas.calendar(),
        asset.publicKey, pdas.scen(ticker, ep.account.closureType), pdas.earnings(ticker), web3.PublicKey.findProgramAddressSync([Buffer.from('lma'), WSM_MARKET.toBuffer()], KLEND)[0],
        ...refreshes.flatMap((r) => r.keys.map((k) => k.pubkey)).filter((k) => !k.equals(w.obligation)),
      ]);
      const { cu } = await sendV0(c, [...refreshes, ix], [alt]);
      const after = await c.program.account.wsmAccount.fetch(a.publicKey);
      if (after.coveredClosure === closure) {
        const pol = await c.program.account.policy.fetch(pdas.policy(ep.publicKey, w.obligation));
        r.sent.push(`wsm_auto_cover ${id} ${closure}`);
        log(`  ok   wsm_auto_cover ${id} ${closure}: premium ${(n(pol.premium) / 1e6).toFixed(4)} USDC on a cover of ${(n(pol.maxPayout) / 1e6).toFixed(2)} (${cu} CU)`);
      } else {
        r.waiting.push(`${id}: FLAGGED for ${closure} (cover refused); retried until the bell ${fmtTime(n(ep.account.bell))}`);
        log(`  flag ${id} ${closure}: the program refused the cover and borrowed nothing`);
      }
    } catch (e) {
      r.failed.push(`wsm_auto_cover ${id}`);
      log(`  FAIL wsm_auto_cover ${id}: ${(e as Error).message.split('\n').slice(0, 3).join(' | ')}`);
    }
  }
  return r;
}
