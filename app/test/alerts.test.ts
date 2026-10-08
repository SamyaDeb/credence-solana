// The Alerts page and the sidebar badge are derived from chain state by lib/alerts.ts: the bell alert fires only for an
// eligible, uncovered position near its threshold inside the lead time; policy, close, settlement, payout and LP alerts
// follow the accounts; kinds switched off in Settings are dropped.
import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { deriveAlerts } from '@/lib/alerts';
import type { EpochView, PolicyView } from '@/lib/cover';
import { DEFAULT_PREFS } from '@/lib/prefs';
import type { TicketView } from '@/lib/vault';

const k = () => Keypair.generate().publicKey;
const bell = 1_791_575_100;
const epoch = (over: Partial<EpochView> = {}): EpochView => ({
  key: k(), ticker: 'SPYx', closureId: 20261009, state: 0, saleOpen: bell - 4 * 86_400, bell, close: bell + 900, open: bell + 900 + 63_000, settleAfter: 0, settledAt: 0,
  closePriceWad: 0n, settlePriceWad: 0n, policyCount: 0, policiesSettled: 0, totalMaxPayout: 0n, totalPremium: 0n, totalPayout: 0n, worstLossSum: 0n, ...over,
});
const pos = (over = {}) => ({ key: k(), ticker: 'SPYx', ratio: 0.96, eligible: true, covered: false, ...over });

describe('alerts', () => {
  it('bell: only eligible, uncovered, near the threshold, inside the lead time', () => {
    const e = epoch();
    const base = { policies: [] as PolicyView[], epochs: [e], tickets: [] as TicketView[], live: [], prefs: DEFAULT_PREFS };
    expect(deriveAlerts({ ...base, now: bell - 3600, positions: [pos()] }).map((a) => a.kind)).toEqual(['bell']);
    expect(deriveAlerts({ ...base, now: bell - 3 * 86_400, positions: [pos()] })).toHaveLength(0); // beyond 48 h
    expect(deriveAlerts({ ...base, now: bell - 3600, positions: [pos({ covered: true })] })).toHaveLength(0);
    expect(deriveAlerts({ ...base, now: bell - 3600, positions: [pos({ ratio: 0.7 })] })).toHaveLength(0);
    expect(deriveAlerts({ ...base, now: bell - 3600, positions: [pos({ eligible: false })] })).toHaveLength(0);
    expect(deriveAlerts({ ...base, now: bell + 1, positions: [pos()] })).toHaveLength(0); // after the bell
  });

  it('a settled policy gives cover, close, settlement and payout alerts; kinds can be switched off', () => {
    const e = epoch({ state: 2, closePriceWad: 780n * 10n ** 18n, settlePriceWad: 718n * 10n ** 18n });
    const p = { key: k(), owner: k(), obligation: k(), epoch: e.key, ticker: 'SPYx', state: 1, collateralValue: 0n, coveredValue: 0n, debt: 0n, ltWad: 0n,
      maxPayout: 50_000_000_000n, premium: 8_640_000n, fee: 0n, worstLoss: 0n, payout: 2_075_170_000n, createdAt: bell - 7200 } as PolicyView;
    const a = deriveAlerts({ now: bell + 86_400 * 3, positions: [], policies: [p], epochs: [e], tickets: [], live: [], prefs: DEFAULT_PREFS });
    expect(a.map((x) => x.kind).sort()).toEqual(['close', 'cover', 'payout', 'settlement']);
    expect(a.find((x) => x.kind === 'payout')!.title).toContain('2,075.17 USDC repaid');
    const off = deriveAlerts({ now: bell + 86_400 * 3, positions: [], policies: [p], epochs: [e], tickets: [], live: [], prefs: { ...DEFAULT_PREFS, alerts: { ...DEFAULT_PREFS.alerts, payout: false } } });
    expect(off.map((x) => x.kind)).not.toContain('payout');
  });

  it('an LP ticket is announced once its weekend is no longer live', () => {
    const t = { key: k(), owner: k(), waitGroup: 20261009, kind: 1, amount: 1n, requestedAt: bell } as TicketView;
    const args = { now: bell, positions: [], policies: [], epochs: [], tickets: [t], prefs: DEFAULT_PREFS };
    expect(deriveAlerts({ ...args, live: [20261009] })).toHaveLength(0);
    expect(deriveAlerts({ ...args, live: [] }).map((a) => a.kind)).toEqual(['lp']);
  });
});
