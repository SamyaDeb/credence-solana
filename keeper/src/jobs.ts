// Keeper jobs (task 3.2). Each job reads the chain, decides from the on-chain clock and state, and sends what is due.
// All of them are idempotent: run them in a loop (index.ts) or once per demo step (demo.ts).
//
//   openEpochs      groups + epochs for the next N weekends of the on-chain calendar (enabled assets)
//   closes          snapshot_close from Kamino's Scope price (SCOPE) or the asset's Pyth push account (XSTOCK);
//                   void_epoch when the close never came
//   shields         shield_advance (W1) in each covered epoch's window (Sunday 20:00 ET → the shield deadline): when the
//                   asset's push account implies a larger advance than the policy has, refreshes + the advance
//   settlements     post_settlement from Scope a minute after the open (SCOPE) or the first push update at/after the
//                   open (XSTOCK); halt_epoch after the window
//   settlePolicies  settle_policy for every active policy (refreshes + repay CPI while the obligation still borrows
//                   from the policy's reserve), settle_policy_to_wallet after SETTLE_GRACE if that fails; refund_policy
//                   on voided epochs
//   processQueues   process_deposit / process_withdrawal for every ticket whose groups have settled
//   sleeve          W4 (sleeve.ts): keep the PYUSD sleeve above the live PYUSD reservations (INV-14) from PYUSD the keeper
//                   holds (fund_sleeve); reports what it still needs
//
// Multi-collateral policies (W4, `n_legs` > 0) shield on every leg's push account and settle once every leg's epoch
// is SETTLED (or VOIDED: that leg counts flat); a PYUSD policy is paid from the sleeve in PYUSD (Token-2022).
//   rebalance       W3 (yield.ts): keep cash at the buffer, lend the rest to the USDC reserve, book the yield
//   backstop        W2 (backstop.ts): mark inventory, liquidate watched unhealthy obligations through the vault, open and
//                   close Dutch auctions (BACKSTOP_WATCH: comma-separated obligations)
//
// EQUITY assets need Hermes updates posted through the Pyth receiver; this keeper does not post them yet (the key has
// no equity entitlement), so for EQUITY it only reports.
import anchor from '@anchor-lang/core';
const { web3 } = anchor;
import {
  type Chain, EPOCH, POLICY, TOKEN_2022, SCOPE_AFTER_CLOSE, SCOPE_OPEN_DELAY, SCOPE_PRICES, SETTLE_GRACE, SETTLE_WINDOW, SOURCE, TICKET, TOKEN,
  USDC_MINT, VOID_AFTER, ata, chainNow, decodeScope,
  createAtaIx, decodePriceUpdate, fmtTime, log, pdas, pushAccount, send, tickerStr,
} from './chain.js';
import { borrowedSf, farmsWritable, loadObligation, refreshIxs, repayAccounts } from './kamino.js';
import { backstopJob } from './backstop.js';
import { sleeveJob } from './sleeve.js';
import { yieldJob } from './yield.js';

const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());
const BELL_BEFORE_CLOSE = 15 * 60;
/** `instructions::shield::MIN_TOPUP`: 1 USDC. */
const MIN_TOPUP = 1_000_000;

const DEFAULT_KEY = '11111111111111111111111111111111';

/** The tickers of a multi-collateral policy's legs (W4), leg 0 first; `[ticker]` for a Phase 1 policy. */
export function legTickers(pol: any): string[] {
  const nl = Number(pol.nLegs ?? 0);
  if (nl === 0) return [tickerStr(pol.ticker as number[])];
  const raw = pol.legTickers as number[];
  return Array.from({ length: nl }, (_, i) => tickerStr(raw.slice(8 * i, 8 * i + 8)));
}

