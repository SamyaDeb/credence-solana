// Keeper jobs (task 3.2). Each job reads the chain, decides from the on-chain clock and state, and sends what is due.
// All of them are idempotent: run them in a loop (index.ts) or once per demo step (demo.ts).
//
//   openEpochs      groups + epochs for the next N weekends of the on-chain calendar (enabled assets)
//   closes          snapshot_close from Kamino's Scope price (SCOPE) or the asset's Pyth push account (XSTOCK);
//                   void_epoch when the close never came
//   settlements     post_settlement from Scope a minute after the open (SCOPE) or the first push update at/after the
//                   open (XSTOCK); halt_epoch after the window
//   settlePolicies  settle_policy for every active policy (refreshes + repay CPI while the obligation still borrows
//                   from the policy's reserve), settle_policy_to_wallet after SETTLE_GRACE if that fails; refund_policy
//                   on voided epochs
//   processQueues   process_deposit / process_withdrawal for every ticket whose groups have settled
//
// EQUITY assets need Hermes updates posted through the Pyth receiver; this keeper does not post them yet (the key has
// no equity entitlement, plan/06), so for EQUITY it only reports.
import anchor from '@anchor-lang/core';
const { web3 } = anchor;
import {
  type Chain, EPOCH, POLICY, SCOPE_AFTER_CLOSE, SCOPE_OPEN_DELAY, SCOPE_PRICES, SETTLE_GRACE, SETTLE_WINDOW, SOURCE, TICKET, TOKEN,
  USDC_MINT, VOID_AFTER, ata, chainNow, decodeScope,
  createAtaIx, decodePriceUpdate, fmtTime, log, pdas, pushAccount, send, tickerStr,
} from './chain.js';
import { borrowedSf, loadObligation, refreshIxs, repayAccounts } from './kamino.js';

const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());
const BELL_BEFORE_CLOSE = 15 * 60;

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
    if (weekday !== 5 || yyyymmddDays(sessions[i + 1].date) - d0 !== 3) continue; // WEEKEND only (plan/02 §1)
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
    const xstock = n(a.account.settleSource) === SOURCE.XSTOCK;
    const scope = n(a.account.settleSource) === SOURCE.SCOPE;
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

/** Settles (or refunds) every active policy of settled (or voided) epochs. */
export async function settlePolicies(c: Chain): Promise<Report> {
  const r = report();
  const now = await chainNow(c);
  const epochs = new Map(((await c.program.account.epoch.all()) as EpochRow[]).map((e) => [e.publicKey.toBase58(), e]));
  const policies = (await c.program.account.policy.all()).filter((p: EpochRow) => p.account.state === POLICY.ACTIVE);
  for (const p of policies) {
    const pol = p.account;
    const e = epochs.get(pol.epoch.toBase58());
    if (!e || (e.account.state !== EPOCH.SETTLED && e.account.state !== EPOCH.VOIDED)) continue;
    const id = `${tickerStr(pol.ticker as number[])} ${e.account.closureId} policy ${p.publicKey.toBase58().slice(0, 8)}`;
    const ownerUsdc = ata(pol.owner, USDC_MINT);
    const mkAta = createAtaIx(c.payer.publicKey, pol.owner, USDC_MINT);
    const base = { caller: c.payer.publicKey, epoch: e.publicKey, policy: p.publicKey, loss: pdas.loss(e.account.closureId), vaultUsdc: pdas.vaultUsdc(), ownerUsdc };
    if (e.account.state === EPOCH.VOIDED) {
      await tryTx(r, `refund_policy ${id}`, async () => send(c, [mkAta, await c.program.methods.refundPolicy().accountsPartial(base).instruction()]));
      continue;
    }
    const ob = await loadObligation(c, pol.obligation);
    const intoObligation = ob !== null && borrowedSf(ob, pol.borrowReserve) > 0n;
    let ok: boolean;
    if (intoObligation) {
      const debt0 = borrowedSf(ob!, pol.borrowReserve);
      const kamino = await repayAccounts(c, pol.obligation, new web3.PublicKey(ob!.lendingMarket), pol.borrowReserve);
      ok = await tryTx(r, `settle_policy ${id} → repay into obligation ${pol.obligation.toBase58().slice(0, 8)}`, async () =>
        send(c, [mkAta, ...(await refreshIxs(c, pol.obligation, ob!)),
          await c.program.methods.settlePolicy().accountsPartial({ ...base, obligation: pol.obligation, usdcMint: USDC_MINT, tokenProgram: TOKEN, ...kamino }).instruction()]));
      if (ok) {
        const after = await loadObligation(c, pol.obligation);
        const d1 = after ? borrowedSf(after, pol.borrowReserve) : 0n;
        const settled = await c.program.account.policy.fetch(p.publicKey);
        log(`       payout ${(n(settled.payout) / 1e6).toFixed(6)} USDC; obligation debt ${fmtUsdc(debt0)} → ${fmtUsdc(d1)}`);
      }
    } else {
      ok = await tryTx(r, `settle_policy ${id} → owner's wallet (obligation closed or no longer borrows from the reserve)`, async () =>
        send(c, [mkAta, await c.program.methods.settlePolicy()
          .accountsPartial({ ...base, obligation: pol.obligation, usdcMint: USDC_MINT, tokenProgram: TOKEN,
            lendingMarket: null, repayReserve: null, reserveDestinationLiquidity: null, instructionSysvar: null,
            obligationFarmUserState: null, reserveFarmState: null, lendingMarketAuthority: null, farmsProgram: null, klendProgram: null })
          .instruction()]));
    }
    if (!ok) {
      const after = n(e.account.settledAt) + SETTLE_GRACE;
      if (now >= after) {
        await tryTx(r, `settle_policy_to_wallet ${id} (grace passed)`, async () =>
          send(c, [mkAta, await c.program.methods.settlePolicyToWallet().accountsPartial(base).instruction()]));
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
        send(c, [createAtaIx(c.payer.publicKey, tk.owner, pdas.shares()),
          await c.program.methods.processDeposit()
            .accountsPartial({ caller: c.payer.publicKey, shareMint: pdas.shares(), ticket: t.publicKey, owner: tk.owner, ownerShares: ata(tk.owner, pdas.shares()) })
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

/** One keeper pass, all jobs in order. */
export async function tick(c: Chain, weekends = 4): Promise<Report> {
  const all = report();
  const now = await chainNow(c);
  log(`keeper pass at chain time ${fmtTime(now)}`);
  for (const [name, job] of [
    ['openEpochs', () => openEpochs(c, weekends)],
    ['closes', () => closes(c)],
    ['settlements', () => settlements(c)],
    ['settlePolicies', () => settlePolicies(c)],
    ['processQueues', () => processQueues(c)],
  ] as const) {
    const r = await job();
    all.sent.push(...r.sent);
    all.failed.push(...r.failed);
    all.waiting.push(...r.waiting.map((w) => `${name}: ${w}`));
  }
  for (const w of all.waiting) log(`  wait ${w}`);
  return all;
}

