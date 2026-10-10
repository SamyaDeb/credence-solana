// The in-app Blink's adapter: only the fork's chain id, and a transaction is re-checked before the app's signer signs
// it (a compromised or buggy Action response cannot get a foreign program or another signer past the burner).
import { Connection, Keypair, Transaction, TransactionInstruction } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { JL_VAULTS, assembleTx, encodeTx } from '@/lib/actions/build';
import { forkBlinkAdapter, lenderOf } from '@/lib/actions/blink-adapter';
import { FORK_CHAIN_ID } from '@/lib/actions/spec';
import type { AppSigner } from '@/lib/tx';
import { fixture } from './fixtures/action-chain';

const burner = (kp: Keypair): AppSigner => ({ publicKey: kp.publicKey, kind: 'burner', signTransaction: async (tx: Transaction) => { tx.partialSign(kp); return tx; } });
const ctx = (lender: string) => ({ originalUrl: `http://localhost:3000/api/actions/protect?position=x&lender=${lender}` }) as never;

describe('fork Blink adapter', () => {
  it('declares only the fork chain id', () => {
    expect(forkBlinkAdapter(new Connection('http://127.0.0.1:1'), null).metadata.supportedBlockchainIds).toEqual([FORK_CHAIN_ID]);
  });
  it('signs and sends a well-formed Action transaction to the fork', async () => {
    const f = fixture();
    const kp = Keypair.generate();
    const { transaction } = await f.chain.build(f.kamino, kp.publicKey, 1_000_000n, 9_000_000n);
    const conn = { sendRawTransaction: vi.fn(async (raw: Buffer) => { const t = Transaction.from(raw); expect(t.verifySignatures()).toBe(true); return 'sig1'; }) } as unknown as Connection;
    const r = await forkBlinkAdapter(conn, burner(kp)).signTransaction(transaction, ctx('kamino'));
    expect(r).toEqual({ signature: 'sig1' });
  });
  it('refuses to sign a transaction with a foreign program, the wrong lender, or another fee payer', async () => {
    const f = fixture();
    const kp = Keypair.generate();
    const send = vi.fn();
    const a = forkBlinkAdapter({ sendRawTransaction: send } as unknown as Connection, burner(kp));
    const { transaction } = await f.chain.build(f.kamino, kp.publicKey, 1_000_000n, 9_000_000n);
    expect(await a.signTransaction(transaction, ctx('jupiter'))).toMatchObject({ error: expect.stringMatching(/refused to sign/) });
    const other = (await f.chain.build(f.kamino, Keypair.generate().publicKey, 1n, 2n)).transaction;
    expect(await a.signTransaction(other, ctx('kamino'))).toMatchObject({ error: expect.stringMatching(/signer/) });
    const drain = encodeTx(assembleTx(kp.publicKey, Keypair.generate().publicKey.toBase58(), [new TransactionInstruction({ programId: JL_VAULTS, keys: [], data: Buffer.alloc(8) })], 1));
    expect(await a.signTransaction(drain, ctx('kamino'))).toMatchObject({ error: expect.stringMatching(/refused/) });
    expect(send).not.toHaveBeenCalled();
  });
  it('without a wallet, asks to connect', async () => {
    expect(await forkBlinkAdapter(new Connection('http://127.0.0.1:1'), null).signTransaction('', ctx('kamino'))).toMatchObject({ error: expect.stringMatching(/Connect/) });
  });
  it('lenderOf prefers the linked action\'s href', () => {
    expect(lenderOf({ originalUrl: 'http://x/a?lender=kamino', triggeredLinkedAction: { href: '/api/actions/protect?lender=jupiter' } })).toBe('jupiter');
    expect(lenderOf({ originalUrl: 'http://x/a?lender=aave' })).toBeNull();
  });
});

describe('A-112: the in-app Blink never goes through Dialect\'s proxy', () => {
  it('an Action on any host (LAN address, tunnel) is fetched directly, wallet and position stay between the browser and this app', async () => {
    await import('@/lib/actions/blink-adapter');
    const { proxify } = await import('@dialectlabs/blinks');
    for (const u of ['http://192.168.1.10:3000/api/actions/protect?position=x&lender=kamino', 'https://credence.example/api/actions/protect?position=x&lender=kamino']) {
      const r = proxify(u);
      expect(r.url.toString()).toBe(u);
      expect(r.headers).toEqual({});
    }
  });
});
