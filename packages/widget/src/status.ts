// Follows a policy: the events its transactions emitted (CoverBought, ShieldAdvanced, PolicySettled), from logs via the SDK.
import type { Connection, PublicKey } from '@solana/web3.js';
import { type CredenceEvent, parseEvents } from '@credence/sdk';

export type PolicyEvent = CredenceEvent & { signature: string };
const WANTED = ['CoverBought', 'ShieldAdvanced', 'PolicySettled'];

export async function followPolicy(conn: Connection, policy: PublicKey, limit = 20): Promise<PolicyEvent[]> {
  const sigs = await conn.getSignaturesForAddress(policy, { limit }, 'confirmed');
  const out: PolicyEvent[] = [];
  for (const s of sigs.reverse()) {
    if (s.err) continue;
    const t = await conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
    for (const e of parseEvents(t?.meta?.logMessages ?? [])) if (WANTED.includes(e.name)) out.push({ ...e, signature: s.signature });
  }
  return out;
}
