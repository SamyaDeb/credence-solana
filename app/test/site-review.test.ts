// Regression tests for the C5 code review (audit A-172 to A-179), each failing before its fix.
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => { process.env.NEXT_PUBLIC_NETWORK = 'mainnet'; });
vi.mock('server-only', () => ({}));
import * as unlockRoute from '@/app/api/unlock/route';
import { Fresh } from '@/components/site/Fresh';
import { ProofView } from '@/components/site/ProofView';
import { WeekendView } from '@/components/site/WeekendView';
import { securityHeaders } from '../security-headers';
import { findUnsafe } from '@/lib/site/claims';
import type { Snapshot } from '@/lib/site/snapshot';

const snap = JSON.parse(readFileSync(new URL('../../data/site/snapshot.json', import.meta.url), 'utf8')) as Snapshot;
const text = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const NOW = Date.parse(snap.weekend!.asOf) + 60_000;
const LATER = NOW + 30 * 3600_000;

describe('A-172: the per-position unlock rows are not served by the public host', () => {
  it('?positions=1 is refused in public mode', async () => {
    const r = await unlockRoute.GET(new Request('http://site.test/api/unlock?positions=1', { headers: { 'x-forwarded-for': '192.0.2.1' } }));
    expect(r.status).toBe(403);
    expect((await unlockRoute.GET(new Request('http://site.test/api/unlock', { headers: { 'x-forwarded-for': '192.0.2.2' } }))).status).toBe(200);
  });
});

describe('A-173: a stale weekend page does not say it is running', () => {
  it('past the bound it says it is not current, and gives no running or final claim', () => {
    const t = text(h(WeekendView, { data: { weekend: { ...snap.weekend!, final: false } }, now: LATER }));
    expect(t).toMatch(/Stale/);
    expect(t).not.toMatch(/Running:/);
    expect(t).toMatch(/not current/i);
  });
  it('a final summary keeps its bound of days, a running one hours', () => {
    expect(text(h(WeekendView, { data: { weekend: { ...snap.weekend!, final: true, phase: 'done' } }, now: LATER }))).toMatch(/Final:/);
  });
});

describe('A-174: the snapshot is re-read when the file changes', () => {
  it('a rewritten file is served without a restart', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'root-'));
    mkdirSync(join(dir, 'data/site'), { recursive: true });
    const f = join(dir, 'data/site/snapshot.json');
    process.env.CREDENCE_ROOT = dir;
    vi.resetModules();
    const { loadSnapshot } = await import('@/lib/site/load');
    writeFileSync(f, JSON.stringify({ kind: 'credence.site.v1', n: 1 }));
    expect(((await loadSnapshot()) as unknown as { n: number }).n).toBe(1);
    writeFileSync(f, JSON.stringify({ kind: 'credence.site.v1', n: 2 }));
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(((await loadSnapshot()) as unknown as { n: number }).n).toBe(2);
    delete process.env.CREDENCE_ROOT;
  });
});

describe('the data host (DATA_HOST_URL)', () => {
  const setup = async (fetchImpl: () => Promise<Response>) => {
    const dir = mkdtempSync(join(tmpdir(), 'root-'));
    mkdirSync(join(dir, 'data/site'), { recursive: true });
    writeFileSync(join(dir, 'data/site/snapshot.json'), JSON.stringify({ kind: 'credence.site.v1', n: 'bundled' }));
    process.env.CREDENCE_ROOT = dir;
    process.env.DATA_HOST_URL = 'https://data.example';
    vi.stubGlobal('fetch', vi.fn(fetchImpl));
    vi.resetModules();
    return (await import('@/lib/site/load')).loadSnapshot;
  };
  const done = () => { delete process.env.CREDENCE_ROOT; delete process.env.DATA_HOST_URL; vi.unstubAllGlobals(); };

  it("serves the host's snapshot", async () => {
    const load = await setup(async () => new Response(JSON.stringify({ kind: 'credence.site.v1', n: 'host' })));
    expect(((await load()) as unknown as { n: string }).n).toBe('host');
    done();
  });
  it('falls back to the bundled file when the host is down', async () => {
    const load = await setup(async () => { throw new Error('down'); });
    expect(((await load()) as unknown as { n: string }).n).toBe('bundled');
    done();
  });
  it('ignores a document that is not a snapshot', async () => {
    const load = await setup(async () => new Response(JSON.stringify({ kind: 'other', n: 'host' })));
    expect(((await load()) as unknown as { n: string }).n).toBe('bundled');
    done();
  });
});

