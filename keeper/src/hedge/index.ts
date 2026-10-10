// Hedge keeper job (D3, testnet hedge, research). Off unless HEDGE=1 and HEDGE_TESTNET_KEY is set; the key is read here and
// handed to the venue adapter, never logged. Per pass, for each weekend group:
//   - open     the Friday close is stored (epochs CLOSED), the open has not come, no hedge book yet: size the hedge with the Rust
//              helper (risk-core loss-weighted delta × HEDGE_H, capped by the program's margin cap), short it on the venue, then
//              `open_hedge` with the fills' entry prices and the margin;
//   - report   a minute after the open: close the shorts, net the venue's own fills, fees and funding, clamp to what the prices
//              imply (Rust helper) and `report_hedge` with a hash of the fills;
//   - finalize the group settled, the challenge delay passed, every epoch SETTLED: `finalize_hedge` (the keeper's USDC account
//              brings a gain or receives a loss).
// A hedge that is paused (guardian), refused by the program or not listed on the venue is reported, never forced.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import { CLOSURE, EPOCH, POLICY, PROGRAM_ID, ROOT, USDC_MINT, ata, chainNow, pdas, send, tickerStr, ticker8, type Chain } from '../chain.js';
import type { Report } from '../jobs.js';
import { INSTRUMENT } from './map.js';
import { HyperliquidTestnet } from './hyperliquid.js';
import { netPnl, type Fill, type HedgeVenue } from './venue.js';

type Pk = InstanceType<typeof web3.PublicKey>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = { publicKey: Pk; account: any };
const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());
const u32le = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};
const hedgeCfgPda = () => web3.PublicKey.findProgramAddressSync([Buffer.from('hedgecfg')], PROGRAM_ID)[0];
export const hedgeBookPda = (group: number) => web3.PublicKey.findProgramAddressSync([Buffer.from('hedge'), u32le(group)], PROGRAM_ID)[0];

export const hedgeEnabled = () => process.env.HEDGE === '1' && !!process.env.HEDGE_TESTNET_KEY;
export const hedgeFraction = () => {
  const h = (process.env.HEDGE_H ?? '0.5').trim();
  if (!/^(0(\.\d{1,18})?|1(\.0{1,18})?)$/.test(h)) throw new Error(`HEDGE_H must be a decimal in [0, 1], got "${h}"`);
  return h;
};

// ----- the Rust helper (risk-core): deltas and P&L bounds. No risk math in TypeScript. -----
export function helper(req: unknown): Record<string, unknown> {
  const bin = process.env.HEDGE_DELTA_BIN ?? `${ROOT}target/release/examples/hedge_delta`;
  const r = existsSync(bin)
    ? spawnSync(bin, { input: JSON.stringify(req), encoding: 'utf8' })
    : spawnSync('cargo', ['run', '-q', '-p', 'credence-core', '--example', 'hedge_delta', '--release'], { input: JSON.stringify(req), encoding: 'utf8', cwd: ROOT });
  if (r.status !== 0 && !r.stdout) throw new Error(`hedge_delta failed: ${(r.stderr ?? '').slice(-200)}`);
  const out = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
  if (out.error) throw new Error(`hedge_delta: ${out.error}`);
  return out;
}

/** The group's live policies as the helper wants them (C′ per xStock, debt, cap). */
export function positionsOf(policies: Row[], epochKeys: Set<string>) {
  const out: { debt: string; cap: string; covered: Record<string, string>; stable: string }[] = [];
  for (const p of policies) {
    const a = p.account;
    if (a.state !== POLICY.ACTIVE || !epochKeys.has(a.epoch.toBase58())) continue;
    const covered: Record<string, string> = {};
    if (a.nLegs > 0) {
      for (let i = 0; i < a.nLegs; i++) {
        const t = tickerStr(a.legTickers.slice(8 * i, 8 * i + 8));
        covered[t] = (BigInt(covered[t] ?? '0') + BigInt(a.legCovered[i].toString())).toString();
      }
    } else {
      covered[tickerStr(a.ticker)] = a.coveredValue.toString();
    }
    out.push({ debt: a.debt.toString(), cap: a.maxPayout.toString(), covered, stable: (a.stableCovered ?? new BN(0)).toString() });
  }
  return out;
}

/** SHA-256 over the venue's fills and funding, canonical JSON: the evidence hash the report carries. */
export function evidenceHash(fills: Fill[], funding: string): number[] {
  const sorted = [...fills].sort((x, y) => x.oid - y.oid || x.time - y.time);
  return [...createHash('sha256').update(JSON.stringify({ fills: sorted, funding })).digest()];
}

