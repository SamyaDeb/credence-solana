// Builds data/site/snapshot.json, the one file the public site's pages read (app/src/lib/site/snapshot.ts). It reads files that
// are already in the repo (CREDENCE_DATA_ROOT redirects only the recorders' own file, data/live/gap-feed-mainnet.json); it makes no RPC call and holds no key. Refresh: run it, commit the file,
// redeploy (the freshness decision, plan/06 C5).
//   gap      data/live/gap-feed-mainnet.json     (scripts/src/gap-feed-mainnet.ts: the program's Rust on mainnet inputs)
//   scan     data/positions/positions-*.json     (scripts/src/positions.ts), summarised by app/src/lib/scan-summary.ts
//   unlock   data/unlock/unlock-*.json           (scripts/src/unlock.ts)
//   books    data/demo/book-result.json          (the fork demo)
//   proof    data/site/proof-input.json + the audit table in docs/audit/phase1-audit.md
//   weekend  <SHADOW_ROOT>/data/shadow/<closure>/summary.json, read only (the shadow keeper writes it; never edited here)
// Usage: cd scripts && CREDENCE_DATA_ROOT=<checkout the recorders write to> SHADOW_ROOT=<shadow checkout> pnpm tsx src/site-snapshot.ts
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromScanDoc, type ScanDoc } from '../../app/src/lib/scan-summary';
import { weekendFromSummary, type ShadowSummary } from '../../app/src/lib/site/weekend';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA_ROOT = process.env.CREDENCE_DATA_ROOT ?? ROOT;
const SHADOW_ROOT = process.env.SHADOW_ROOT ?? join(process.env.HOME ?? '', 'Downloads/credence-shadow');
const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T;
const latest = (dir: string, re: RegExp) => readdirSync(dir).filter((f) => re.test(f)).sort().pop();
const iso = (secs: number) => new Date(secs * 1000).toISOString();

function gap() {
  const p = join(DATA_ROOT, 'data/live/gap-feed-mainnet.json');
  if (!existsSync(p)) return null;
  const d = readJson<{ computedAt: number; closure: { id: number; type: number; closeTs: number; nextOpen: number }; note: string; items: Record<string, unknown>[] }>(p);
  return {
    asOf: iso(d.computedAt), source: 'data/live/gap-feed-mainnet.json (scripts/src/gap-feed-mainnet.ts: examples/gap_feed.rs on mainnet inputs)',
    closure: d.closure, note: d.note,
    items: d.items.map((i) => ({
      ticker: String(i.ticker), frozen: (i.flagNames as string[]).includes('LENDER_FROZEN'), blocked: Boolean(i.blocked), flagNames: i.flagNames as string[],
      closePriceWad: String(i.closePriceWad), fairPriceWad: String(i.fairPriceWad), lenderPriceWad: String(i.lenderPriceWad),
      impliedGapFairWad: String(i.impliedGapFairWad), impliedGapLenderWad: String(i.impliedGapLenderWad),
      pLt5Wad: String(i.pLt5Wad), pLt8Wad: String(i.pLt8Wad), pLt12Wad: String(i.pLt12Wad), sigmaWad: String(i.sigmaWad),
      lenderSinceTs: Number(i.lenderSinceTs), fairPublishTs: Number(i.fairPublishTs),
    })),
  };
}

function scan() {
  const dir = join(ROOT, 'data/positions');
  const f = latest(dir, /^positions-\d+\.json$/);
  if (!f) return null;
  const doc = readJson<ScanDoc>(join(dir, f));
  const s = fromScanDoc(`data/positions/${f}`, doc);
  return { asOf: s.asOf, source: `data/positions/${f}`, lenders: s.lenders };
}

type Targets = Record<string, { positions: number; extraDebtUsd: number; premiumPerWeekendUsd: number; annualisedCostDebtWeighted: number; allInDebtWeighted: number;
  pUncoveredAtTargetDebtWeighted: number; residual: { basisSigmas: number; debtWeighted: number }[];
  bySize: Record<string, { positions: number; extraDebtUsd: number; annualisedCostDebtWeighted: number }> }>;
