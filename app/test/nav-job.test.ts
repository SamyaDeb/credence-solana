// D4: the keeper's NAV job. Which strikes are ahead of a schedule, and what the job sends: it opens the next closures (the group first when
// missing), reports instead of opening while the guardian has gated the asset or the protocol is paused, and halts a closure whose
// settlement window passed empty. Nothing is sent without a registered schedule.
import { Keypair } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: unknown[] = [];
vi.mock('../../keeper/src/chain', async (orig) => ({ ...(await orig<typeof import('../../keeper/src/chain')>()), send: vi.fn(async (_c: unknown, ixs: unknown[]) => { sent.push(ixs); return { sig: 's', cu: 1 }; }) }));

import { navJob, nextStrikes, yyyymmdd } from '../../keeper/src/nav';
import { ticker8, CLOSURE, EPOCH } from '../../keeper/src/chain';

const DAY = 86_400;
const OCT1 = Date.UTC(2026, 9, 1) / 1000;
const BN = (x: number | string) => ({ toString: () => String(x), toNumber: () => Number(x) });

describe('nextStrikes', () => {
  it('lists the strikes whose bell is still ahead, by UTC date', () => {
    const now = Date.UTC(2026, 9, 10, 20, 34) / 1000;
    expect(nextStrikes(OCT1, DAY, now, 2).map((s) => s.id)).toEqual([20261011, 20261012]);
    // 15 minutes before a strike its bell has passed: the next one is the first ahead.
    const justBefore = Date.UTC(2026, 9, 10, 23, 50) / 1000;
    expect(nextStrikes(OCT1, DAY, justBefore, 1).map((s) => s.id)).toEqual([20261012]);
    const beforeBell = Date.UTC(2026, 9, 10, 23, 40) / 1000;
    expect(nextStrikes(OCT1, DAY, beforeBell, 1).map((s) => s.id)).toEqual([20261011]);
    // Two-day schedule: every other date. Before the anchor: the first strike.
    expect(nextStrikes(OCT1, 2 * DAY, now, 3).map((s) => s.id)).toEqual([20261011, 20261013, 20261015]);
    expect(nextStrikes(OCT1, DAY, OCT1 - 10 * DAY, 1)[0].id).toBe(20261001);
    // Not a whole number of days: nothing.
    expect(nextStrikes(OCT1, 3600, now, 2)).toEqual([]);
    expect(yyyymmdd(OCT1)).toBe(20261001);
  });
});

function setup(o: { now: number; gated?: boolean; paused?: boolean; epochs?: object[]; existing?: Set<string>; schedules?: object[] }) {
  const calls: { name: string; args: unknown[] }[] = [];
  const clock = Buffer.alloc(40);
  clock.writeBigInt64LE(BigInt(o.now), 32);
  const key = Keypair.generate().publicKey;
  const sched = { publicKey: key, account: { ticker: ticker8('ONyc'), anchorTs: BN(OCT1), intervalSecs: DAY, gated: o.gated ? 1 : 0 } };
  const chain = {
    url: 'http://127.0.0.1:8899', payer: Keypair.generate(),
    conn: { getAccountInfo: async (k: { toBase58(): string }) => (k.toBase58() === 'SysvarC1ock11111111111111111111111111111111' ? { data: clock } : (o.existing ?? new Set()).has(k.toBase58()) ? { data: Buffer.alloc(8) } : null) },
    program: {
      account: {
        navSchedule: { all: async () => o.schedules ?? [sched] },
        config: { fetch: async () => ({ paused: !!o.paused }) },
        assetConfig: { fetchNullable: async () => ({ enabled: 1 }) },
        epoch: { all: async () => o.epochs ?? [] },
      },
      methods: new Proxy({}, { get: (_t, name: string) => (...args: unknown[]) => { calls.push({ name, args }); const b: any = { accountsPartial: () => b, instruction: async () => ({ name }) }; return b; } }), // eslint-disable-line @typescript-eslint/no-explicit-any
    },
  };
  return { chain, calls, sched };
}

beforeEach(() => { sent.length = 0; });

describe('navJob', () => {
  const now = Date.UTC(2026, 9, 10, 20, 34) / 1000;

  it('opens the group and the closure for each strike ahead', async () => {
    const s = setup({ now });
    const r = await navJob(s.chain as never);
    expect(r.failed).toEqual([]);
    expect(s.calls.map((c) => c.name)).toEqual(['openGroup', 'openNavEpoch', 'openGroup', 'openNavEpoch']);
    expect(s.calls.filter((c) => c.name === 'openNavEpoch').map((c) => c.args[1])).toEqual([20261011, 20261012]);
  });

  it('skips what exists, opens only the group that is missing', async () => {
    const { PublicKey } = await import('@solana/web3.js');
    const { pdas } = await import('../../keeper/src/chain');
    const existing = new Set([pdas.epoch('ONyc', 20261011).toBase58(), pdas.loss(20261012).toBase58()]);
    const s = setup({ now, existing });
    await navJob(s.chain as never);
    expect(s.calls.map((c) => c.name)).toEqual(['openNavEpoch']);
    expect(s.calls[0].args[1]).toBe(20261012);
    expect(PublicKey).toBeDefined();
  });

  it('reports, sends nothing, while gated or paused', async () => {
    for (const o of [{ gated: true }, { paused: true }]) {
      const s = setup({ now, ...o });
      const r = await navJob(s.chain as never);
      expect(sent).toHaveLength(0);
      expect(s.calls).toHaveLength(0);
      expect(r.waiting.join()).toMatch(/redemption gate|paused/);
    }
  });

  it('halts a closure whose settlement window passed empty, and only then', async () => {
    const close = Date.UTC(2026, 9, 11) / 1000;
    const ep = (state: number) => ({ publicKey: Keypair.generate().publicKey, account: { ticker: ticker8('ONyc'), closureId: 20261011, closureType: CLOSURE.NAV_STRIKE, state, closeSource: 2, open: BN(close + DAY) } });
    const past = close + DAY + 60 + 300 + 1;
    let s = setup({ now: past, epochs: [ep(EPOCH.CLOSED)], existing: new Set() });
    await navJob(s.chain as never);
    expect(s.calls.map((c) => c.name)).toContain('haltNavEpoch');
    s = setup({ now: close + DAY + 200, epochs: [ep(EPOCH.CLOSED)] });
    await navJob(s.chain as never);
    expect(s.calls.map((c) => c.name)).not.toContain('haltNavEpoch'); // still inside the window
    s = setup({ now: past, epochs: [ep(EPOCH.SETTLED)] });
    await navJob(s.chain as never);
    expect(s.calls.map((c) => c.name)).not.toContain('haltNavEpoch');
  });

  it('does nothing without a schedule', async () => {
    const s = setup({ now, schedules: [] });
    expect(await navJob(s.chain as never)).toEqual({ sent: [], failed: [], waiting: [] });
    expect(s.calls).toHaveLength(0);
  });
});
