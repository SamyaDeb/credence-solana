// The widget's attack tests (C4b). Each names the attack and fails without the guard it checks.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen, cleanup } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { IDL_HASH } from '@credence/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { CredenceProtect, InputError, ProgramMismatchError, SingleCopyError, UnsupportedClusterError, assertSupportedCluster, loadPosition, parseLender, toPublicKey } from '../src';
import { MAINNET_GENESIS, fakeConn, spyWallet } from './fakes';

afterEach(cleanup);
const POSITION = '11111111111111111111111111111112';
const SRC = join(process.cwd(), 'src');
const srcFiles = () => readdirSync(SRC).filter((f) => /\.(ts|tsx)$/.test(f));
const src = (f: string) => readFileSync(join(SRC, f), 'utf8');

describe('c4b_refuses_mainnet: nothing is built when the connection is mainnet', () => {
  it('assertSupportedCluster throws before any program or position read', async () => {
    const conn = fakeConn({ genesis: MAINNET_GENESIS });
    await expect(assertSupportedCluster(conn)).rejects.toBeInstanceOf(UnsupportedClusterError);
    await expect(assertSupportedCluster(conn)).rejects.toThrow(/mainnet.*not deployed|fork/i);
    expect(conn.calls.filter((c) => c.startsWith('getAccountInfo'))).toEqual([]);
  });
  it('a surfpool fork reports mainnet’s genesis hash: it is let through, a plain mainnet node (or one that will not say) is not', async () => {
    await expect(assertSupportedCluster(fakeConn({ genesis: MAINNET_GENESIS, surfnet: true }))).resolves.toBeUndefined();
    await expect(assertSupportedCluster(fakeConn({ genesis: MAINNET_GENESIS, versionFails: true }))).rejects.toBeInstanceOf(UnsupportedClusterError);
    await expect(assertSupportedCluster(fakeConn({ genesis: MAINNET_GENESIS }))).rejects.toBeInstanceOf(UnsupportedClusterError);
  });
  it('loadPosition on mainnet reads no account and builds nothing', async () => {
    const conn = fakeConn({ genesis: MAINNET_GENESIS });
    await expect(loadPosition(conn, { position: POSITION, lender: 'kamino' })).rejects.toBeInstanceOf(UnsupportedClusterError);
    expect(conn.calls.filter((c) => c.startsWith('getAccountInfo'))).toEqual([]);
  });
  it('the component says "fork" and offers no buy', async () => {
    const w = spyWallet();
    render(<CredenceProtect connection={fakeConn({ genesis: MAINNET_GENESIS })} wallet={w} position={POSITION} lender="kamino" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/mainnet/i);
    expect(screen.queryByRole('button', { name: /buy/i })).toBeNull();
    expect(w.signed).toEqual([]);
  });
});

describe('c4b_program_mismatch: a program or IDL that is not this widget’s is refused with a clear message', () => {
  it('no executable program at the id', async () => {
    const conn = fakeConn({ accounts: {} });
    await expect(loadPosition(conn, { position: POSITION, lender: 'kamino' })).rejects.toBeInstanceOf(ProgramMismatchError);
    await expect(loadPosition(conn, { position: POSITION, lender: 'kamino' })).rejects.toThrow(/no executable program/);
  });
  it('the component shows the reason and nothing to buy', async () => {
    render(<CredenceProtect connection={fakeConn({ accounts: {} })} wallet={spyWallet()} position={POSITION} lender="kamino" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/no executable program/);
    expect(screen.queryByRole('button', { name: /buy/i })).toBeNull();
    expect(IDL_HASH).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('c4b_single_copy: a host with a second copy of web3.js fails loudly', () => {
  // What a host without the aliases hands us: a key from another copy of the class (same shape, not our class).
  class ForeignPublicKey { constructor(private s: string) {} toBase58() { return this.s; } toBytes() { return new PublicKey(this.s).toBytes(); } }
  it('toPublicKey names the cause instead of failing later inside the SDK', () => {
    const foreign = new ForeignPublicKey(POSITION) as unknown;
    expect(() => toPublicKey(foreign, 'position')).toThrow(SingleCopyError);
    expect(() => toPublicKey(foreign, 'position')).toThrow(/two copies of @solana\/web3\.js/);
  });
  it('the component renders the same message, not a blank widget', async () => {
    render(<CredenceProtect connection={fakeConn()} wallet={spyWallet()} position={new ForeignPublicKey(POSITION) as never} lender="kamino" />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/two copies of @solana\/web3\.js/);
  });
  it('a key of our class and a base58 string are both fine', () => {
    expect(toPublicKey(new PublicKey(POSITION), 'p').toBase58()).toBe(POSITION);
    expect(toPublicKey(POSITION, 'p').toBase58()).toBe(POSITION);
  });
});

describe('c4b_escapes_input: position and lender are validated, nothing is rendered unescaped', () => {
  const evil = '<img src=x onerror="window.__pwn=1"><script>window.__pwn=1</script>';
  it('rejects non-base58 positions and unknown lenders', () => {
    for (const bad of [evil, '', 'abc', 'x'.repeat(200), '0OIl', 'z'.repeat(44), null, undefined, 5, {}]) expect(() => toPublicKey(bad, 'position'), String(bad)).toThrow(InputError);
    for (const bad of ['Kamino', 'drift', '', evil, null, 1]) expect(() => parseLender(bad)).toThrow(InputError);
    expect(parseLender('jupiter')).toBe('jupiter');
  });
  it('a hostile position never reaches the DOM as markup, and no script runs', async () => {
    const { container } = render(<CredenceProtect connection={fakeConn()} wallet={spyWallet()} position={evil as never} lender={evil as never} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(container.querySelector('img, script')).toBeNull();
    expect(container.innerHTML).not.toContain('<img');
    expect((window as unknown as { __pwn?: number }).__pwn).toBeUndefined();
  });
  it('the source never sets innerHTML or uses dangerouslySetInnerHTML', () => {
    for (const f of srcFiles()) expect(src(f), f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
  });
});

describe('c4b_never_signs: no path signs or sends without the wallet’s explicit call', () => {
  it('signTransaction is called in exactly one place, and only from purchase()', () => {
    const hits = srcFiles().flatMap((f) => (src(f).match(/\.signTransaction\b/g) ?? []).map(() => f));
    expect(hits).toEqual(['purchase.ts']);
    expect(srcFiles().flatMap((f) => (src(f).match(/sendRawTransaction|sendTransaction|signAllTransactions|signMessage|Keypair|secretKey/g) ?? []).map(() => f))).toEqual(['purchase.ts']);
  });
  it('loading and rendering never sign, even with a wallet connected', async () => {
    const w = spyWallet();
    render(<CredenceProtect connection={fakeConn()} wallet={w} position={POSITION} lender="kamino" />);
    await screen.findByRole('alert'); // the fake chain refuses; the point is that nothing was signed on the way
    expect(w.signed).toEqual([]);
  });
});

describe('c4b_no_js_math: the widget computes no risk or price of its own', () => {
  it('only riskView is used from the SDK’s risk rules; no pricing functions are imported', () => {
    for (const f of srcFiles()) expect(src(f), f).not.toMatch(/\b(realizedPayout|payoutAtGap|modelPays|gapped)\b/);
    expect(srcFiles().filter((f) => /\briskView\b/.test(src(f)))).toEqual(['load.ts']);
  });
  it('no Math.* on money in the source', () => {
    for (const f of srcFiles()) expect(src(f), f).not.toMatch(/\bMath\.(pow|exp|log|sqrt|min|max)\b/);
  });
});
