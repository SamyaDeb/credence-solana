// Follows a policy: the events its transactions emitted (CoverBought, ShieldAdvanced, PolicySettled), from logs via the SDK.
// A confirmed transaction never changes, so its events are cached by signature: a poll fetches only signatures it has not seen.
import type { Connection, PublicKey } from '@solana/web3.js';
import { type CredenceEvent, parseEvents } from '@credence/sdk';

export type PolicyEvent = CredenceEvent & { signature: string };
const WANTED = ['CoverBought', 'ShieldAdvanced', 'PolicySettled'];

/** A cache the caller keeps per policy (signature → its events), so repeated polls cost one `getSignaturesForAddress`. */
export type EventCache = Map<string, PolicyEvent[]>;

export async function followPolicy(conn: Connection, policy: PublicKey, limit = 20, cache: EventCache = new Map()): Promise<PolicyEvent[]> {
  const sigs = (await conn.getSignaturesForAddress(policy, { limit }, 'confirmed')).filter((s) => !s.err).reverse();
  await Promise.all(sigs.filter((s) => !cache.has(s.signature)).map(async (s) => {
    const t = await conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    if (!t) return; // not indexed yet: tried again on the next poll
    cache.set(s.signature, parseEvents(t.meta?.logMessages ?? []).filter((e) => WANTED.includes(e.name)).map((e) => ({ ...e, signature: s.signature })));
  }));
  return sigs.flatMap((s) => cache.get(s.signature) ?? []);
}
