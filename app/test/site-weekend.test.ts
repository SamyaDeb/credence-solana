// A-301: the public Weekend view turns "final" when the shadow keeper's last tick says so. The shadow's last phase is 'done'
// (keeper/src/shadow-model.ts `Phase`), never 'final', so a page built from a finished summary said "Running" forever.
import { describe, expect, it } from 'vitest';
import { weekendFromSummary } from '../src/lib/site/weekend';
import { phase, timeline } from '../../keeper/src/shadow-model';

const totals = { watched: 535, covered: 535, shieldAdvances: 0, shieldAdvancedUsd: 0, liquidatable: 1, liquidatableCovered: 1, savedByShield: 0, payouts: 0, payoutsUsd: 0, premiumsUsd: 2698.62, coveredDebtUsd: 1218031.24 };
const summary = (ph: string) => ({ at: '2026-10-12T14:30:00.000Z', phase: ph, totals, close: { SPYx: { price: 782.89 } } });

describe('weekend snapshot', () => {
  it('is final exactly when the shadow keeper reports its last phase', () => {
    const sessions = [{ date: 20261009, open: 0, close: 1_000_000 }, { date: 20261012, open: 1_200_000, close: 1_300_000 }];
    const t = timeline(sessions, 20261009);
    const last = phase(t, t.end + 1); // what the keeper writes after the weekend
    expect(last).toBe('done');
    expect(weekendFromSummary(summary(last), '20261009')!.final).toBe(true);
    for (const ph of ['pre-bell', 'after-bell', 'weekend', 'shield-window', 'pre-market', 'settlement', 'post-open']) {
      expect(weekendFromSummary(summary(ph), '20261009')!.final).toBe(false);
    }
  });
  it('carries the totals and the closes through', () => {
    const w = weekendFromSummary(summary('done'), '20261009')!;
    expect(w).toMatchObject({ closure: 20261009, watched: 535, covered: 535, premiumsUsd: 2698.62, close: { SPYx: 782.89 }, results: null });
  });
});
