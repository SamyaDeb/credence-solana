// Solana Actions specification v2.4 (@solana/actions-spec 2.4.2; headers from @solana/actions 1.6.6): the response
// headers every Action route sends (GET, POST, OPTIONS and every error), the chain identifier, and the spec-shaped
// error body `{ message }`.
//
// The chain identifier (`X-Blockchain-Ids`, CAIP-2) must not claim mainnet: the transactions are built against the local
// mainnet fork and only make sense there. CAIP-2 lets a Solana chain reference be any 1–32 character [-_a-zA-Z0-9]
// string; `credence-local-fork` is not a public cluster's genesis hash, so a mainnet blink client (Phantom, dial.to)
// refuses the Action ("blockchain not supported") instead of sending a fork transaction to mainnet. The in-app Blink
// (/app/protect) declares that id as supported and sends to the fork.
import { BLOCKCHAIN_IDS, createActionHeaders } from '@solana/actions';
import { redact } from '@/lib/redact';

export const ACTION_VERSION = '2.4';
export const FORK_CHAIN_ID = 'solana:credence-local-fork';
export const PUBLIC_CLUSTERS: readonly string[] = Object.values(BLOCKCHAIN_IDS);

/** The wording every simulated or fork-only part carries. */
export const DISCLOSURE = 'Runs on a local mainnet fork; not live; not insurance.';

export function actionHeaders(extra: Record<string, string> = {}): Record<string, string> {
  if (PUBLIC_CLUSTERS.includes(FORK_CHAIN_ID)) throw new Error('the fork must not claim a public cluster');
  return { ...createActionHeaders({ chainId: FORK_CHAIN_ID, actionVersion: ACTION_VERSION }), 'Cache-Control': 'no-store', ...extra };
}

export const actionJson = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: actionHeaders(extra) });

/** Spec `ActionError`: `{ message }`, the message scrubbed of URLs, keys and anything after its first line. */
export const actionError = (message: string, status: number, extra: Record<string, string> = {}) =>
  actionJson({ message: scrub(message) }, status, extra);

export const preflight = () => new Response(null, { status: 204, headers: actionHeaders() });

/** No URL (not even a redacted provider domain), no key, no stack, no file path, at most 300 characters. */
export function scrub(s: string): string {
  const line = String(s).split('\n')[0].replace(/(https?|wss?):\/\/[^\s"'()<>]+/gi, '<rpc>');
  return redact(line).replace(/(?:\/[\w.@-]+){2,}/g, '<path>').slice(0, 300);
}