/** What a policy is paid in and from (W4): its debt's mint, the vault's USDC or PYUSD sleeve, and the token program. */
export function payWith(cfg: any, v: any, pol: any) {
  const bm = (pol.borrowMint as InstanceType<typeof web3.PublicKey> | undefined)?.toBase58() ?? DEFAULT_KEY;
  const pyusd = bm !== DEFAULT_KEY && cfg.pyusdMint && bm === cfg.pyusdMint.toBase58();
  return pyusd
    ? { pyusd: true, mint: cfg.pyusdMint as InstanceType<typeof web3.PublicKey>, source: v.pyusdSleeve as InstanceType<typeof web3.PublicKey>, tokenProgram: TOKEN_2022, unit: 'PYUSD' }
    : { pyusd: false, mint: USDC_MINT, source: pdas.vaultUsdc(), tokenProgram: TOKEN, unit: 'USDC' };
}
const ro = (pubkey: InstanceType<typeof web3.PublicKey>) => ({ pubkey, isSigner: false, isWritable: false });

/** Report of one keeper pass: what was sent, what failed, what is waiting. */
export type Report = { sent: string[]; failed: string[]; waiting: string[] };
const report = (): Report => ({ sent: [], failed: [], waiting: [] });

async function tryTx(r: Report, what: string, f: () => Promise<{ cu: number }>) {
  try {
    const { cu } = await f();
    r.sent.push(what);
    log(`  ok   ${what} (${cu} CU)`);
    return true;
  } catch (e) {
    r.failed.push(what);
    log(`  FAIL ${what}: ${(e as Error).message.split('\n').slice(0, 4).join(' | ')}`);
    return false;
  }
}

function yyyymmddDays(d: number): number {
  return Date.UTC(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100) / 86_400_000;
}

/** Opens groups and epochs for the next `weekends` WEEKEND closures whose bell is still ahead. */
export async function openEpochs(c: Chain, weekends = 4): Promise<Report> {
  const r = report();
  const now = await chainNow(c);
  const cal = await c.program.account.calendar.fetch(pdas.calendar());
  const sessions = (cal.sessions as { date: number; open: unknown; close: unknown }[]).slice(0, cal.n as number);
  const assets = (await c.program.account.assetConfig.all()).filter((a: EpochRow) => a.account.enabled === 1);
  const fridays: number[] = [];
  for (let i = 0; i + 1 < sessions.length && fridays.length < weekends; i++) {
    const s = sessions[i];
    const d0 = yyyymmddDays(s.date);
    const weekday = new Date(d0 * 86_400_000).getUTCDay();
    if (weekday !== 5 || yyyymmddDays(sessions[i + 1].date) - d0 !== 3) continue; // WEEKEND only
    if (n(s.close as never) - BELL_BEFORE_CLOSE <= now) continue;
    fridays.push(s.date);
  }
  for (const group of fridays) {
    if (!(await c.conn.getAccountInfo(pdas.loss(group)))) {
      await tryTx(r, `open_group ${group}`, async () =>
        send(c, [await c.program.methods.openGroup(group).accountsPartial({ payer: c.payer.publicKey, loss: pdas.loss(group) }).instruction()]));
    }
    for (const a of assets) {
      const t = tickerStr(a.account.ticker as number[]);
      if (await c.conn.getAccountInfo(pdas.epoch(t, group))) continue;
      await tryTx(r, `open_epoch ${t} ${group}`, async () =>
        send(c, [await c.program.methods.openEpoch(a.account.ticker, group)
          .accountsPartial({ payer: c.payer.publicKey, asset: a.publicKey, calendar: pdas.calendar(), loss: pdas.loss(group), epoch: pdas.epoch(t, group) })
          .instruction()]));
    }
  }
  if (fridays.length === 0) r.waiting.push('no WEEKEND closure ahead in the calendar');
  return r;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EpochRow = { publicKey: InstanceType<typeof web3.PublicKey>; account: any };

async function assetsByTicker(c: Chain) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m = new Map<string, { publicKey: InstanceType<typeof web3.PublicKey>; account: any }>();
  for (const a of await c.program.account.assetConfig.all()) m.set(tickerStr(a.account.ticker as number[]), a);
  return m;
}

async function readScope(c: Chain, chain: number) {
  const acc = await c.conn.getAccountInfo(SCOPE_PRICES);
  return acc ? decodeScope(acc.data, chain) : null;
}

