// quotes, buy builders and epoch/policy views: @credence/sdk (packages/sdk). Re-exported so the app's imports are unchanged.
export * from '@credence/sdk';

export type Freshened = { now: number; pairs: { price: number; twap: number | null; value: number; twapAligned: boolean }[] };

/** FORK ONLY (the app\'s own route, not part of the SDK): moves the Scope chains\' refresh time to the fork clock so klend accepts the prices. */
export async function freshenScope(pairs: { price: number; twap: number | null }[]): Promise<Freshened> {
  const r = await fetch('/api/fork/scope-fresh', { method: 'POST', body: JSON.stringify({ pairs }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j as Freshened;
}

