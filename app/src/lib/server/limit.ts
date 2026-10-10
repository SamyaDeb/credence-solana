// Public-mode throttle for the read routes (rpc proxy, scan, oracle, unlock, data): a token bucket per client and one for
// everybody, per route group. Off in the fork mode (a local demo and its Playwright suite are the only clients). Behind a
// proxy that overwrites X-Forwarded-For (TRUST_PROXY=1, e.g. Vercel) the client is its first hop; otherwise all requests share
// one bucket (lib/actions/guard.ts clientIp).
import { RateLimiter, clientIp } from '@/lib/actions/guard';
import { IS_MAINNET } from '@/lib/network';

const groups = new Map<string, RateLimiter>();
const CONFIG = { burst: 40, perSecond: 5, globalBurst: 400, globalPerSecond: 60 };

/** A 429 with Retry-After when this client has used up its share of `group`, else null. */
export function throttle(req: Request, group: string, cfg: Partial<typeof CONFIG> = {}): Response | null {
  if (!IS_MAINNET) return null;
  let l = groups.get(group);
  if (!l) groups.set(group, (l = new RateLimiter({ ...CONFIG, ...cfg })));
  const wait = l.take(clientIp(req));
  if (wait === null) return null;
  return new Response(JSON.stringify({ error: 'too many requests: slow down' }), {
    status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(wait), 'cache-control': 'no-store' },
  });
}

/** A small TTL cache for read responses (bounded in entries and in bytes per entry). */
export class TtlCache<T> {
  private m = new Map<string, { at: number; v: T }>();
  constructor(private ttlMs: number, private max = 500) {}
  get(k: string, now = Date.now()): T | undefined {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (now - e.at > this.ttlMs) { this.m.delete(k); return undefined; }
    return e.v;
  }
  set(k: string, v: T, now = Date.now()) {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
    this.m.set(k, { at: now, v });
  }
}
