// NAV-priced assets (D4, research prototype) keeper job. Per pass, for every registered NavSchedule:
//   - open: the closures whose bell is still ahead (the next NAV_AHEAD strikes, default 2): `open_group` for the date if its loss vector
//     is missing, then `open_nav_epoch` (permissionless; refused by the program while the guardian has gated the asset or the protocol
//     is paused, in which case the job only reports);
//   - halt: a NAV closure whose settlement window passed with no valid NAV from the lender's oracle gets `halt_nav_epoch` (the generic
//     `settlements` job skips NAV closures: their next window comes from the schedule, not the exchange calendar).
// Closing and settling a NAV closure, settling its policies and voiding it are the generic jobs' (they read the lender's Scope
// price like any SCOPE asset). The Shield never acts on a NAV closure.
import anchor from '@anchor-lang/core';
const { web3 } = anchor;
import { CLOSURE, EPOCH, SOURCE, chainNow, fmtTime, pdas, send, tickerStr, type Chain } from './chain.js';
import type { Report } from './jobs.js';

type Pk = InstanceType<typeof web3.PublicKey>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = { publicKey: Pk; account: any };
const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());
const DAY = 86_400;
const BELL_BEFORE_CLOSE = 900;
const SCOPE_OPEN_DELAY = 60;
const SETTLE_WINDOW = 300;

const u32le = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};
export const navPda = (programId: Pk, t: string) => web3.PublicKey.findProgramAddressSync([Buffer.from('navsched'), Buffer.from(t.padEnd(8, '\0'))], programId)[0];

/** yyyymmdd of a Unix time (UTC). */
export function yyyymmdd(unix: number): number {
  const d = new Date(unix * 1000);
  return d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate();
}

/** The strikes of a schedule whose bell is ahead: `{ id, close }`, soonest first (the program's `nav_times`: close = the date's strike). */
export function nextStrikes(anchorTs: number, intervalSecs: number, now: number, count: number) {
  const out: { id: number; close: number }[] = [];
  if (intervalSecs < DAY || intervalSecs % DAY !== 0) return out;
  // The first strike k with close − bell_before > now, k ≥ 0.
  let k = Math.max(0, Math.floor((now + BELL_BEFORE_CLOSE - anchorTs) / intervalSecs));
  while (anchorTs + k * intervalSecs - BELL_BEFORE_CLOSE <= now) k++;
  for (let i = 0; i < count; i++, k++) {
    const close = anchorTs + k * intervalSecs;
    out.push({ id: yyyymmdd(close), close });
  }
  return out;
}

export async function navJob(c: Chain): Promise<Report> {
  const r: Report = { sent: [], failed: [], waiting: [] };
  const schedules = (await c.program.account.navSchedule.all()) as Row[];
  if (schedules.length === 0) return r;
  const now = await chainNow(c);
  const cfg = await c.program.account.config.fetch(pdas.config());
  const ahead = Number(process.env.NAV_AHEAD ?? 2);
  const epochs = (await c.program.account.epoch.all()) as Row[];
  const tryTx = async (id: string, f: () => Promise<{ sig: string; cu: number }>) => {
    try {
      const res = await f();
      r.sent.push(`${id} (${res.cu} CU)`);
    } catch (e) {
      r.failed.push(`${id}: ${String((e as Error).message).split('\n')[0]}`);
    }
  };
  for (const s of schedules) {
    const t = tickerStr(s.account.ticker as number[]);
    const asset = await c.program.account.assetConfig.fetchNullable(pdas.asset(t));
    if (!asset || asset.enabled !== 1) continue;
    if (s.account.gated === 1) r.waiting.push(`${t}: the redemption gate is closed: no new NAV closure opens`);
    else if (cfg.paused) r.waiting.push(`${t}: the protocol is paused`);
    else {
      for (const { id } of nextStrikes(n(s.account.anchorTs), s.account.intervalSecs as number, now, ahead)) {
        if (await c.conn.getAccountInfo(pdas.epoch(t, id))) continue;
        if (!(await c.conn.getAccountInfo(pdas.loss(id)))) {
          await tryTx(`open_group ${id}`, async () =>
            send(c, [await c.program.methods.openGroup(id).accountsPartial({ payer: c.payer.publicKey, loss: pdas.loss(id) }).instruction()]));
        }
        await tryTx(`open_nav_epoch ${t} ${id}`, async () =>
          send(c, [await c.program.methods.openNavEpoch(s.account.ticker, id)
            .accountsPartial({ payer: c.payer.publicKey, asset: pdas.asset(t), schedule: s.publicKey, loss: pdas.loss(id), epoch: pdas.epoch(t, id) })
            .instruction()]));
      }
    }
    // Halt a closure whose settlement window passed empty.
    for (const e of epochs) {
      const ep = e.account;
      if (tickerStr(ep.ticker as number[]) !== t || ep.closureType !== CLOSURE.NAV_STRIKE) continue;
      if (ep.state !== EPOCH.CLOSED && ep.state !== EPOCH.HALTED) continue;
      const scope = n(ep.closeSource) === SOURCE.SCOPE;
      const to = n(ep.open) + (scope ? SCOPE_OPEN_DELAY + SETTLE_WINDOW : SETTLE_WINDOW);
      if (now <= to) continue;
      // A settlement the generic job could still post would already have moved the state; this one is past its window.
      await tryTx(`halt_nav_epoch ${t} ${ep.closureId} (no NAV in [${fmtTime(n(ep.open))}, ${fmtTime(to)}])`, async () =>
        send(c, [await c.program.methods.haltNavEpoch(ep.ticker, ep.closureId)
          .accountsPartial({ keeper: c.payer.publicKey, schedule: s.publicKey, epoch: e.publicKey })
          .instruction()]));
    }
  }
  return r;
}
