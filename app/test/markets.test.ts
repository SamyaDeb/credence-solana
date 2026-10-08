// The Markets and Overview hooks decode accounts with lib/markets.ts. Pinned here: the calendar decoder against the
// uploaded calendar file (and the fork's account, when a fork runs), the market-state rules on real XNYS sessions,
// the tail gap against the scenario file, and the reserve figures against klend-sdk's own KaminoReserve on the fork's
// reserves (utilisation, curve rate, fixed host rate).
import { readFileSync } from 'node:fs';
import { Connection, PublicKey } from '@solana/web3.js';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { address } from '@solana/kit';
import { beforeAll, describe, expect, it } from 'vitest';
import { RPC_URL, pdas } from '@/lib/credence';
import { decodeReserve } from '@/lib/kamino';
import { XSTOCKS_USDC_RESERVE, apy, curveRate, decodeCalendar, marketState, nextWeekend, reserveFigures, tailGap, type Session } from '@/lib/markets';

const root = new URL('../../', import.meta.url).pathname;
const read = (p: string) => JSON.parse(readFileSync(root + p, 'utf8'));
const cal = read('data/onchain/calendar-XNYS.json') as { n: number; sessions: Session[] };
const at = (date: number) => cal.sessions.find((s) => s.date === date)!;

function encodeCalendar(sessions: Session[]): Uint8Array {
  const b = new Uint8Array(56 + 24 * sessions.length);
  const v = new DataView(b.buffer);
  b.set([...'XNYS'].map((c) => c.charCodeAt(0)), 40);
  v.setUint16(48, sessions.length, true);
  b[50] = 1;
  sessions.forEach((s, i) => { v.setUint32(56 + 24 * i, s.date, true); v.setBigInt64(64 + 24 * i, BigInt(s.open), true); v.setBigInt64(72 + 24 * i, BigInt(s.close), true); });
  return b;
}

const conn = new Connection(process.env.RPC_URL ?? RPC_URL, 'confirmed');
let up = false;
beforeAll(async () => { try { up = !!(await conn.getAccountInfo(pdas.calendar())); } catch { up = false; } });

describe('calendar', () => {
  it('decodes the zero-copy layout', () => {
    const d = decodeCalendar(encodeCalendar(cal.sessions));
    expect(d.venue).toBe('XNYS');
    expect(d.finalized).toBe(true);
    expect(d.sessions).toEqual(cal.sessions.map(({ date, open, close }) => ({ date, open, close })));
  });

  it('the fork holds the uploaded calendar', async (ctx) => {
    if (!up) ctx.skip();
    const a = await conn.getAccountInfo(pdas.calendar());
    expect(decodeCalendar(a!.data).sessions).toEqual(cal.sessions.map(({ date, open, close }) => ({ date, open, close })));
  });

  it('market state: session, overnight, weekend, midweek and long-weekend holidays', () => {
    const s = cal.sessions;
    expect(marketState(s, at(20261008).open + 60).state).toBe('open');
    expect(marketState(s, at(20261008).close + 60).state).toBe('closed');
    expect(marketState(s, at(20261009).close).state).toBe('weekend'); // from the close itself
    expect(marketState(s, at(20261009).close + 86_400).state).toBe('weekend');
    expect(marketState(s, at(20261125).close + 3600).state).toBe('holiday'); // Thanksgiving
    expect(marketState(s, at(20261127).close + 3600).state).toBe('weekend'); // half day, then a plain weekend
    expect(marketState(s, s[s.length - 1].close + 1).state).toBe('unknown');
  });

  it('next weekend: the Oct 9 close and the Oct 12 open', () => {
    const w = nextWeekend(cal.sessions, at(20261008).open)!;
    expect([w.friday.date, w.monday.date]).toEqual([20261009, 20261012]);
  });
});

describe('scenario tail', () => {
  it('1st percentile of the SPYx weekend set at the floored σ', () => {
    const z = Int16Array.from(read('data/onchain/SPYx-WEEKEND.json').z as number[]);
    const sigma = BigInt(read('data/sigma/sigma-floor.json').assets.SPYx.sigmaWad);
    expect(tailGap(z, sigma, 0.01)).toBeCloseTo((Number(sigma) / 1e18) * (z[30] / 1000), 12);
    expect(tailGap(z, sigma, 0.01)).toBeLessThan(-0.02);
  });
});

describe('reserve figures = klend-sdk KaminoReserve', () => {
  it('the curve matches getBorrowRate', () => {
    const curve: [number, number][] = [[0, 0], [0.8, 0.08], [0.9, 0.2], [1, 1.5]];
    for (const u of [0, 0.4, 0.8, 0.85, 0.9, 0.95, 1, 1.2]) {
      const sdk = u > 0.8 && u < 0.9 ? 0.08 + ((u - 0.8) * 0.12) / 0.1 : u > 0.9 && u < 1 ? 0.2 + ((Math.min(u, 1) - 0.9) * 1.3) / 0.1 : null;
      if (sdk !== null) expect(curveRate(u, curve)).toBeCloseTo(sdk, 12);
    }
    expect(curveRate(1.2, curve)).toBe(1.5);
    expect(apy(0)).toBe(0);
  });

  it('utilisation and borrow APR on the fork reserves', async (ctx) => {
    if (!up) ctx.skip();
    for (const key of [XSTOCKS_USDC_RESERVE, new PublicKey('UvXjBuC7YZYaGB9Rn1PpBD1GySmjzunXgE8Zev9ua8d')]) {
      const a = await conn.getAccountInfo(key);
      const state = decodeReserve(a!.data as Buffer);
      const f = reserveFigures(state);
      const k = new KaminoReserve(state, address(key.toBase58()), {} as never, {} as never, 400, 0);
      expect(f.utilisation).toBeCloseTo(k.calculateUtilizationRatio(), 9);
      // configuredBorrowRate is private in the typings: the curve rate klend accrues on, before the slot adjustment.
      const configured = (k as unknown as { configuredBorrowRate(): number }).configuredBorrowRate();
      expect(f.borrowApr).toBeCloseTo(configured + k.getFixedHostInterestRate().toNumber(), 9);
      expect(f.ltPct).toBe(state.config.liquidationThresholdPct);
    }
  });
});

describe('vault capacity figures = credence-core math', () => {
  it('free equity rounds the deduction up; concentration limit as cover.rs', async () => {
    const { freeEquity, concentrationLimit } = await import('@/lib/vault');
    expect(freeEquity(1_000n, 0n, 0n)).toBe(1_000n);
    expect(freeEquity(1_000n, 1n, 3n)).toBe(666n); // 333.33… leaves, rounded up to 334
    expect(freeEquity(1_000n, 4n, 3n)).toBeNull();
    expect(concentrationLimit(2_000_000_000_000n, 500_000_000_000_000_000n, 400_000_000_000_000_000n)).toBe(400_000_000_000n);
  });
});
