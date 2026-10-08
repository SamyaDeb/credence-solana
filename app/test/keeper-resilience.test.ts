// Audit A-09: an RPC error outside a transaction (an account read, a getProgramAccounts) must not throw out of a keeper
// pass: the loop in keeper/src/index.ts would exit mid-weekend and miss the close or the settlement window. Every job
// fails on its own, the pass reports it, and the next pass retries.
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { tick } from '../../keeper/src/jobs';

const down = () => Promise.reject(new Error('fetch failed: ECONNRESET'));

function flakyChain() {
  const clock = Buffer.alloc(40);
  clock.writeBigInt64LE(1_791_576_030n, 32);
  const account = new Proxy({}, { get: () => ({ all: down, fetch: down }) });
  return {
    conn: { getAccountInfo: async () => ({ data: clock }) },
    payer: Keypair.generate(),
    provider: {},
    program: { account, methods: {} },
    url: 'http://127.0.0.1:8899',
  };
}

describe('keeper pass under RPC errors', () => {
  it('reports every job as failed instead of throwing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await tick(flakyChain() as any);
    expect(r.failed).toEqual(['openEpochs', 'closes', 'shields', 'settlements', 'settlePolicies', 'processQueues'].map((j) => `${j}: fetch failed: ECONNRESET`));
  });

  it('survives a failing clock read', async () => {
    const c = flakyChain();
    c.conn.getAccountInfo = down as never;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await tick(c as any);
    expect(r.failed).toEqual(['pass: fetch failed: ECONNRESET']);
  });
});
