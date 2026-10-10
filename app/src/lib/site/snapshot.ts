// The one file the public pages read: data/site/snapshot.json, written by scripts/src/site-snapshot.ts from files already in
// the repo (no RPC, no key). Every section carries its source file(s) and its own as-of time; the pages label each by
// lib/site/fresh.ts. Nothing here is a price or a risk figure computed in JavaScript: the Oracle numbers are the program's Rust
// (examples/gap_feed.rs), the unlock table is examples/unlock_quote.rs, the scan is the committed positions scan.
import type { Summary } from '@/lib/scan-summary';

export type GapItem = {
  ticker: string; frozen: boolean; blocked: boolean; flagNames: string[];
  closePriceWad: string; fairPriceWad: string; lenderPriceWad: string;
  impliedGapFairWad: string; impliedGapLenderWad: string;
  pLt5Wad: string; pLt8Wad: string; pLt12Wad: string; sigmaWad: string;
  lenderSinceTs: number; fairPublishTs: number;
};
export type UnlockTarget = {
  target: string; positions: number; extraDebtUsd: number; premiumPerWeekendUsd: number;
  costDebtWeighted: number; costDebtWeightedOver1k: number | null; allInDebtWeighted: number; pUncoveredDebtWeighted: number; residualAtOpen: number | null;
  bySize: { minExtraUsd: string; positions: number; extraDebtUsd: number; costDebtWeighted: number }[];
  lpEquityUsd: { share: number; usd: number }[];
};
export type Section = { asOf: string; source: string };
export type Snapshot = {
  kind: 'credence.site.v1';
  generatedAt: string;
  gap: (Section & { closure: { id: number; type: number; closeTs: number; nextOpen: number }; note: string; items: GapItem[] }) | null;
  scan: (Section & { lenders: (Summary & { lender: string })[] }) | null;
  unlock: (Section & { caveat: string; totalPositions: number; totalDebtUsd: number; headroomUsd: number; targets: UnlockTarget[]; excluded: string }) | null;
  books: (Section & { gap: number; legs: { total: number; kamino: number; jupiter: number }; premiumUsdc: number; sumStandaloneUsdc: number; extraCreditUsd: number;
    advancedUsdc: number; paidOutUsdc: number; refundedUsdc: number; seconds: number }) | null;
  proof: Section & { commit: string; tests: { label: string; passed: number; note: string }[]; audit: AuditCounts };
  weekend: (Section & { closure: number; phase: string; final: boolean; watched: number; covered: number; shieldAdvances: number; shieldAdvancedUsd: number;
    liquidatable: number; liquidatableCovered: number; savedByShield: number; payouts: number; payoutsUsd: number; premiumsUsd: number; coveredDebtUsd: number;
    close: Record<string, number> }) | null;
};
export type AuditCounts = { total: number; first: number; last: number; bySeverity: Record<string, number>; fixed: number; knownLimit: number; open: number; other: number };
