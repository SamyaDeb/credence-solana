// D3.2: the hedge keeper job's open step against a fake chain and a fake venue: it sizes with the Rust helper, hedges only what
// the venue lists, caps the notional by the program's margin cap, sorts the legs as the program requires, and sends
// `open_hedge` with the venue's account. Nothing is sent when the protocol is paused, the Friday close is not stored, or the
// hedge path is not enabled.
import { Keypair, PublicKey } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sent: unknown[] = [];
vi.mock('../../keeper/src/chain', async (orig) => ({ ...(await orig<typeof import('../../keeper/src/chain')>()), send: vi.fn(async (_c: unknown, ixs: unknown[]) => { sent.push(ixs); return { sig: 's', cu: 1 }; }) }));

import { hedgeJob } from '../../keeper/src/hedge/index';
import type { HedgeVenue } from '../../keeper/src/hedge/venue';
import { ticker8 } from '../../keeper/src/chain';

const NOW = 1_791_576_100; // just after Oct 9's bell/close
const BN = (x: number | string) => ({ toString: () => String(x), toNumber: () => Number(x) });
const tk = (t: string) => ticker8(t);
const epoch = (t: string, over: object = {}) => ({ publicKey: Keypair.generate().publicKey, account: { ticker: tk(t), closureId: 20261009, closureType: 2, state: 1, bell: BN(NOW - 100), close: BN(NOW - 100), open: BN(NOW + 200_000), ...over } });

function setup(o: { paused?: boolean; epochs?: ReturnType<typeof epoch>[]; hedgeCfg?: boolean; listed?: string[]; book?: object; now?: number; fills?: object[]; closeAt?: string; loss?: object } = {}) {
  const methodCalls: { name: string; args: unknown[] }[] = [];
  const epochs = o.epochs ?? [epoch('SPYx'), epoch('NVDAx'), epoch('QQQx')];
  const clock = Buffer.alloc(40);
  clock.writeBigInt64LE(BigInt(o.now ?? NOW), 32);
  const chain = {
    url: 'http://127.0.0.1:8899', payer: Keypair.generate(),
    conn: { getAccountInfo: async (k: PublicKey) => (k.toBase58() === 'SysvarC1ock11111111111111111111111111111111' ? { data: clock } : o.hedgeCfg === false ? null : { data: Buffer.alloc(40) }) },
    program: {
      account: {
        hedgeConfig: { fetch: async () => ({ marginCapBps: 300, pnlCapBps: 100, maxLeverage: 5, delaySecs: 3600, expirySecs: 1e6 }) },
        epoch: { all: async () => epochs },
        config: { fetch: async () => ({ paused: !!o.paused }) },
        hedgeBook: { fetchNullable: async () => o.book ?? null },
        lossVector: { fetch: async () => o.loss ?? { settled: 0, policyCount: 1 } },
        vault: { fetch: async () => ({ equity: BN(1_000_000_000), inv: [{ cost: BN(0) }] }) },
        policy: {
          all: async () => [
            { publicKey: Keypair.generate().publicKey, account: { state: 0, epoch: epochs[0].publicKey, nLegs: 0, ticker: tk('SPYx'), coveredValue: BN(26_000_000_000), debt: BN(25_000_000_000), maxPayout: BN(25_000_000_000), stableCovered: BN(0) } },
            { publicKey: Keypair.generate().publicKey, account: { state: 0, epoch: epochs[1].publicKey, nLegs: 0, ticker: tk('NVDAx'), coveredValue: BN(26_500_000_000), debt: BN(25_000_000_000), maxPayout: BN(25_000_000_000), stableCovered: BN(0) } },
          ],
        },
      },
      methods: new Proxy({}, { get: (_t, name: string) => (...args: unknown[]) => { methodCalls.push({ name, args }); const b: any = { accountsPartial: () => b, remainingAccounts: (r: unknown[]) => { methodCalls.push({ name: 'remaining', args: r }); return b; }, instruction: async () => ({ name }) }; return b; } }),
    },
  };
  const opened: { ticker: string; instrument: string; notional: bigint }[][] = [];
  const venue: HedgeVenue = {
    name: 'fake', address: '0x' + 'cd'.repeat(20),
    listed: async (xs) => xs.filter((x) => (o.listed ?? ['xyz:NVDA', 'xyz:XYZ100']).includes(x)),
    openHedge: async (legs) => { opened.push(legs); return legs.map((l) => ({ ticker: l.ticker, instrument: l.instrument, filledSz: '1', avgPx: '100', notional: l.notional })); },
    closeHedge: async (ins) => ins.map((instrument) => ({ instrument, filledSz: '1', avgPx: o.closeAt ?? '95' })), positions: async () => [], fills: async () => (o.fills ?? []) as never, funding: async () => '0',
  };
  return { chain, venue, methodCalls, opened };
}

beforeEach(() => { sent.length = 0; process.env.HEDGE_H = '0.5'; process.env.HEDGE_LEVERAGE = '3'; process.env.HEDGE_STATE = `/tmp/claude-501/hedge-state-${process.pid}.json`; });

