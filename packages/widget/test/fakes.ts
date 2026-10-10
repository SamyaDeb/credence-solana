// A Connection stand-in for tests that must not need a fork: it answers the few calls the widget makes and counts them.
import { Keypair, PublicKey } from '@solana/web3.js';

export const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
export const FORK_GENESIS = '3dZ7mQ4n3tXz1Wl8nXz9m1Ay2oJ4VQe8C2uKqD7Hq9Zr';

export function fakeConn(over: { genesis?: string; accounts?: Record<string, { executable?: boolean; data?: Buffer } | null> } = {}) {
  const calls: string[] = [];
  const accounts = over.accounts ?? {};
  const conn = {
    rpcEndpoint: 'http://127.0.0.1:8899',
    calls,
    getGenesisHash: async () => { calls.push('getGenesisHash'); return over.genesis ?? FORK_GENESIS; },
    getAccountInfo: async (k: PublicKey) => {
      calls.push(`getAccountInfo:${k.toBase58()}`);
      const a = accounts[k.toBase58()];
      return a ? { executable: !!a.executable, data: a.data ?? Buffer.alloc(0), lamports: 1, owner: PublicKey.default } : null;
    },
    getLatestBlockhash: async () => { calls.push('getLatestBlockhash'); throw new Error('a test must not reach the chain'); },
    simulateTransaction: async () => { calls.push('simulateTransaction'); throw new Error('a test must not reach the chain'); },
    sendRawTransaction: async () => { calls.push('sendRawTransaction'); throw new Error('a test must not send'); },
  };
  return conn as unknown as import('@solana/web3.js').Connection & { calls: string[] };
}

/** A wallet that records every attempt to sign. */
export function spyWallet() {
  const key = Keypair.generate().publicKey;
  const signed: unknown[] = [];
  return { publicKey: key, signed, signTransaction: async (tx: unknown) => { signed.push(tx); return tx as never; } };
}