function unlock() {
  const dir = join(ROOT, 'data/unlock');
  const f = latest(dir, /^unlock-\d{8}\.json$/);
  if (!f) return null;
  const d = readJson<{ generatedAt: string; caveat: string; aggregates: { total: { positions: number; debtUsd: number; headroomUsd: number; targets: Targets } };
    capacity: Record<string, { slices: { share: number; equity: string }[] }>; excluded: { note?: string } }>(join(dir, f));
  const t = d.aggregates.total;
  return {
    asOf: d.generatedAt, source: `data/unlock/${f} (scripts/src/unlock.ts)`, caveat: d.caveat,
    totalPositions: t.positions, totalDebtUsd: t.debtUsd, headroomUsd: t.headroomUsd,
    excluded: d.excluded.note ?? '',
    targets: Object.entries(t.targets).map(([target, x]) => ({
      target, positions: x.positions, extraDebtUsd: x.extraDebtUsd, premiumPerWeekendUsd: x.premiumPerWeekendUsd,
      costDebtWeighted: x.annualisedCostDebtWeighted, costDebtWeightedOver1k: x.bySize['1000']?.annualisedCostDebtWeighted ?? null,
      allInDebtWeighted: x.allInDebtWeighted, pUncoveredDebtWeighted: x.pUncoveredAtTargetDebtWeighted,
      residualAtOpen: x.residual.find((r) => r.basisSigmas === 0)?.debtWeighted ?? null,
      bySize: Object.entries(x.bySize).map(([minExtraUsd, b]) => ({ minExtraUsd, positions: b.positions, extraDebtUsd: b.extraDebtUsd, costDebtWeighted: b.annualisedCostDebtWeighted })),
      lpEquityUsd: (d.capacity[target]?.slices ?? []).map((s) => ({ share: s.share, usd: Number(BigInt(s.equity)) / 1e6 })),
    })),
  };
}

function books() {
  const p = join(ROOT, 'data/demo/book-result.json');
  if (!existsSync(p)) return null;
  const b = readJson<{ ranAt: string; seconds: number; gap: number; legs: { total: number; kamino: number; jupiter: number };
    pricing: { premiumUsdc: number; sumStandaloneUsdc: number; extraCreditUsd: number };
    bookState: { advancedUsdc: number; paidOutUsdc: number; refundedUsdc: number } }>(p);
  return { asOf: b.ranAt, source: 'data/demo/book-result.json (fork demo)', gap: b.gap, legs: b.legs, seconds: b.seconds, premiumUsdc: b.pricing.premiumUsdc,
    sumStandaloneUsdc: b.pricing.sumStandaloneUsdc, extraCreditUsd: b.pricing.extraCreditUsd, advancedUsdc: b.bookState.advancedUsdc,
    paidOutUsdc: b.bookState.paidOutUsdc, refundedUsdc: b.bookState.refundedUsdc };
}

function audit() {
  const rows = readFileSync(join(ROOT, 'docs/audit/phase1-audit.md'), 'utf8').split('\n').filter((l) => /^\| A-\d+ \|/.test(l));
  const bySeverity: Record<string, number> = {};
  let fixed = 0, knownLimit = 0, open = 0, other = 0;
  const ids: number[] = [];
  for (const l of rows) {
    const c = l.trim().replace(/^\||\|$/g, '').split('|').map((x) => x.trim());
    ids.push(Number(c[0].slice(2)));
    bySeverity[c[1]] = (bySeverity[c[1]] ?? 0) + 1;
    const st = c[c.length - 1];
    if (st === 'fixed') fixed++; else if (st === 'known limit') knownLimit++; else if (st === 'open') open++; else other++;
  }
  return { total: rows.length, first: Math.min(...ids), last: Math.max(...ids), bySeverity, fixed, knownLimit, open, other };
}

function proof() {
  const i = readJson<{ asOf: string; tests: { label: string; passed: number; note: string }[] }>(join(ROOT, 'data/site/proof-input.json'));
  return { asOf: i.asOf, source: 'data/site/proof-input.json (test runs at the merge gate) and docs/audit/phase1-audit.md', commit: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT }).toString().trim(), tests: i.tests, audit: audit() };
}

function weekend() {
  const dir = join(SHADOW_ROOT, 'data/shadow');
  if (!existsSync(dir)) return null;
  const closure = latest(dir, /^\d{8}$/);
  if (!closure) return null;
  const p = join(dir, closure, 'summary.json');
  if (!existsSync(p)) return null;
  const s = readJson<ShadowSummary>(p);
  // The results tool's output (a copy of the shadow folder in this checkout, scripts/src/shadow-results.ts); shown once settled.
  const rp = join(ROOT, 'data/shadow', closure, 'results.json');
  return weekendFromSummary(s, closure, existsSync(rp) ? readJson(rp) : null);
}

const snapshot = { kind: 'credence.site.v1', generatedAt: new Date().toISOString(), gap: gap(), scan: scan(), unlock: unlock(), books: books(), proof: proof(), weekend: weekend() };
writeFileSync(join(ROOT, 'data/site/snapshot.json'), JSON.stringify(snapshot, null, 1) + '\n');
console.log(`data/site/snapshot.json: gap ${snapshot.gap?.items.length ?? 0} assets, scan ${snapshot.scan?.lenders.length ?? 0} lenders, unlock ${snapshot.unlock?.targets.length ?? 0} targets, ` +
  `books ${snapshot.books ? 'yes' : 'no'}, weekend ${snapshot.weekend ? snapshot.weekend.phase : 'none'}, audit ${snapshot.proof.audit.total} findings`);