async function readPush(c: Chain, feed: number[]) {
  const key = pushAccount(feed);
  const acc = await c.conn.getAccountInfo(key);
  return { key, update: acc ? decodePriceUpdate(acc.data) : null };
}

/** Friday close for every OPEN epoch past its close; voids the ones that never got it. */
export async function closes(c: Chain): Promise<Report> {
  const r = report();
  const now = await chainNow(c);
  const cfg = await c.program.account.config.fetch(pdas.config());
  const assets = await assetsByTicker(c);
  for (const e of (await c.program.account.epoch.all()) as EpochRow[]) {
    const ep = e.account;
    if (ep.state !== EPOCH.OPEN || now < n(ep.close)) continue;
    const t = tickerStr(ep.ticker as number[]);
    const a = assets.get(t)!;
    const id = `${t} ${ep.closureId}`;
    if (now >= n(ep.close) + VOID_AFTER) {
      await tryTx(r, `void_epoch ${id}`, async () =>
        send(c, [await c.program.methods.voidEpoch(ep.ticker, ep.closureId).accountsPartial({ caller: c.payer.publicKey, epoch: e.publicKey }).instruction()]));
      continue;
    }
    if (n(a.account.settleSource) === SOURCE.SCOPE) {
      const p = await readScope(c, n(a.account.scopeChain));
      const [from, to] = [n(ep.close) - (cfg.closeWindowSecs as number), n(ep.close) + SCOPE_AFTER_CLOSE];
      if (!p || p.unixTimestamp < from || p.unixTimestamp > to) {
        r.waiting.push(`${id}: Scope refreshed ${p ? fmtTime(p.unixTimestamp) : 'never'}, window [${fmtTime(from)}, ${fmtTime(to)}]`);
        continue;
      }
      await tryTx(r, `snapshot_close ${id} @ ${p.price.toFixed(4)} (Kamino Scope, ${fmtTime(p.unixTimestamp)})`, async () =>
        send(c, [await c.program.methods.snapshotClose(ep.ticker, ep.closureId)
          .accountsPartial({ caller: c.payer.publicKey, asset: a.publicKey, epoch: e.publicKey, mint: a.account.mint, price: SCOPE_PRICES, xcheck: null })
          .instruction()]));
      continue;
    }
    if (n(a.account.settleSource) !== SOURCE.XSTOCK) {
      r.waiting.push(`${id}: EQUITY close needs a posted Hermes update (not implemented; void after ${fmtTime(n(ep.close) + VOID_AFTER)})`);
      continue;
    }
    const { key, update } = await readPush(c, a.account.feedXstock as number[]);
    const from = n(ep.close) - (cfg.xstockSettleWindowSecs as number);
    if (!update || update.publishTime < from || update.publishTime > n(ep.close)) {
      r.waiting.push(`${id}: push account holds ${update ? fmtTime(update.publishTime) : 'nothing'}, window [${fmtTime(from)}, ${fmtTime(n(ep.close))}]`);
      continue;
    }
    await tryTx(r, `snapshot_close ${id} @ ${update.price.toFixed(4)} (${fmtTime(update.publishTime)})`, async () =>
      send(c, [await c.program.methods.snapshotClose(ep.ticker, ep.closureId)
        .accountsPartial({ caller: c.payer.publicKey, asset: a.publicKey, epoch: e.publicKey, mint: a.account.mint, price: key, xcheck: null })
        .instruction()]));
  }
  return r;
}

