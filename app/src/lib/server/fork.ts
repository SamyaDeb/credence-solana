// Server-only helpers for the route handlers: surfpool cheatcodes on the local fork (never a real cluster) and reads of
// the repo's data/ files. RPC_URL is a server variable; MAINNET_RPC and keys never reach this module or the client.
import 'server-only';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The repo root: the app runs from app/ (`pnpm dev`, `pnpm start`, Playwright). */
export const ROOT = process.env.CREDENCE_ROOT ?? resolve(process.cwd(), '..');
export const FORK_RPC = process.env.RPC_URL ?? process.env.NEXT_PUBLIC_RPC_URL ?? 'http://127.0.0.1:8899';

/** Cheatcodes only run against a local fork. */
export function assertLocalFork() {
  const u = new URL(FORK_RPC);
  if (!['127.0.0.1', 'localhost', '0.0.0.0'].includes(u.hostname)) throw new Error('fork cheatcodes only run against a local surfpool fork');
}

export async function rpc<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
  const r = await fetch(FORK_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    cache: 'no-store',
  });
  const j = (await r.json()) as { result?: T; error?: { message: string } };
  if (j.error) throw new Error(`${method}: ${j.error.message}`);
  return j.result as T;
}

export async function setAccount(key: string, a: { lamports: number; data: Buffer; owner: string; executable?: boolean }) {
  assertLocalFork();
  await rpc('surfnet_setAccount', [key, { lamports: a.lamports, data: a.data.toString('hex'), owner: a.owner, executable: a.executable ?? false }]);
}

export async function setTokenBalance(owner: string, mint: string, amount: bigint, tokenProgram?: string) {
  assertLocalFork();
  await rpc('surfnet_setTokenAccount', tokenProgram ? [owner, mint, { amount: Number(amount) }, tokenProgram] : [owner, mint, { amount: Number(amount) }]);
}

export async function getAccount(key: string): Promise<{ lamports: number; data: Buffer; owner: string } | null> {
  const r = await rpc<{ value: { lamports: number; data: [string, string]; owner: string } | null }>('getAccountInfo', [key, { encoding: 'base64', commitment: 'confirmed' }]);
  if (!r.value) return null;
  return { lamports: r.value.lamports, data: Buffer.from(r.value.data[0], 'base64'), owner: r.value.owner };
}

export function readJson<T = unknown>(rel: string): T {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as T;
}

export function latest(dir: string, re: RegExp): string | null {
  const f = readdirSync(join(ROOT, dir)).filter((x) => re.test(x)).sort().pop();
  return f ? join(dir, f) : null;
}

export const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const redact = (s: string) => s.replace(/(api[-_]?key|apikey|token|key)=[^&\s"')]+/gi, '$1=***');
export const fail = (e: unknown, status = 500) => json({ error: redact((e as Error).message ?? String(e)) }, status);
