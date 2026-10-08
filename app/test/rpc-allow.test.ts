// The public site's RPC proxy forwards only reads to the server's MAINNET_RPC: no sends, no unfiltered program dumps.
import { describe, expect, it } from 'vitest';
import { KLEND, PROGRAM_ID } from '@/lib/credence';
import { allowed } from '@/lib/rpc-allow';

const call = (method: string, params: unknown[] = []) => ({ jsonrpc: '2.0' as const, id: 1, method, params });

describe('rpc proxy allowlist', () => {
  it('passes reads', () => {
    for (const m of ['getAccountInfo', 'getMultipleAccounts', 'getSlot', 'getLatestBlockhash', 'getTokenAccountBalance']) expect(allowed(call(m))).toBeNull();
    expect(allowed(call('simulateTransaction', ['tx', { sigVerify: false }]))).toBeNull();
  });
  it('refuses writes and anything unknown', () => {
    for (const m of ['sendTransaction', 'requestAirdrop', 'surfnet_setAccount', 'getSignaturesForAddress']) expect(allowed(call(m))).toMatch(/not allowed/);
  });
  it('getProgramAccounts only on klend or credence_core, with filters', () => {
    expect(allowed(call('getProgramAccounts', [KLEND.toBase58(), { filters: [{ memcmp: { offset: 64, bytes: 'x' } }] }]))).toBeNull();
    expect(allowed(call('getProgramAccounts', [PROGRAM_ID.toBase58(), { filters: [{ dataSize: 8 }] }]))).toBeNull();
    expect(allowed(call('getProgramAccounts', [KLEND.toBase58(), {}]))).toMatch(/needs filters/);
    expect(allowed(call('getProgramAccounts', ['TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', { filters: [{ dataSize: 165 }] }]))).toMatch(/only klend/);
  });
});
