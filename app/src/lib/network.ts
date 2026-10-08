// Which chain the app talks to. `fork` (default): the local surfpool fork, read and written from the browser, with the
// fork tools. `mainnet`: the public read-only site; the browser reads mainnet through the server's /api/rpc proxy (the
// provider key stays on the server) and nothing is signed or sent.
export const NETWORK = (process.env.NEXT_PUBLIC_NETWORK === 'mainnet' ? 'mainnet' : 'fork') as 'fork' | 'mainnet';
export const IS_MAINNET = NETWORK === 'mainnet';

/** The RPC endpoint the browser's Connection uses. */
export function clientRpcUrl(): string {
  if (IS_MAINNET) return typeof window === 'undefined' ? 'http://127.0.0.1/api/rpc' : `${window.location.origin}/api/rpc`;
  return process.env.NEXT_PUBLIC_RPC_URL ?? 'http://127.0.0.1:8899';
}

/** The local surfpool fork (fork-only upkeep such as restamping Kamino's Scope prices applies). */
export const ON_LOCAL_FORK = !IS_MAINNET && /127\.0\.0\.1|localhost/.test(process.env.NEXT_PUBLIC_RPC_URL ?? 'http://127.0.0.1:8899');

export const READ_ONLY_NOTE = 'This is the public read-only view of mainnet: nothing is signed or sent here. Gap cover, the vault and the demo weekend run on the local mainnet fork (scripts/demo-app.sh).';