describe('hedgeJob: open', () => {
  it('hedges only what the venue lists, sorted, capped by the margin cap, with the venue account on-chain', async () => {
    const s = setup();
    const r = await hedgeJob(s.chain as never, s.venue);
    expect(r.failed).toEqual([]);
    // SPYx (xyz:SP500) is not listed on this venue: dropped. NVDAx is hedged.
    expect(s.opened).toHaveLength(1);
    expect(s.opened[0].map((l) => l.ticker)).toEqual(['NVDAx']);
    // Equity 1,000 USDC x 3% x leverage 3 = 90 USDC of notional at most.
    expect(s.opened[0][0].notional).toBeLessThanOrEqual(90_000_000n);
    const open = s.methodCalls.find((c) => c.name === 'openHedge')!;
    expect(open.args[0]).toBe(20261009);
    expect(String(open.args[1])).toBe(String((s.opened[0][0].notional + 2n) / 3n)); // margin = ceil(notional / leverage)
    expect(Buffer.from(open.args[2] as number[]).toString('hex')).toBe('cd'.repeat(20));
    expect(sent).toHaveLength(1);
  });

  it('does nothing when paused, before the close is stored, or when the hedge path has no config', async () => {
    for (const s of [setup({ paused: true }), setup({ epochs: [epoch('SPYx', { state: 0 }), epoch('NVDAx', { state: 0 })] }), setup({ hedgeCfg: false })]) {
      const r = await hedgeJob(s.chain as never, s.venue);
      expect(s.opened).toHaveLength(0);
      expect(sent).toHaveLength(0);
      expect(r.sent).toEqual([]);
    }
  });

  it('is off without HEDGE=1 and a key', async () => {
    const s = setup();
    delete process.env.HEDGE;
    const r = await hedgeJob(s.chain as never);
    expect(r).toEqual({ sent: [], failed: [], waiting: [] });
  });

  it('reports instead of failing when nothing is listed', async () => {
    const s = setup({ listed: [] });
    const r = await hedgeJob(s.chain as never, s.venue);
    expect(r.failed[0]).toMatch(/nothing to hedge on this venue/);
    expect(sent).toHaveLength(0);
  });
});

const wad = (x: number) => BN((BigInt(x) * 10n ** 18n).toString());
const bookOf = (over: object = {}) => ({
  group: 20261009, state: 0, nLegs: 1, bell: BN(NOW - 100), earliestReport: BN(NOW + 200_000), reportedAt: BN(0), pnl: BN(0),
  legs: [{ ticker: tk('NVDAx'), notional: BN(30_000_000), entryWad: wad(100), exitWad: BN(0) }, ...Array(7).fill({ ticker: tk(''), notional: BN(0), entryWad: BN(0), exitWad: BN(0) })],
  ...over,
});

describe('hedgeJob: report and finalize', () => {
  const fill = (over: object) => ({ instrument: 'xyz:NVDA', side: 'buy', px: '95', sz: '0.3', time: 1, fee: '0.01', closedPnl: '1.6', oid: 2, hash: '0x', ...over });

  it('waits for the open, then closes, nets the fills and reports a P&L clamped to what the prices imply', async () => {
    const early = setup({ book: bookOf(), now: NOW });
    expect((await hedgeJob(early.chain as never, early.venue)).waiting.join()).toMatch(/before the open/);
    // Monday after the open: 30 USDC short 100 -> 95 implies +1.5 USDC; the venue's own record says +1.59 net (rounded fills): clamped to 1.5.
    const now = NOW + 200_200;
    const s = setup({ book: bookOf(), now, fills: [fill({ closedPnl: '1.6' })] });
    const r = await hedgeJob(s.chain as never, s.venue);
    expect(r.failed).toEqual([]);
    const rep = s.methodCalls.find((c) => c.name === 'reportHedge')!;
    expect((rep.args[0] as { toString(): string }[]).map(String)).toEqual([String(95n * 10n ** 18n)]);
    expect(String(rep.args[1])).toBe('1500000');
    expect((rep.args[2] as number[]).length).toBe(32);
  });

  it('a venue loss is reported as is (negative, never clamped up)', async () => {
    const s = setup({ book: bookOf(), now: NOW + 200_200, closeAt: '103', fills: [fill({ closedPnl: '-0.95', px: '103' })] });
    await hedgeJob(s.chain as never, s.venue);
    expect(String(s.methodCalls.find((c) => c.name === 'reportHedge')!.args[1])).toBe('-960000'); // -0.95 - 0.01 fee
  });

  it('finalizes only after the delay, with every epoch settled and the group settled', async () => {
    const reported = bookOf({ state: 1, reportedAt: BN(NOW + 200_100), pnl: BN(1_500_000) });
    const settled = (over: object = {}) => [epoch('NVDAx', { state: 2, ...over })];
    const t = (now: number, extra: object = {}) => setup({ book: reported, now, epochs: settled(), ...extra });
    let s = t(NOW + 200_100 + 100);
    expect((await hedgeJob(s.chain as never, s.venue)).waiting.join()).toMatch(/challenge delay/);
    s = setup({ book: reported, now: NOW + 200_100 + 4000, epochs: [epoch('NVDAx', { state: 1 })] });
    expect((await hedgeJob(s.chain as never, s.venue)).waiting.join()).toMatch(/epochs not settled/);
    s = t(NOW + 200_100 + 4000, { loss: { settled: 0, policyCount: 3 } });
    expect((await hedgeJob(s.chain as never, s.venue)).waiting.join()).toMatch(/group not settled/);
    expect(sent).toHaveLength(0);
  });
});
