// Audit A-30: the keeper's shields job mirrors the program's fair-value checks (Full verification, feed, age, not
// before the close, confidence) so a pass never sends an advance the program would refuse; one push read per asset.
import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { shields } from '../../keeper/src/jobs';

const FEED = Buffer.alloc(32, 7);
const CLOSE = 1_791_576_000;
const OPEN = 1_791_811_800;
const NOW = OPEN - 48_600 + 600; // inside the window
const big = (x: number | bigint) => ({ toString: () => String(x), toNumber: () => Number(x) });

function push({ full = true, feed = FEED, price = 650e8, conf = 0.1e8, publish = NOW - 60 } = {}) {
  const d = Buffer.alloc(134);
  d[40] = full ? 1 : 0;
  const o = full ? 41 : 42;
  feed.copy(d, o);
  d.writeBigInt64LE(BigInt(price), o + 32);
  d.writeBigUInt64LE(BigInt(conf), o + 40);
  d.writeInt32LE(-8, o + 48);
  d.writeBigInt64LE(BigInt(publish), o + 52);
  return d;
}

function chain(update: Buffer) {
  const clock = Buffer.alloc(40);
  clock.writeBigInt64LE(BigInt(NOW), 32);
  const reads: string[] = [];
  const ticker = [...Buffer.from('SPYx\0\0\0\0')];
  const epoch = new PublicKey(Keypair.generate().publicKey);
  const policy = (i: number) => ({
    publicKey: Keypair.generate().publicKey,
    account: { state: 0, epoch, ticker, debt: big(50_000e6), coveredValue: big(52_083e6), maxPayout: big(50_000e6), advanced: big(0),
      obligation: Keypair.generate().publicKey, borrowReserve: Keypair.generate().publicKey, i },
  });
  const sendTransaction = vi.fn();
  const c = {
    conn: {
      getAccountInfo: async (k: PublicKey) => {
        reads.push(k.toBase58());
        return k.toBase58() === 'SysvarC1ock11111111111111111111111111111111' ? { data: clock } : { data: update };
      },
      sendTransaction,
    },
    payer: Keypair.generate(),
    url: 'http://127.0.0.1:8899',
    program: {
      account: {
        config: { fetch: async () => ({ shieldAlphaWad: big(5e17), shieldBufferWad: big(2e16), shieldHealthWad: big(0), shieldMaxAgeSecs: 36 * 3600,
          shieldStartBeforeOpenSecs: 48_600, shieldDeadlineBeforeOpenSecs: 9_000, maxConfBps: 50 }) },
        assetConfig: { all: async () => [{ publicKey: Keypair.generate().publicKey, account: { ticker, feedXstock: [...FEED] } }] },
        epoch: { all: async () => [{ publicKey: epoch, account: { state: 1, closureId: 20261009, open: big(OPEN), close: big(CLOSE), closePriceWad: big(717n * 10n ** 18n) } }] },
        policy: { all: async () => [policy(0), policy(1), policy(2)] },
      },
      methods: {},
    },
  };
  return { c, reads, sendTransaction };
}

describe('keeper shields job (A-30)', () => {
  for (const [name, upd] of [
    ['partially verified', push({ full: false })],
    ['another feed', push({ feed: Buffer.alloc(32, 9) })],
    ['confidence wider than max_conf_bps', push({ conf: 650e8 * 0.006 })],
    ['published before the close', push({ publish: CLOSE - 2 * 3600 })],
    ['older than the max age', push({ publish: NOW - 37 * 3600 })],
  ] as const) {
    it(`waits, sends nothing: ${name}`, async () => {
      const { c, reads, sendTransaction } = chain(upd);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const r = await shields(c as any);
      expect(sendTransaction).not.toHaveBeenCalled();
      expect(r.failed).toEqual([]);
      expect(r.waiting).toHaveLength(3);
      expect(r.waiting[0]).toMatch(/no usable fair value/);
      // one push read for the three policies of the asset (plus the clock)
      expect(reads.filter((k) => k !== 'SysvarC1ock11111111111111111111111111111111')).toHaveLength(1);
    });
  }
});

describe('keeper shields job (A-40)', () => {
  // The program skips top-ups under 1 USDC (MIN_TOPUP) once a policy has an advance; a keeper that sent whenever its
  // float estimate beat `advanced` by one base unit sent a no-op transaction for every advanced policy, every pass.
  it('does not send a top-up below 1 USDC', async () => {
    const { c, sendTransaction } = chain(push());
    const close = 717, fair = 650;
    const est = 50_000e6 - 52_083e6 * (fair / close) * 0.98; // the job's estimate for these inputs
    const pols = await c.program.account.policy.all();
    for (const p of pols) Object.assign(p.account, { advanced: big(Math.floor(est - 0.5e6)), worstLoss: big(1e12) });
    c.program.account.policy.all = async () => pols;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await shields(c as any);
    expect(r.failed).toEqual([]);
    expect(sendTransaction).not.toHaveBeenCalled();
  });
});