/** Settlement price for every CLOSED/HALTED epoch whose window opened; halts the ones whose window passed empty. */
export async function settlements(c: Chain): Promise<Report> {
  const r = report();
  const now = await chainNow(c);
  const cfg = await c.program.account.config.fetch(pdas.config());
  const assets = await assetsByTicker(c);
  for (const e of (await c.program.account.epoch.all()) as EpochRow[]) {
    const ep = e.account;
    if ((ep.state !== EPOCH.CLOSED && ep.state !== EPOCH.HALTED) || now < n(ep.open)) continue;
    const t = tickerStr(ep.ticker as number[]);
    const a = assets.get(t)!;
    const id = `${t} ${ep.closureId}`;
    // Settle on the source the close was stored with (the program does the same), not the asset's current one.
    const xstock = n(ep.closeSource) === SOURCE.XSTOCK;
    const scope = n(ep.closeSource) === SOURCE.SCOPE;
    const to = scope ? n(ep.open) + SCOPE_OPEN_DELAY + SETTLE_WINDOW
      : xstock ? n(ep.open) + (cfg.xstockSettleWindowSecs as number) : n(ep.settleAfter);
    const halt = async () =>
      tryTx(r, `halt_epoch ${id} (no update in [${fmtTime(n(ep.open))}, ${fmtTime(to)}])`, async () =>
        send(c, [await c.program.methods.haltEpoch(ep.ticker, ep.closureId)
          .accountsPartial({ keeper: c.payer.publicKey, asset: a.publicKey, epoch: e.publicKey, calendar: pdas.calendar() })
          .instruction()]));
    if (scope) {
      const from = n(ep.open) + SCOPE_OPEN_DELAY;
      if (now < from) { r.waiting.push(`${id}: Scope settlement window opens ${fmtTime(from)}`); continue; }
      const p = await readScope(c, n(a.account.scopeChain));
      if (p && p.unixTimestamp >= from && p.unixTimestamp <= to) {
        await tryTx(r, `post_settlement ${id} @ ${p.price.toFixed(4)} (Kamino Scope, ${fmtTime(p.unixTimestamp)})`, async () =>
          send(c, [await c.program.methods.postSettlement(ep.ticker, ep.closureId)
            .accountsPartial({ keeper: c.payer.publicKey, asset: a.publicKey, epoch: e.publicKey, mint: a.account.mint, xcheck: null })
            .remainingAccounts([{ pubkey: SCOPE_PRICES, isSigner: false, isWritable: false }])
            .instruction()]));
      } else if (now > to) {
        await halt();
      } else {
        r.waiting.push(`${id}: waiting for a Scope refresh after ${fmtTime(from)} (last ${p ? fmtTime(p.unixTimestamp) : 'never'})`);
      }
      continue;
    }
    if (!xstock) {
      if (now > to) await halt();
      else r.waiting.push(`${id}: EQUITY settlement needs posted Hermes updates (not implemented)`);
      continue;
    }
    const { key, update } = await readPush(c, a.account.feedXstock as number[]);
    if (update && update.publishTime >= n(ep.open) && update.publishTime <= to) {
      await tryTx(r, `post_settlement ${id} @ ${update.price.toFixed(4)} (${fmtTime(update.publishTime)})`, async () =>
        send(c, [await c.program.methods.postSettlement(ep.ticker, ep.closureId)
          .accountsPartial({ keeper: c.payer.publicKey, asset: a.publicKey, epoch: e.publicKey, mint: a.account.mint, xcheck: null })
          .remainingAccounts([{ pubkey: key, isSigner: false, isWritable: false }])
          .instruction()]));
    } else if (now > to) {
      await halt();
    } else {
      r.waiting.push(`${id}: waiting for the first push after ${fmtTime(n(ep.open))} (holds ${update ? fmtTime(update.publishTime) : 'nothing'})`);
    }
  }
  return r;
}

/** Liquidation Shield (W1): during each covered epoch's window, advances into every active policy whose obligation the
 * weekend fair value (the asset's push account) says needs more than it has received. The send decision uses a float
 * estimate of `pricing::shield_target`; the program recomputes it exactly and does nothing when there is nothing to
 * add, so a retry is harmless. */
