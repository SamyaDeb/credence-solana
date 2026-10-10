// c5_no_unsafe_claims and c5_stale_labelled on the rendered pages: the views are rendered to static markup against the
// committed snapshot (data/site/snapshot.json) and read as text.
import { readFileSync } from 'node:fs';
import { createElement as h, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MainnetView } from '@/components/site/MainnetView';
import { ProofView } from '@/components/site/ProofView';
import { AboutView, DisclosureView, RoadmapView } from '@/components/site/StaticViews';
import { UnlockView } from '@/components/site/UnlockView';
import { WeekendView } from '@/components/site/WeekendView';
import { Positioning } from '@/components/landing/Positioning';
import { hero, navLinks } from '@/components/landing/content';
import { findUnsafe } from '@/lib/site/claims';
import type { Snapshot } from '@/lib/site/snapshot';

vi.mock('server-only', () => ({}));
vi.mock('next/link', () => ({ default: (p: { href: string; children: unknown }) => h('a', { href: p.href }, p.children as never) }));
const snap = JSON.parse(readFileSync(new URL('../../data/site/snapshot.json', import.meta.url), 'utf8')) as Snapshot;
const html = (el: ReactElement) => renderToStaticMarkup(el);
const text = (el: ReactElement) => html(el).replace(/<[^>]+>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
const ms = (iso: string) => Date.parse(iso);

const asOfs = [snap.gap?.asOf, snap.scan?.asOf, snap.unlock?.asOf, snap.proof.asOf, snap.books?.asOf, snap.weekend?.asOf].filter(Boolean) as string[];
const freshNow = Math.max(...asOfs.map(ms)) + 60_000;
const staleNow = freshNow + 40 * 86400_000;

const PAGES: [string, (now: number) => ReactElement][] = [
  ['mainnet', (now) => h(MainnetView, { data: { gap: snap.gap, scan: snap.scan }, now })],
  ['unlock', (now) => h(UnlockView, { data: { unlock: snap.unlock }, now })],
  ['proof', (now) => h(ProofView, { data: { proof: snap.proof, books: snap.books }, now })],
  ['weekend', (now) => h(WeekendView, { data: { weekend: snap.weekend }, now })],
  ['about', () => h(AboutView)],
  ['roadmap', () => h(RoadmapView)],
  ['disclosure', () => h(DisclosureView)],
  ['landing positioning', () => h(Positioning)],
];
const page = (name: string) => PAGES.find((p) => p[0] === name)![1];

describe('c5_no_unsafe_claims: no page says insurance, live on mainnet, live feed or demand', () => {
  for (const [name, render] of PAGES) {
    it(name, () => {
      const t = text(render(freshNow));
      expect(findUnsafe(t), name).toEqual([]);
      // "live" never describes data: the only use is the disclosure "not live".
      expect(t.replace(/\S*\/\S*/g, '').replace(/not live/gi, ''), name).not.toMatch(/\blive\b/i); // file paths aside (data/live/…)
    });
  }
  it('the landing copy and the nav', () => {
    expect(findUnsafe(`${hero.title} ${hero.body} ${navLinks.map((l) => l.label).join(' ')}`)).toEqual([]);
  });
  it('the required disclosures are there', () => {
    const d = text(h(DisclosureView));
    expect(d).toMatch(/Not live, not insurance/);
    expect(d).toMatch(/Not for US persons/);
    expect(d).toMatch(/September 27, 2026/);
    expect(text(page('unlock')(freshNow))).toContain('What cover would allow, not measured demand.');
  });
});

describe('c5_stale_labelled: old data is stamped stale, current data is stamped with its time', () => {
  it('every data section shows its source and as-of time, fresh when current', () => {
    for (const [name, n] of [['mainnet', 2], ['unlock', 1], ['proof', 2], ['weekend', 1]] as const) {
      const m = html(page(name)(freshNow)).match(/data-testid="fresh" data-state="(fresh|stale)"/g) ?? [];
      expect(m.length, name).toBe(n);
      const t = text(page(name)(freshNow));
      expect(t.match(/as of \d{4}-\d\d-\d\d \d\d:\d\d UTC/g)?.length ?? 0, name).toBeGreaterThanOrEqual(n);
      expect(t.match(/Source:/g)?.length ?? 0, name).toBeGreaterThanOrEqual(n);
      expect(html(page(name)(freshNow)), name).not.toContain('data-state="stale"');
    }
  });
  it('past the bound the same sections say Stale and "Not current"', () => {
    for (const name of ['mainnet', 'unlock', 'proof', 'weekend']) {
      expect(html(page(name)(staleNow)), name).toContain('data-state="stale"');
      expect(text(page(name)(staleNow)), name).toMatch(/Stale: as of .* Not current\./);
    }
  });
  it('the Oracle numbers go stale within hours, not days', () => {
    const asOf = ms(snap.gap!.asOf);
    expect(html(h(MainnetView, { data: { gap: snap.gap, scan: null }, now: asOf + 3 * 3600_000 }))).toContain('data-state="stale"');
    expect(html(h(MainnetView, { data: { gap: snap.gap, scan: null }, now: asOf + 30 * 60_000 }))).not.toContain('data-state="stale"');
  });
  it('missing data shows an honest gap, never numbers', () => {
    const t = text(h(MainnetView, { data: { gap: null, scan: null }, now: freshNow }));
    expect(t).toMatch(/No Gap Oracle numbers in this build/);
    expect(t).not.toMatch(/\$\d|\d+\.\d+%/);
    expect(text(h(WeekendView, { data: { weekend: null }, now: freshNow }))).toMatch(/No shadow summary in this build/);
  });
});

describe('what each page owes the reader', () => {
  it('mainnet: eight assets, computed off-chain, frozen or moved, both lenders', () => {
    const t = text(page('mainnet')(freshNow));
    for (const a of ['SPYx', 'QQQx', 'NVDAx', 'TSLAx', 'GOOGLx', 'AAPLx', 'MSTRx', 'HOODx']) expect(t, a).toContain(a);
    expect(t).toMatch(/Computed off-chain from mainnet data/);
    expect(t).toMatch(/frozen since|moved \(last change/);
    expect(t).toContain('Kamino');
    expect(t).toContain('Jupiter Lend');
  });
  it('unlock: debt-weighted, size buckets, no medians', () => {
    const t = text(page('unlock')(freshNow));
    expect(t).toMatch(/debt-weighted/i);
    expect(t).not.toMatch(/\bmedian/i);
    expect(t).toMatch(/Extra credit at least/);
  });
  it('proof: the fork-proven sentence, the audit counts, and no build hash unless one was produced', () => {
    const t = text(page('proof')(freshNow));
    expect(t).toContain('Fork-proven against Kamino’s and Jupiter Lend’s real programs; nothing on mainnet; audit first.');
    expect(t).toMatch(new RegExp(`${snap.proof.audit.total} findings`));
    expect(t).not.toMatch(/build hash|verifiable build|sha256|TODO|placeholder/i);
    expect(t).toMatch(/Fork demo/);
  });
  it('weekend: running before the final, final after, always a read-only model on real data', () => {
    const running = text(h(WeekendView, { data: { weekend: { ...snap.weekend!, final: false, phase: 'weekend' } }, now: freshNow }));
    expect(running).toMatch(/Running: watching [\d,]+ positions/);
    expect(running).toMatch(/read-only model on real data/);
    const fin = text(h(WeekendView, { data: { weekend: { ...snap.weekend!, final: true, phase: 'final' } }, now: freshNow }));
    expect(fin).toMatch(/Final:/);
    expect(fin).not.toMatch(/Running:/);
    expect(fin).toMatch(/read-only model on real data/);
  });
  it('roadmap labels Phase D designed, not built', () => {
    expect(text(h(RoadmapView))).toMatch(/Designed, not built/);
  });
});
