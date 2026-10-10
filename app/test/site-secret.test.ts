// c5_no_secret_in_bundle: the grep itself must catch a planted secret (else a green run means nothing), and on a built .next it must find none.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const run = (dir: string, env: Record<string, string>) => spawnSync('node', ['scripts/secret-grep.mjs', dir], { env: { ...process.env, ...env }, encoding: 'utf8' });

describe('c5_no_secret_in_bundle', () => {
  it('the grep finds a planted key, by name, without printing it', () => {
    const d = mkdtempSync(join(tmpdir(), 'bundle-'));
    writeFileSync(join(d, 'chunk.js'), 'fetch("https://rpc.example/?api-key=PLANTED-SECRET-VALUE-123")');
    const r = run(d, { MAINNET_RPC: 'https://rpc.example/?api-key=PLANTED-SECRET-VALUE-123' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('HIT MAINNET_RPC');
    expect(r.stdout + r.stderr).not.toContain('PLANTED-SECRET-VALUE-123');
  });
  it('a clean directory passes', () => {
    const d = mkdtempSync(join(tmpdir(), 'bundle-'));
    writeFileSync(join(d, 'chunk.js'), 'console.log(1)');
    expect(run(d, { MAINNET_RPC: 'https://rpc.example/?api-key=PLANTED-SECRET-VALUE-123' }).status).toBe(0);
  });
  it.skipIf(!existsSync('.next/BUILD_ID'))('the built .next holds none of the real values', () => {
    expect(() => execFileSync('node', ['scripts/secret-grep.mjs', '.next'], { encoding: 'utf8' })).not.toThrow();
  });
});