export async function shields(c: Chain): Promise<Report> {
  const r = report();
  const cfg = await c.program.account.config.fetch(pdas.config());
  const alpha = Number(cfg.shieldAlphaWad.toString()) / 1e18;
  if (alpha === 0) return r;
  const b = Number(cfg.shieldBufferWad.toString()) / 1e18;
  const h = Number(cfg.shieldHealthWad.toString()) / 1e18;
  const now = await chainNow(c);
  const assets = await assetsByTicker(c);
  const v = await c.program.account.vault.fetch(pdas.vault());
  const epochs = new Map(((await c.program.account.epoch.all()) as EpochRow[]).map((e) => [e.publicKey.toBase58(), e]));
  const pushes = new Map<string, Awaited<ReturnType<typeof readPush>>>(); // one read per asset per pass (audit A-30)
  for (const p of (await c.program.account.policy.all()) as EpochRow[]) {
    const pol = p.account;
    const e = epochs.get(pol.epoch.toBase58());
    if (pol.state !== POLICY.ACTIVE || !e || e.account.state !== EPOCH.CLOSED) continue; // CLOSED only (A-26)
    const from = n(e.account.open) - (cfg.shieldStartBeforeOpenSecs as number);
    const to = n(e.account.open) - (cfg.shieldDeadlineBeforeOpenSecs as number);
    const tickers = legTickers(pol);
    const id = `${tickers.join('+')} ${e.account.closureId} policy ${p.publicKey.toBase58().slice(0, 8)}`;
    if (now < from || now > to) continue;
    // Every leg: its asset, its epoch (CLOSED, same group), a usable fair value on its push account.
    type LegFair = { t: string; asset: EpochRow; epoch: EpochRow; key: InstanceType<typeof web3.PublicKey>; price: number; close: number; publishTime: number };
    const legs: LegFair[] = [];
    let why: string | null = null;
    for (const t of tickers) {
      const a = assets.get(t);
      const le = epochs.get(pdas.epoch(t, e.account.closureId).toBase58());
      if (!a || !le) { why = `${t}: no asset or epoch`; break; }
      if (le.account.state !== EPOCH.CLOSED) { why = `${t} epoch not CLOSED`; break; }
      if (!pushes.has(t)) pushes.set(t, await readPush(c, a.account.feedXstock as number[]));
      const { key, update } = pushes.get(t)!;
      // The program's checks, mirrored so that a pass does not send what it will refuse (audit A-30).
      const feed = Buffer.from(a.account.feedXstock as number[]).toString('hex');
      why = !update ? 'empty'
        : !update.full ? 'not Full-verified'
        : update.feedId !== feed ? 'wrong feed'
        : now - update.publishTime > (cfg.shieldMaxAgeSecs as number) || update.publishTime < n(le.account.close) - 3600 ? `published ${fmtTime(update.publishTime)}, outside the accepted age`
        : update.confRaw * 10_000n > update.priceRaw * BigInt(cfg.maxConfBps as number) ? 'confidence too wide'
        : null;
      if (why || !update) { why = `${t}: ${why}`; break; }
      legs.push({ t, asset: a, epoch: le, key, price: update.price, close: Number(BigInt(le.account.closePriceWad.toString())) / 1e18, publishTime: update.publishTime });
    }
    if (why) {
      r.waiting.push(`${id}: no usable fair value (${why})`);
      continue;
    }
    // Estimate: min(α·cap, D − Σ C′_i/(1 + h) · (fair_i/close_i)(1 − b) − S′/(1 + h)).
    const D = n(pol.debt), cap = n(pol.maxPayout);
    const multi = Number(pol.nLegs ?? 0) > 0;
    const covered = multi ? legs.map((_, i) => n(pol.legCovered[i])) : [n(pol.coveredValue)];
    const stable = multi ? n(pol.stableCovered) : 0;
    const after = legs.reduce((acc, l, i) => acc + (covered[i] / (1 + h)) * (l.price / l.close) * (1 - b), stable / (1 + h));
    // Capped by the policy's reserved worst-case loss (INV-12, audit A-32); the program also caps the group total.
    const est = Math.min(alpha * cap, n(pol.worstLoss), Math.max(0, D - after));
    // The program skips a top-up under MIN_TOPUP (1 USDC) once a policy has an advance (audit A-40); mirror it so a
    // pass does not send no-op transactions. The first advance goes from 1 base unit.
    if (est <= n(pol.advanced) + (n(pol.advanced) > 0 ? MIN_TOPUP : 1)) continue;
    const ob = await loadObligation(c, pol.obligation);
    if (!ob || borrowedSf(ob, pol.borrowReserve) === 0n) {
      r.waiting.push(`${id}: obligation has no debt left on the policy's reserve; nothing to advance into`);
      continue;
    }
    const pay = payWith(cfg, v, pol);
    const debt0 = borrowedSf(ob, pol.borrowReserve);
    const kamino = await repayAccounts(c, pol.obligation, new web3.PublicKey(ob.lendingMarket), pol.borrowReserve);
    // Legs 1..: [asset, epoch, push account] each.
    const rest = legs.slice(1).flatMap((l) => [ro(l.asset.publicKey), ro(l.epoch.publicKey), ro(l.key)]);
    const fairs = legs.map((l) => `${l.t} ${l.price.toFixed(4)} (${((l.price / l.close - 1) * 100).toFixed(2)}%)`).join(', ');
    const ok = await tryTx(r, `shield_advance ${id} at fair ${fairs}, ${fmtTime(Math.min(...legs.map((l) => l.publishTime)))}`, async () =>
      send(c, [...(await refreshIxs(c, pol.obligation, ob)),
        farmsWritable(await c.program.methods.shieldAdvance()
          .accountsPartial({ keeper: c.payer.publicKey, asset: legs[0].asset.publicKey, epoch: e.publicKey, policy: p.publicKey, loss: pdas.loss(e.account.closureId), vaultUsdc: pay.source,
            usdcMint: pay.mint, tokenProgram: pay.tokenProgram, priceUpdate: legs[0].key, obligation: pol.obligation, ...kamino })
          .remainingAccounts(rest)
          .instruction(), kamino)]));
    if (ok) {
      const after1 = await loadObligation(c, pol.obligation);
      const done = await c.program.account.policy.fetch(p.publicKey);
      log(`       advanced ${(n(done.advanced) / 1e6).toFixed(6)} ${pay.unit} in total; obligation debt ${fmtUsdc(debt0)} → ${fmtUsdc(after1 ? borrowedSf(after1, pol.borrowReserve) : 0n)}`);
    }
  }
  return r;
}

