// What the e2e test reads from the fork, over plain JSON-RPC (Playwright's loader cannot load web3.js/Anchor).
// The addresses are credence_core PDAs; test/keeper-parity.test.ts checks them against the app's derivation.
export const E2E_PDAS = {
  vault: 'Gy442GsvUPrCV3djirQizFPkDBcy441bkKXm7CKAyd8d',
  shares: 'Dn9gJBCKZjUnLrmt4NdBzL5qDYK3MtEPKDVwje7sPJ7s',
  /** GapFeed of SPYx: seeds ["feed", ticker8]. */
  feedSPYx: 'EUszAWeSJMfa9NYESxztJ2zMBdz41o91zj69kbG9e4kB',
  /** HedgeConfig (D3): seeds ["hedgecfg"]. */
  hedgeConfig: 'BZMybw9mwetqAKgibP8FV4oDwhgjkLQmSncz4y3tgkoa',
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

/** A GapFeed's `last_update_slot` and `updates` (zero-copy layout: 8 discriminator, ticker 8, then six i64, then two u64). */
export async function chainFeed(key: string) {
  const [d] = await accounts([key]);
  const slot = await (await fetch(process.env.RPC_URL ?? 'http://127.0.0.1:8899', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot', params: [{ commitment: 'confirmed' }] }) })).json() as { result: number };
  return { lastUpdateSlot: Number(d.readBigUInt64LE(64)), updates: Number(d.readBigUInt64LE(72)), slot: slot.result };
}

/** The HedgeConfig (D3) by byte offset (8 discriminator; margin_cap_bps u16, pnl_cap_bps u16, max_leverage u8, delay_secs u32, expiry_secs u32), or null when none exists. */
export async function chainHedgeConfig() {
  const key = E2E_PDAS.hedgeConfig;
  const r = await (await fetch(process.env.RPC_URL ?? 'http://127.0.0.1:8899', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAccountInfo', params: [key, { encoding: 'base64', commitment: 'confirmed' }] }) })).json() as { result: { value: { data: [string, string] } | null } };
  if (!r.result.value) return null;
  const d = Buffer.from(r.result.value.data[0], 'base64');
  return { marginCapBps: d.readUInt16LE(8), pnlCapBps: d.readUInt16LE(10), maxLeverage: d.readUInt8(12), delaySecs: d.readUInt32LE(13) };
}
