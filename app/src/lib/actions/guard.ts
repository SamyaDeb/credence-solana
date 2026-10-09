// Abuse protection shared by the public routes (the Action and the alert subscriptions): input validation, a bounded
// body reader, a per-IP + global token-bucket rate limit, and a timeout for anything that waits on the fork.
import { PublicKey } from '@solana/web3.js';

export class InputError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** A base58 32-byte public key, round-trip exact (no leading zeros or other encodings of the same key). */
export function parsePubkey(v: unknown, name: string): PublicKey {
  if (typeof v !== 'string' || !BASE58.test(v)) throw new InputError(`${name}: a base58 public key`);
  let k: PublicKey;
  try { k = new PublicKey(v); } catch { throw new InputError(`${name}: a base58 public key`); }
  if (k.toBase58() !== v) throw new InputError(`${name}: a base58 public key`);
  return k;
}

export function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string): T {
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new InputError(`${name}: one of ${allowed.join(', ')}`);
  return v as T;
}

/** A query parameter given at most once (a repeated parameter is refused, not silently resolved). */
export function param(url: URL, name: string): string | null {
  const all = url.searchParams.getAll(name);
  if (all.length > 1) throw new InputError(`${name}: given more than once`);
  return all[0] ?? null;
}

export const MAX_URL = 512;

export function checkUrl(req: Request): URL {
  if (req.url.length > MAX_URL) throw new InputError('request URL too long', 414);
  return new URL(req.url);
}

/** Reads a JSON body of at most `max` bytes (declared length checked first, then the bytes actually streamed). */
export async function readJson(req: Request, max: number): Promise<unknown> {
  const type = req.headers.get('content-type');
  if (type && !/^application\/json\b/i.test(type)) throw new InputError('content-type: application/json', 415);
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (declared > max) throw new InputError(`body larger than ${max} bytes`, 413);
  const chunks: Uint8Array[] = [];
  let n = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.byteLength;
      if (n > max) { await reader.cancel().catch(() => {}); throw new InputError(`body larger than ${max} bytes`, 413); }
      chunks.push(value);
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(text); } catch { throw new InputError('body: JSON'); }
}

/** Token bucket per key plus one global bucket; keys are evicted oldest-first beyond `maxKeys`. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private global: { tokens: number; at: number };
  constructor(readonly opts: { burst: number; perSecond: number; globalBurst: number; globalPerSecond: number; maxKeys?: number }) {
    this.global = { tokens: opts.globalBurst, at: 0 };
  }
  private refill(b: { tokens: number; at: number }, now: number, burst: number, rate: number) {
    if (b.at) b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * rate);
    b.at = now;
  }
  /** null when allowed, else the seconds to wait. */
  take(key: string, now = Date.now()): number | null {
    const o = this.opts;
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: o.burst, at: now };
      if (this.buckets.size >= (o.maxKeys ?? 10_000)) this.buckets.delete(this.buckets.keys().next().value as string);
    } else this.buckets.delete(key);
    this.buckets.set(key, b); // most recent last
    this.refill(b, now, o.burst, o.perSecond);
    this.refill(this.global, now, o.globalBurst, o.globalPerSecond);
    if (b.tokens < 1) return Math.ceil((1 - b.tokens) / o.perSecond);
    if (this.global.tokens < 1) return Math.ceil((1 - this.global.tokens) / o.globalPerSecond);
    b.tokens -= 1;
    this.global.tokens -= 1;
    return null;
  }
}

/** The client address for rate limiting. Only behind a proxy that overwrites X-Forwarded-For (TRUST_PROXY=1, e.g.
 * Vercel) is its first hop the client's address. Otherwise the header is whatever the client sent (Next does not append
 * the peer address), so every request shares one bucket: the app listens on 127.0.0.1, its clients are local (A-110). */
export function clientIp(req: Request): string {
  if (process.env.TRUST_PROXY !== '1') return 'direct';
  const first = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]?.trim();
  return (first || req.headers.get('x-real-ip') || 'unknown').slice(0, 64);
}

export class TimeoutError extends Error {}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { t = setTimeout(() => reject(new TimeoutError(`${what} did not answer within ${ms} ms`)), ms); }),
  ]).finally(() => clearTimeout(t));
}

/** A fetch for web3.js `Connection` that aborts every RPC request after `ms`. */
export const timeoutFetch = (ms: number): typeof fetch => (input, init) =>
  fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms) });