/** Settles (or refunds) every active policy of settled (or voided) epochs. */
export async function settlePolicies(c: Chain): Promise<Report> {
  const r = report();
  const now = await chainNow(c);
  const cfg = await c.program.account.config.fetch(pdas.config());
  const v = await c.program.account.vault.fetch(pdas.vault());
  const epochs = new Map(((await c.program.account.epoch.all()) as EpochRow[]).map((e) => [e.publicKey.toBase58(), e]));
  const policies = (await c.program.account.policy.all()).filter((p: EpochRow) => p.account.state === POLICY.ACTIVE);
  for (const p of policies) {
    const pol = p.account;
    const e = epochs.get(pol.epoch.toBase58());
    if (!e || (e.account.state !== EPOCH.SETTLED && e.account.state !== EPOCH.VOIDED)) continue;
    const tickers = legTickers(pol);
    const id = `${tickers.join('+')} ${e.account.closureId} policy ${p.publicKey.toBase58().slice(0, 8)}`;
    // Multi-collateral (W4): every other leg's epoch SETTLED or VOIDED, passed in leg order.
    const legEpochs = tickers.slice(1).map((t) => epochs.get(pdas.epoch(t, e.account.closureId).toBase58()));
    const pending = legEpochs.findIndex((le) => !le || (le.account.state !== EPOCH.SETTLED && le.account.state !== EPOCH.VOIDED));
    if (pending >= 0) {
      r.waiting.push(`${id}: ${tickers[pending + 1]} not settled yet`);
      continue;
    }
    // Refunded (in USDC, as the premium was paid) only when every leg is voided; a voided leg next to a settled one
    // counts flat at settlement (audit A-47).
    if (e.account.state === EPOCH.VOIDED && legEpochs.every((le) => le!.account.state === EPOCH.VOIDED)) {
      const ownerUsdc = ata(pol.owner, USDC_MINT);
      const base = { caller: c.payer.publicKey, epoch: e.publicKey, policy: p.publicKey, loss: pdas.loss(e.account.closureId), vaultUsdc: pdas.vaultUsdc(), ownerUsdc };
      await tryTx(r, `refund_policy ${id}`, async () => send(c, [createAtaIx(c.payer.publicKey, pol.owner, USDC_MINT),
        await c.program.methods.refundPolicy().accountsPartial(base).remainingAccounts(legEpochs.map((le) => ro(le!.publicKey))).instruction()]));
      continue;
    }
    const rest = legEpochs.map((le) => ro(le!.publicKey));
    const pay = payWith(cfg, v, pol);
    const ownerUsdc = ata(pol.owner, pay.mint, pay.tokenProgram);
    const mkAta = createAtaIx(c.payer.publicKey, pol.owner, pay.mint, pay.tokenProgram);
    const base = { caller: c.payer.publicKey, epoch: e.publicKey, policy: p.publicKey, loss: pdas.loss(e.account.closureId), vaultUsdc: pay.source, ownerUsdc };
    const payAccts = { usdcMint: pay.mint, tokenProgram: pay.tokenProgram };
    const ob = await loadObligation(c, pol.obligation);
    const intoObligation = ob !== null && borrowedSf(ob, pol.borrowReserve) > 0n;
    let ok: boolean;
    if (intoObligation) {
      const debt0 = borrowedSf(ob!, pol.borrowReserve);
      const kamino = await repayAccounts(c, pol.obligation, new web3.PublicKey(ob!.lendingMarket), pol.borrowReserve);
      ok = await tryTx(r, `settle_policy ${id} → repay into obligation ${pol.obligation.toBase58().slice(0, 8)}`, async () =>
        send(c, [mkAta, ...(await refreshIxs(c, pol.obligation, ob!)),
          farmsWritable(await c.program.methods.settlePolicy().accountsPartial({ ...base, obligation: pol.obligation, ...payAccts, ...kamino }).remainingAccounts(rest).instruction(), kamino)]));
      if (ok) {
        const after = await loadObligation(c, pol.obligation);
        const d1 = after ? borrowedSf(after, pol.borrowReserve) : 0n;
        const settled = await c.program.account.policy.fetch(p.publicKey);
        log(`       payout ${(n(settled.payout) / 1e6).toFixed(6)} ${pay.unit}; obligation debt ${fmtUsdc(debt0)} → ${fmtUsdc(d1)}`);
      }
    } else {
      ok = await tryTx(r, `settle_policy ${id} → owner's wallet (obligation closed or no longer borrows from the reserve)`, async () =>
        send(c, [mkAta, await c.program.methods.settlePolicy()
          .accountsPartial({ ...base, obligation: pol.obligation, ...payAccts,
            lendingMarket: null, repayReserve: null, reserveDestinationLiquidity: null, instructionSysvar: null,
            obligationFarmUserState: null, reserveFarmState: null, lendingMarketAuthority: null, farmsProgram: null, klendProgram: null })
          .remainingAccounts(rest)
          .instruction()]));
    }
    if (!ok) {
      const after = Math.max(n(e.account.settledAt), ...legEpochs.map((le) => n(le!.account.settledAt))) + SETTLE_GRACE; // A-47
      if (now >= after) {
        // A PYUSD payout above the sleeve: the rest in USDC to the owner's USDC account (audit A-44).
        const cash = pay.pyusd
          ? { cash: pdas.vaultUsdc(), ownerCash: ata(pol.owner, USDC_MINT), cashMint: USDC_MINT, cashTokenProgram: TOKEN }
          : { cash: null, ownerCash: null, cashMint: null, cashTokenProgram: null };
        const pre = pay.pyusd ? [mkAta, createAtaIx(c.payer.publicKey, pol.owner, USDC_MINT)] : [mkAta];
        await tryTx(r, `settle_policy_to_wallet ${id} (grace passed)`, async () =>
          send(c, [...pre, await c.program.methods.settlePolicyToWallet().accountsPartial({ ...base, ...payAccts, ...cash }).remainingAccounts(rest).instruction()]));
      } else {
        r.waiting.push(`${id}: retry; wallet fallback from ${fmtTime(after)}`);
      }
    }
  }
  return r;
}