/** Decimal price string -> WAD (18 decimals) as a BigInt. */
export function wadOf(px: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(px.trim());
  if (!m) throw new Error(`not a price: ${px}`);
  return BigInt(m[1]) * 10n ** 18n + BigInt((m[2] ?? '').padEnd(18, '0').slice(0, 18));
}

// ----- the local record of what this keeper opened (venue time is real time; the chain's clock may be a fork's) -----
const statePath = () => process.env.HEDGE_STATE ?? `${ROOT}keeper/.hedge-state.json`;
type State = Record<string, { openedAtMs: number; entries: Record<string, string> }>;
const loadState = (): State => (existsSync(statePath()) ? JSON.parse(readFileSync(statePath(), 'utf8')) : {});
const saveState = (s: State) => writeFileSync(statePath(), JSON.stringify(s, null, 1));

export function makeVenue(): HedgeVenue {
  return new HyperliquidTestnet({ key: process.env.HEDGE_TESTNET_KEY ?? '', leverage: Number(process.env.HEDGE_LEVERAGE ?? 3) });
}

async function tryTx(r: Report, id: string, f: () => Promise<{ sig: string; cu: number } | void>) {
  try {
    const res = await f();
    r.sent.push(res ? `${id} (${res.cu} CU)` : id);
  } catch (e) {
    r.failed.push(`${id}: ${String((e as Error).message).split('\n')[0]}`);
  }
}

