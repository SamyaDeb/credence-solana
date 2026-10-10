// The weekend-risk summary of the position scan, shared by the scan route and scripts/src/site-snapshot.ts: what a Monday gap
// of −5/−8/−12% does to each position, per lender. At a gap g only the covered xStocks' share of the liquidation-threshold
// value C′ moves: C′(g) = C′_other + C′_x (1 + g). Pure: no RPC, no key.
export const GAPS = [-0.05, -0.08, -0.12];
export type Row = { obligation: string; market: string; symbol: string; debtUsd: number; coveredUsd: number; xShare: number; eligible: boolean };
export const COVERED = new Set(['SPYx', 'QQQx', 'NVDAx', 'TSLAx', 'GOOGLx', 'AAPLx', 'MSTRx', 'HOODx']);

export function summarise(rows: Row[], source: string, asOf: string) {
  const at = (r: Row, g: number) => r.coveredUsd * (1 - r.xShare) + r.coveredUsd * r.xShare * (1 + g);
  const shocks = GAPS.map((g) => {
    const hit = rows.filter((r) => r.debtUsd > at(r, g));
    return { gap: g, positions: hit.length, debtUsd: hit.reduce((a, r) => a + r.debtUsd, 0), repayNeededUsd: hit.reduce((a, r) => a + (r.debtUsd - at(r, g)), 0) };
  });
  const near = rows.filter((r) => r.coveredUsd > 0 && r.debtUsd / r.coveredUsd >= 0.9 && r.debtUsd / r.coveredUsd < 1).length;
  const now = rows.filter((r) => r.debtUsd >= r.coveredUsd).length;
  const top = [...rows].filter((r) => r.coveredUsd > 0 && r.debtUsd < r.coveredUsd).sort((a, b) => b.debtUsd / b.coveredUsd - a.debtUsd / a.coveredUsd).slice(0, 8)
    .map((r) => ({ obligation: r.obligation, market: r.market, symbol: r.symbol, debtUsd: r.debtUsd, ratio: r.debtUsd / r.coveredUsd }));
  return { source, asOf, positions: rows.length, debtUsd: rows.reduce((a, r) => a + r.debtUsd, 0), eligible: rows.filter((r) => r.eligible).length,
    eligibleDebtUsd: rows.filter((r) => r.eligible).reduce((a, r) => a + r.debtUsd, 0), nearThreshold: near, liquidatableNow: now, shocks, top };
}
export type Summary = ReturnType<typeof summarise>;

/** The Kamino summary (top level, as before) plus both lenders side by side. */
export function withLenders(kamino: Row[], jupiter: Row[], source: string, asOf: string) {
  const k = summarise(kamino, source, asOf);
  return { ...k, lenders: [{ lender: 'Kamino', ...k }, { lender: 'Jupiter Lend', ...summarise(jupiter, source, asOf) }] };
}

export type ScanDoc = {
  summary: { generatedAt: string };
  positions: { obligation: string; market: string; eligible: boolean; eligibleB1?: boolean; deposits: { symbol: string; valueUsd: number }[]; depositedUsd: number; debtUsd: number; coveredValueUsd: number }[];
  jupiterLend?: { positions: { position: string; asset: string; debtUsd: number; coveredValueUsd: number; eligibleB2: boolean }[] };
};

/** A committed scan file (data/positions/positions-<yyyymmdd>.json) as both lenders' summary. */
export function fromScanDoc(file: string, d: ScanDoc) {
  const rows = d.positions.filter((p) => p.debtUsd > 0).map((p) => {
    const x = p.deposits.filter((q) => COVERED.has(q.symbol));
    return { obligation: p.obligation, market: p.market, symbol: x.map((q) => q.symbol).join('+'), debtUsd: p.debtUsd, coveredUsd: p.coveredValueUsd,
      xShare: p.depositedUsd > 0 ? x.reduce((s2, q) => s2 + q.valueUsd, 0) / p.depositedUsd : 1, eligible: p.eligibleB1 ?? p.eligible };
  }).filter((r) => r.symbol);
  // Rows with no price (coveredUsd 0) are not liquidatable, they are unknown: left out (audit A-60).
  const jl: Row[] = (d.jupiterLend?.positions ?? []).filter((p) => p.coveredValueUsd > 0).map((p) => ({ obligation: p.position, market: 'Jupiter Lend', symbol: p.asset,
    debtUsd: p.debtUsd, coveredUsd: p.coveredValueUsd, xShare: 1, eligible: p.eligibleB2 }));
  return withLenders(rows, jl, `mainnet scan file ${file} (values brought to the scan time)`, d.summary.generatedAt);
}