const fmtUsdc = (sf: bigint) => (Number(sf >> 60n) / 1e6).toFixed(6);

/** Applies every queued deposit and withdrawal whose groups have all settled. */
export async function processQueues(c: Chain): Promise<Report> {
  const r = report();
  const v = await c.program.account.vault.fetch(pdas.vault());
  const live = (v.live as number[]).filter((g) => g !== 0);
  for (const t of await c.program.account.queueTicket.all()) {
    const tk = t.account;
    const id = `${tk.kind === TICKET.DEPOSIT ? 'deposit' : 'withdrawal'} ${tk.owner.toBase58().slice(0, 8)} (waits for ${tk.waitGroup || 'none'})`;
    if (live.some((g) => g <= (tk.waitGroup as number))) {
      r.waiting.push(`${id}: group(s) ${live.filter((g) => g <= (tk.waitGroup as number)).join(', ')} still live`);
      continue;
    }
    if (tk.kind === TICKET.DEPOSIT) {
      await tryTx(r, `process_deposit ${id}`, async () =>
        send(c, [createAtaIx(c.payer.publicKey, tk.owner, pdas.shares()), createAtaIx(c.payer.publicKey, tk.owner, USDC_MINT),
          await c.program.methods.processDeposit()
            .accountsPartial({ caller: c.payer.publicKey, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), ticket: t.publicKey, owner: tk.owner,
              ownerShares: ata(tk.owner, pdas.shares()), shareEscrow: pdas.shareEscrow(), ownerUsdc: ata(tk.owner, USDC_MINT) })
            .instruction()]));
    } else {
      await tryTx(r, `process_withdrawal ${id}`, async () =>
        send(c, [createAtaIx(c.payer.publicKey, tk.owner, USDC_MINT),
          await c.program.methods.processWithdrawal()
            .accountsPartial({ caller: c.payer.publicKey, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), shareEscrow: pdas.shareEscrow(), ticket: t.publicKey, owner: tk.owner, ownerUsdc: ata(tk.owner, USDC_MINT) })
            .instruction()]));
    }
  }
  return r;
}

