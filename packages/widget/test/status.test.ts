// @vitest-environment node
// A-165: a poll fetches only the transactions it has not seen; confirmed transactions never change.
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { followPolicy, type EventCache } from '../src/status';

describe('followPolicy', () => {
  it('fetches each transaction once across polls, in parallel, and skips failed ones', async () => {
    let txCalls = 0;
    const conn = {
      getSignaturesForAddress: async () => [{ signature: 'c', err: null }, { signature: 'b', err: { x: 1 } }, { signature: 'a', err: null }],
      getTransaction: async () => { txCalls++; return { meta: { logMessages: [] } }; },
    } as never;
    const cache: EventCache = new Map();
    await followPolicy(conn, PublicKey.default, 20, cache);
    expect(txCalls).toBe(2);
    await followPolicy(conn, PublicKey.default, 20, cache);
    expect(txCalls).toBe(2);
  });
});
