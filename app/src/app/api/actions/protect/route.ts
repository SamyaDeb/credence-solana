// The Protect my position Action (Solana Actions spec v2.4): GET metadata with the live quote, POST an unsigned
// transaction for the local mainnet fork, OPTIONS for CORS. Everything is in lib/actions/protect.ts; the chain is the
// fork (lib/actions/fork-chain.ts). In the public read-only mode GET is disabled and POST refuses.
import { forkChain } from '@/lib/actions/fork-chain';
import { RateLimiter } from '@/lib/actions/guard';
import { type ProtectDeps, handleProtect } from '@/lib/actions/protect';
import { NETWORK } from '@/lib/network';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const deps: ProtectDeps = {
  chain: forkChain,
  // Per client: a burst of 20, then one request a second; all clients together: 60, then 5 a second. Without
  // TRUST_PROXY=1 every request counts as one local client (A-110).
  limiter: new RateLimiter({ burst: 20, perSecond: 1, globalBurst: 60, globalPerSecond: 5 }),
  timeoutMs: Number(process.env.ACTION_TIMEOUT_MS ?? 15_000),
  network: NETWORK,
  baseUrl: process.env.ACTION_BASE_URL,
};

export const GET = (req: Request) => handleProtect(req, deps);
export const POST = (req: Request) => handleProtect(req, deps);
export const OPTIONS = (req: Request) => handleProtect(req, deps);
