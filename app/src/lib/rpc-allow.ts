// What the public read-only RPC proxy (api/rpc) lets through: read methods only, a getProgramAccounts only on klend or
// credence_core and only with filters, and simulations without signature checks. Everything else is refused.
import { KLEND, PROGRAM_ID } from './credence';

const READ = new Set([
  'getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getTokenAccountBalance', 'getTokenSupply', 'getSlot', 'getBlockHeight',
  'getLatestBlockhash', 'getEpochInfo', 'getHealth', 'getVersion', 'getMinimumBalanceForRentExemption', 'simulateTransaction', 'getProgramAccounts',
]);
export type Call = { jsonrpc: '2.0'; id: unknown; method: string; params?: unknown[] };

export function allowed(c: Call): string | null {
  if (!READ.has(c.method)) return `${c.method} is not allowed (read-only)`;
  if (c.method === 'getProgramAccounts') {
    const [prog, cfg] = (c.params ?? []) as [string, { filters?: unknown[] } | undefined];
    if (![KLEND.toBase58(), PROGRAM_ID.toBase58()].includes(prog)) return 'getProgramAccounts: only klend and credence_core';
    if (!cfg?.filters?.length) return 'getProgramAccounts needs filters';
  }
  if (c.method === 'simulateTransaction') {
    const [, cfg] = (c.params ?? []) as [unknown, { sigVerify?: boolean } | undefined];
    if (cfg?.sigVerify) return 'simulateTransaction: signatures are not verified here';
  }
  return null;
}

