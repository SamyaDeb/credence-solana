// c5_stale_labelled and c5_no_unsafe_claims, the pure halves: the rule that decides "fresh" vs "stale", and the phrase check.
import { describe, expect, it } from 'vitest';
import { BOUNDS, ageLabel, freshness } from '@/lib/site/fresh';
import { findUnsafe } from '@/lib/site/claims';

const NOW = Date.parse('2026-10-10T12:00:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

describe('c5_stale_labelled: data older than its bound is stale, never live', () => {
  it('fresh within the bound, stale beyond it, and the bound is the section’s own', () => {
    expect(freshness(ago(60), NOW, BOUNDS.gap).state).toBe('fresh');
    expect(freshness(ago(BOUNDS.gap), NOW, BOUNDS.gap).state).toBe('fresh');
    expect(freshness(ago(BOUNDS.gap + 1), NOW, BOUNDS.gap).state).toBe('stale');
    expect(freshness(ago(BOUNDS.gap + 1), NOW, BOUNDS.unlock).state).toBe('fresh');
  });
  it('a missing, unparsable or future timestamp is stale (never trusted as fresh)', () => {
    for (const bad of [undefined, null, '', 'yesterday', ago(-3600)]) expect(freshness(bad as never, NOW, 3600).state, String(bad)).toBe('stale');
  });
  it('the label always carries the as-of time; a stale one says so and never says live', () => {
    const f = freshness(ago(BOUNDS.gap + 7200), NOW, BOUNDS.gap);
    expect(f.label).toMatch(/as of 2026-10-10 \d\d:\d\d UTC/);
    expect(f.label).toMatch(/stale/i);
    expect(f.label).not.toMatch(/\blive\b/i);
    expect(freshness(ago(60), NOW, BOUNDS.gap).label).toMatch(/as of .* UTC/);
    expect(freshness(ago(60), NOW, BOUNDS.gap).label).not.toMatch(/\blive\b/i);
  });
  it('ages read in plain units', () => {
    expect(ageLabel(45)).toBe('45 s');
    expect(ageLabel(3 * 60)).toBe('3 min');
    expect(ageLabel(5 * 3600 + 120)).toBe('5 h 2 min');
    expect(ageLabel(3 * 86400)).toBe('3 d');
  });
});

describe('c5_no_unsafe_claims: findUnsafe', () => {
  it('flags the banned claims', () => {
    for (const bad of ['Credence is insurance for your loan', 'now live on mainnet', 'the live feed', 'strong demand from borrowers', 'Live on Mainnet!', 'insurance']) {
      expect(findUnsafe(bad).length, bad).toBeGreaterThan(0);
    }
  });
  it('lets the required disclosures through, and only them', () => {
    expect(findUnsafe('Not live, not insurance.')).toEqual([]);
    expect(findUnsafe('What cover would allow, not measured demand.')).toEqual([]);
    expect(findUnsafe('This is not insurance. It is gap protection.')).toEqual([]);
    expect(findUnsafe('not insurance, but insurance for all')).toEqual(['insurance']);
  });
});
