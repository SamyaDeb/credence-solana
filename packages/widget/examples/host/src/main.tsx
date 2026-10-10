// A minimal host: it owns the connection and the wallet. Here the wallet is a demo burner (a fork-only keypair the page
// receives in the URL fragment); a real host passes its wallet-adapter's publicKey and signTransaction instead.
import { Buffer } from 'buffer';
(globalThis as { Buffer?: typeof Buffer }).Buffer ??= Buffer;
import { Connection, Keypair, type VersionedTransaction } from '@solana/web3.js';
import { type ForkUpkeep, CredenceProtect, type WalletLike } from '@credence/widget';
import '@credence/widget/style.css';
import { createRoot } from 'react-dom/client';

const q = new URLSearchParams(location.search);
const rpc = q.get('rpc') ?? import.meta.env.VITE_RPC_URL ?? 'http://127.0.0.1:8899';
const connection = new Connection(rpc, 'confirmed');

// The burner secret (64 bytes, JSON) arrives in the fragment so it never reaches a server log.
function burner(): Keypair | null {
  try {
    const raw = new URLSearchParams(location.hash.slice(1)).get('burner');
    return raw ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw) as number[])) : null;
  } catch { return null; }
}
const kp = burner();
const wallet: WalletLike | null = kp
  ? { publicKey: kp.publicKey, signTransaction: async (tx: VersionedTransaction) => { tx.sign([kp]); return tx; } }
  : null;

const post = async (path: string, body: unknown) => {
  const r = await fetch(`/fork/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`fork upkeep failed (${path})`);
};
const upkeep: ForkUpkeep = {
  scopeFresh: (pairs) => post('scope-fresh', { pairs }),
  offline: (keys) => post('offline', { keys }),
};

createRoot(document.getElementById('root')!).render(
  <main style={{ maxWidth: 640, margin: '2rem auto', padding: '0 16px', fontFamily: 'system-ui' }}>
    <h1 style={{ fontSize: '1.2rem' }}>Sample host</h1>
    <p>{kp ? <>Demo burner <code data-testid="host-wallet">{kp.publicKey.toBase58()}</code> (fork only).</> : 'No wallet connected (add #burner=[…] to the URL).'}</p>
    <CredenceProtect connection={connection} wallet={wallet} position={q.get('position')} lender={q.get('lender') ?? 'kamino'} upkeep={upkeep} />
  </main>,
);
