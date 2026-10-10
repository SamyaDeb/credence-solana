// Public read-only mode attacks (C5): c5_no_writes, c5_rate_limit, and errors that carry no key, URL or stack.
// NEXT_PUBLIC_NETWORK is read when a module loads, so it is set before anything is imported.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const SECRET = 'SEKRET-KEY-0123456789';
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_NETWORK = 'mainnet';
  process.env.TRUST_PROXY = '1';
  process.env.MAINNET_RPC = 'http://127.0.0.1:9/?api-key=SEKRET-KEY-0123456789';
});

import * as foreign from '@/app/api/fork/fund/route';
import * as offline from '@/app/api/fork/offline/route';
import * as scopeFresh from '@/app/api/fork/scope-fresh/route';
import * as jlFresh from '@/app/api/fork/jl-fresh/route';
import * as takePosition from '@/app/api/fork/take-position/route';
import * as xstock from '@/app/api/fork/xstock/route';
import * as demoStep from '@/app/api/demo/step/route';
import * as kaminoBuild from '@/app/api/kamino/build/route';
import * as bookQuote from '@/app/api/book-quote/route';
import * as subscribe from '@/app/api/alerts/subscribe/route';
import * as unsubscribe from '@/app/api/alerts/unsubscribe/route';
import * as protect from '@/app/api/actions/protect/route';
import * as rpc from '@/app/api/rpc/route';
import * as unlockRoute from '@/app/api/unlock/route';

const WRITE_ROUTES: Record<string, { POST: (r: Request) => Promise<Response> | Response }> = {
  'fork/fund': foreign, 'fork/offline': offline, 'fork/scope-fresh': scopeFresh, 'fork/jl-fresh': jlFresh, 'fork/take-position': takePosition,
  'fork/xstock': xstock, 'demo/step': demoStep, 'kamino/build': kaminoBuild, 'book-quote': bookQuote, 'alerts/subscribe': subscribe,
  'alerts/unsubscribe': unsubscribe, 'actions/protect': protect,
};
const post = (path: string, body: unknown = {}, ip = '203.0.113.7') =>
  new Request(`http://site.test/api/${path}${path === 'actions/protect' ? '?position=11111111111111111111111111111112&lender=kamino' : ''}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });

describe('c5_no_writes: every POST and PUT in public mode is 403', () => {
  for (const [name, mod] of Object.entries(WRITE_ROUTES)) {
    it(`POST /api/${name}`, async () => {
      const r = await mod.POST(post(name, { account: '11111111111111111111111111111111', ids: ['x'] }));
      expect(r.status, name).toBe(403);
    });
  }
  it('no route exports PUT, PATCH or DELETE, and the only other POST is the read-only RPC proxy', () => {
    const root = join(process.cwd(), 'src/app');
    const files: string[] = [];
    const walk = (d: string) => readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(join(d, e.name)) : /route\.ts$/.test(e.name) && files.push(join(d, e.name))));
    walk(root);
    expect(files.length).toBeGreaterThan(20);
    const methods = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/export (?:async function|const) (GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)].map((m) => `${m[1]} ${f.slice(root.length)}`));
    expect(methods.filter((m) => /^(PUT|PATCH|DELETE)/.test(m))).toEqual([]);
    const posts = methods.filter((m) => m.startsWith('POST')).map((m) => m.slice(5).replace('/route.ts', '').replace(/^\/api\//, ''));
    expect(posts.sort()).toEqual([...Object.keys(WRITE_ROUTES), 'rpc'].sort());
  });
  it('the RPC proxy refuses every write method, whatever the body', async () => {
    for (const method of ['sendTransaction', 'requestAirdrop', 'simulateBundle', 'surfnet_setAccount', 'sendRawTransaction']) {
      const r = await rpc.POST(post('rpc', { jsonrpc: '2.0', id: 1, method, params: [] }));
      const j = await r.json();
      expect(JSON.stringify(j), method).toMatch(/not allowed|read-only/);
      expect(j.result, method).toBeUndefined();
    }
    const batch = await rpc.POST(post('rpc', [{ jsonrpc: '2.0', id: 1, method: 'getSlot' }, { jsonrpc: '2.0', id: 2, method: 'sendTransaction', params: [] }]));
    expect(JSON.stringify(await batch.json())).toMatch(/not allowed/);
  });
});

describe('errors carry no key, URL or stack', () => {
  it('an upstream failure on the RPC proxy is a plain message', async () => {
    const r = await rpc.POST(post('rpc', { jsonrpc: '2.0', id: 1, method: 'getSlot' }));
    const text = await r.text();
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(text).not.toContain(SECRET);
    expect(text).not.toMatch(/https?:\/\//);
    expect(text).not.toMatch(/\n\s+at |node_modules|\.ts:\d+/);
  });
});

describe('c5_rate_limit: the public read routes throttle a burst, per client', () => {
  const get = (ip: string) => unlockRoute.GET(new Request('http://site.test/api/unlock', { headers: { 'x-forwarded-for': ip } }));
  beforeEach(() => vi.useRealTimers());
  it('the same client is throttled with Retry-After; another client is not', async () => {
    const codes: number[] = [];
    let retry: string | null = null;
    for (let i = 0; i < 200; i++) { const r = await get('198.51.100.9'); codes.push(r.status); if (r.status === 429) retry = r.headers.get('retry-after'); }
    expect(codes).toContain(429);
    expect(codes[0]).not.toBe(429);
    expect(Number(retry)).toBeGreaterThan(0);
    expect((await get('198.51.100.10')).status).not.toBe(429);
  });
  it('the RPC proxy throttles too', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 200; i++) codes.push((await rpc.POST(post('rpc', { jsonrpc: '2.0', id: i, method: 'getSlot' }, '198.51.100.20'))).status);
    expect(codes).toContain(429);
  });
});