export async function hedgeJob(c: Chain, venue?: HedgeVenue): Promise<Report> {
  const r: Report = { sent: [], failed: [], waiting: [] };
  if (!hedgeEnabled() && !venue) return r;
  const cfgInfo = await c.conn.getAccountInfo(hedgeCfgPda());
  if (!cfgInfo) {
    r.waiting.push('no HedgeConfig (the admin has not enabled the hedge path)');
    return r;
  }
  const hedgeCfg = await c.program.account.hedgeConfig.fetch(hedgeCfgPda());
  const v = venue ?? makeVenue();
  const h = hedgeFraction();
  const now = await chainNow(c);
  const epochs = (await c.program.account.epoch.all()) as Row[];
  const groups = new Map<number, Row[]>();
  for (const e of epochs) {
    if (e.account.closureType !== CLOSURE.WEEKEND && e.account.closureType !== CLOSURE.HOLIDAY_WEEKEND) continue;
    groups.set(e.account.closureId, [...(groups.get(e.account.closureId) ?? []), e]);
  }
  const state = loadState();
  const cfgPaused = (await c.program.account.config.fetch(pdas.config())).paused as boolean;
  for (const [group, rows] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const id = String(group);
    const book = await c.program.account.hedgeBook.fetchNullable(hedgeBookPda(group));
    const open = Math.min(...rows.map((e) => n(e.account.open)));
    const tag = (s: string) => `${s} ${group}`;

    // ---- open ----
    if (!book) {
      const closed = rows.every((e) => e.account.state === EPOCH.CLOSED);
      if (!closed || now >= open || n(rows[0].account.bell) > now) continue;
      if (cfgPaused) {
        r.waiting.push(`${tag('open_hedge')}: the protocol is paused (no new hedges)`);
        continue;
      }
      await tryTx(r, tag('open_hedge'), async () => {
        const keys = new Set(rows.map((e) => e.publicKey.toBase58()));
        const pol = (await c.program.account.policy.all()) as Row[];
        const positions = positionsOf(pol, keys);
        if (positions.length === 0) throw new Error('no live policies to hedge');
        const vault = await c.program.account.vault.fetch(pdas.vault());
        const inv = (vault.inv as { cost: { toString(): string } }[]).reduce((a, s) => a + BigInt(s.cost.toString()), 0n);
        const equity = BigInt(vault.equity.toString()) - inv;
        const lev = BigInt(process.env.HEDGE_LEVERAGE ?? 3);
        const cap = (equity * BigInt(hedgeCfg.marginCapBps) * lev) / 10_000n; // notional the margin cap allows at this leverage
        const sized = helper({ h, capNotional: cap.toString(), positions }) as { notional: Record<string, string> };
        const listed = new Set(await v.listed(Object.keys(sized.notional).map((t) => INSTRUMENT[t]).filter(Boolean)));
        const orders = Object.entries(sized.notional)
          .filter(([t, x]) => INSTRUMENT[t] && listed.has(INSTRUMENT[t]) && BigInt(x) > 0n)
          .sort(([a], [b]) => Buffer.compare(Buffer.from(ticker8(a)), Buffer.from(ticker8(b))))
          .map(([t, x]) => ({ ticker: t, instrument: INSTRUMENT[t], notional: BigInt(x) }));
        if (orders.length === 0) throw new Error('nothing to hedge on this venue today');
        const fills = await v.openHedge(orders);
        const total = fills.reduce((a, f) => a + f.notional, 0n);
        const margin = (total + lev - 1n) / lev;
        state[id] = { openedAtMs: Date.now() - 60_000, entries: Object.fromEntries(fills.map((f) => [f.ticker, f.avgPx])) };
        saveState(state);
        const legs = fills.map((f) => ({ ticker: ticker8(f.ticker), notional: new BN(f.notional.toString()), entryWad: new BN(wadOf(f.avgPx).toString()) }));
        return send(c, [await c.program.methods.openHedge(group, new BN(margin.toString()), [...Buffer.from(v.address.replace(/^0x/, ''), 'hex')], legs)
          .accountsPartial({ keeper: c.payer.publicKey, hedgeConfig: hedgeCfgPda(), vault: pdas.vault(), loss: pdas.loss(group), hedge: hedgeBookPda(group) })
          .remainingAccounts(fills.map((f) => ({ pubkey: pdas.epoch(f.ticker, group), isWritable: false, isSigner: false })))
          .instruction()]);
      });
      continue;
    }

    // ---- report ----
    if (book.state === 0) {
      if (now < n(book.earliestReport) + 120) {
        r.waiting.push(`${tag('report_hedge')}: before the open`);
        continue;
      }
      await tryTx(r, tag('report_hedge'), async () => {
        const legs = (book.legs as { ticker: number[]; notional: { toString(): string }; entryWad: { toString(): string } }[]).slice(0, book.nLegs);
        const instruments = legs.map((l) => INSTRUMENT[tickerStr(l.ticker)]);
        const closed = await v.closeHedge(instruments);
        const since = state[id]?.openedAtMs ?? Date.now() - 4 * 86_400_000;
        const fills = await v.fills(since);
        const funding = await v.funding(since, instruments);
        const exits = instruments.map((ins) => {
          const f = closed.find((x) => x.instrument === ins);
          if (!f) throw new Error(`${ins}: no position to close (already closed? run again after the venue shows the fills)`);
          return wadOf(f.avgPx);
        });
        const bounds = helper({
          op: 'bounds', pnl: netPnl(fills, funding).toString(),
          legs: legs.map((l, i) => ({ notional: l.notional.toString(), entry: l.entryWad.toString(), exit: exits[i].toString() })),
        }) as { pnl: string };
        return send(c, [await c.program.methods.reportHedge(exits.map((x) => new BN(x.toString())), new BN(bounds.pnl), evidenceHash(fills, funding))
          .accountsPartial({ keeper: c.payer.publicKey, hedgeConfig: hedgeCfgPda(), hedge: hedgeBookPda(group) })
          .instruction()]);
      });
      continue;
    }

    // ---- finalize ----
    if (book.state === 1) {
      const due = n(book.reportedAt) + hedgeCfg.delaySecs;
      const epochRows = (book.legs as { ticker: number[] }[]).slice(0, book.nLegs).map((l) => rows.find((e) => tickerStr(e.account.ticker) === tickerStr(l.ticker)));
      if (now < due) {
        r.waiting.push(`${tag('finalize_hedge')}: challenge delay until ${due}`);
        continue;
      }
      if (epochRows.some((e) => !e || e.account.state !== EPOCH.SETTLED)) {
        r.waiting.push(`${tag('finalize_hedge')}: epochs not settled`);
        continue;
      }
      const loss = await c.program.account.lossVector.fetch(pdas.loss(group));
      if (loss.settled !== 1 && !(loss.policyCount === 0 && now > n(book.bell))) {
        r.waiting.push(`${tag('finalize_hedge')}: group not settled`);
        continue;
      }
      const keeperUsdc = ata(c.payer.publicKey, USDC_MINT);
      const bal = BigInt((await c.conn.getTokenAccountBalance(keeperUsdc).catch(() => ({ value: { amount: '0' } }))).value.amount);
      if (n(book.pnl) > 0 && bal < BigInt(n(book.pnl))) {
        r.waiting.push(`${tag('finalize_hedge')}: the keeper's USDC account holds ${bal}, the gain to bring is ${n(book.pnl)}`);
        continue;
      }
      await tryTx(r, tag('finalize_hedge'), async () =>
        send(c, [await c.program.methods.finalizeHedge()
          .accountsPartial({ keeper: c.payer.publicKey, hedgeConfig: hedgeCfgPda(), vault: pdas.vault(), vaultUsdc: pdas.vaultUsdc(), keeperUsdc, loss: pdas.loss(group), hedge: hedgeBookPda(group) })
          .remainingAccounts(epochRows.map((e) => ({ pubkey: e!.publicKey, isWritable: false, isSigner: false })))
          .instruction()]));
    }
  }
  return r;
}