describe('A-175: the freshness line reads cleanly', () => {
  it('no doubled full stop, and "Stale" appears once as a label and once in the sentence at most', () => {
    const t = text(h(Fresh, { asOf: '2026-10-10T07:00:00Z', now: Date.parse('2026-10-10T12:00:00Z'), bound: 3600, source: 'data/x.json' }));
    expect(t).not.toMatch(/\.\./);
    expect(t.match(/Stale/g)?.length).toBe(1);
    expect(text(h(Fresh, { asOf: null, now: NOW, bound: 3600, source: 'x' }))).not.toMatch(/\.\./);
  });
});

describe('A-177: the proof page', () => {
  it('shows a note when the book demo is missing and prints the gap exactly', () => {
    expect(text(h(ProofView, { data: { proof: snap.proof, books: null }, now: NOW }))).toMatch(/No curator-book demo/);
    const t = text(h(ProofView, { data: { proof: snap.proof, books: { ...snap.books!, gap: -0.07 } }, now: NOW }));
    expect(t).toMatch(/−7% Monday/);
    expect(t).not.toMatch(/7\.0000/);
  });
});

describe('A-178: headers that could break wallets or sibling subdomains are not set', () => {
  it('no COOP, HSTS without includeSubDomains', () => {
    const h2 = securityHeaders(true);
    expect(h2.find((x) => x.key === 'Cross-Origin-Opener-Policy')).toBeUndefined();
    expect(h2.find((x) => x.key === 'Strict-Transport-Security')?.value).not.toMatch(/includeSubDomains/);
  });
});

describe('the devnet section on /proof (lib/site/devnet.ts)', () => {
  const d = {
    asOf: new Date(NOW - 5000).toISOString(), programId: 'BuyYBtw9U5tNwisNNiFgPfoc7eM44UbjCzbbv2toHAjR', deployedSlot: 510181244,
    authority: '71Wd3Sut366NSg71bYMNdSKsjRZ2pHDV6j6GyLFKt4eJ',
    config: { paused: false, admin: '71Wd3Sut366NSg71bYMNdSKsjRZ2pHDV6j6GyLFKt4eJ', guardian: '71Wd3Sut366NSg71bYMNdSKsjRZ2pHDV6j6GyLFKt4eJ',
      keeper: 'CbappoEGSRsXAqEMfwLYyV91zHdVDcGVUj9KyekP3soX', usdcMint: '4N53U7ntouX3gnYqRuAs1HY3a2BHSkaN7sfnUWoVCwfN' },
    assets: [{ ticker: 'SPYx', mint: '3HFdYBv2srD7Q6jBecCdHohqE2oh3kTtU7LfvcKbPby8', enabled: true }, { ticker: 'QQQx', mint: 'J9ZheQBjTGvdkmeEQe5v1XtSQ22ub8k1xNE9kW9i4iY9', enabled: true }],
    epochs: [{ ticker: 'SPYx', closureId: 20261023, state: 'open' }, { ticker: 'QQQx', closureId: 20261016, state: 'open' }, { ticker: 'SPYx', closureId: 20261016, state: 'closed' }],
    monitor: [{ level: 'ok' as const, what: 'not paused' }],
    keeper: { pubkey: 'CbappoEGSRsXAqEMfwLYyV91zHdVDcGVUj9KyekP3soX', sol: 0.905, lastTxAt: new Date(NOW - 120_000).toISOString(), txLastHour: 45 },
  };
  const proof = (devnet: unknown) => text(h(ProofView, { data: { proof: snap.proof, books: snap.books }, devnet: devnet as never, now: NOW }));

  it('shows the program, keeper, monitor and the nearest open weekend', () => {
    const t = proof(d);
    expect(t).toMatch(/Devnet deployment/);
    expect(t).toMatch(/510,181,244/);
    expect(t).toMatch(/Weekend 2026-10-16/);
    expect(t).toMatch(/2 of 2 assets have an epoch: 1 open, 1 closed/);
    expect(t).toMatch(/2 min ago/);
    expect(findUnsafe(t)).toEqual([]);
  });
  it('says so when devnet cannot be read, and is absent when not configured', () => {
    expect(proof({ error: 'the devnet read failed; try again shortly' })).toMatch(/Devnet could not be read just now/);
    expect(proof(null)).not.toMatch(/Devnet deployment/);
  });
});