/** Obligations the backstop job checks each pass (BACKSTOP_WATCH, comma-separated). */
const envWatch = () => (process.env.BACKSTOP_WATCH ?? '').split(',').filter(Boolean).map((k) => new web3.PublicKey(k.trim()));

const firstLine = (e: unknown) => ((e as Error)?.message ?? String(e)).split('\n')[0];

/** One keeper pass, all jobs in order. Never throws: an RPC error outside a transaction fails that job (or the pass, if
 * the clock cannot be read) and the next pass retries, so the loop survives a flaky RPC mid-weekend. */
export async function tick(c: Chain, weekends = 4, watch: InstanceType<typeof web3.PublicKey>[] = envWatch()): Promise<Report> {
  const all = report();
  let now: number;
  try {
    now = await chainNow(c);
  } catch (e) {
    all.failed.push(`pass: ${firstLine(e)}`);
    log(`  FAIL pass: ${firstLine(e)}`);
    return all;
  }
  log(`keeper pass at chain time ${fmtTime(now)}`);
  for (const [name, job] of [
    ['openEpochs', () => openEpochs(c, weekends)],
    ['closes', () => closes(c)],
    ['shields', () => shields(c)],
    ['settlements', () => settlements(c)],
    ['settlePolicies', () => settlePolicies(c)],
    ['rebalance', () => yieldJob(c)],
    ['sleeve', () => sleeveJob(c)],
    ['processQueues', () => processQueues(c)],
    ['backstop', () => backstopJob(c, watch)],
  ] as const) {
    let r: Report;
    try {
      r = await job();
    } catch (e) {
      all.failed.push(`${name}: ${firstLine(e)}`);
      log(`  FAIL ${name}: ${firstLine(e)}`);
      continue;
    }
    all.sent.push(...r.sent);
    all.failed.push(...r.failed);
    all.waiting.push(...r.waiting.map((w) => `${name}: ${w}`));
  }
  for (const w of all.waiting) log(`  wait ${w}`);
  return all;
}

