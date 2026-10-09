// What the e2e test reads from the fork, over plain JSON-RPC (Playwright's loader cannot load web3.js/Anchor).
// The addresses are credence_core PDAs; test/keeper-parity.test.ts checks them against the app's derivation.
export const E2E_PDAS = {
  vault: 'Gy442GsvUPrCV3djirQizFPkDBcy441bkKXm7CKAyd8d',
  shares: 'Dn9gJBCKZjUnLrmt4NdBzL5qDYK3MtEPKDVwje7sPJ7s',
};

async function accounts(keys: string[]): Promise<Buffer[]> {
  const r = await fetch(process.env.RPC_URL ?? 'http://127.0.0.1:8899', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getMultipleAccounts', params: [keys, { encoding: 'base64', commitment: 'confirmed' }] }),
  });
  const j = (await r.json()) as { result: { value: { data: [string, string] }[] } };
  return j.result.value.map((a) => Buffer.from(a.data[0], 'base64'));
}

/** The Vault and share supply decoded by byte offset (Borsh layout from the IDL), independent of the app. */
export async function chainVault() {
  const [v, m] = await accounts([E2E_PDAS.vault, E2E_PDAS.shares]);
  const o = 8 + 32 * 4;
  const equity = v.readBigUInt64LE(o), reserved = v.readBigUInt64LE(o + 8), unearned = v.readBigUInt64LE(o + 16);
  const totalPremiums = v.readBigUInt64LE(o + 40), payouts = v.readBigUInt64LE(o + 48), liveGroups = v.readUInt32LE(o + 56);
  const supply = m.readBigUInt64LE(36);
  // After live [u32; 8] and four u8 bumps: inv [InvSlot; 4] of 40 bytes (ticker 8, cost, mark, value, marked_at), W2.
  // NAV = equity − Σ cost + Σ mark (credence-core Vault::nav); then yield_reserve 32, kusdc 32, lent_ctokens, lent_value.
  let cost = 0n, mark = 0n;
  for (let i = 0; i < 4; i++) { cost += v.readBigUInt64LE(o + 100 + 40 * i + 8); mark += v.readBigUInt64LE(o + 100 + 40 * i + 16); }
  const nav = equity - cost + mark;
  const lentValue = v.readBigUInt64LE(o + 260 + 72);
  return { equity, reserved, unearned, earned: totalPremiums - unearned, payouts, liveGroups, inventoryCost: cost, lentValue,
    nav6: supply > 0n ? (nav * 1_000_000n) / supply : 1_000_000n };
}
