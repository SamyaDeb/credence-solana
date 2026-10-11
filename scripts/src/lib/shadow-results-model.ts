// Shadow results (W6): turns a copy of the shadow folder into numbers. Pure aggregation over what the shadow keeper
// logged; every risk figure (the capped Shield advance) comes from the program's pricing through `shadow_quote`
// (`shield_capped`), never from JS math. Labels: "read-only shadow on mainnet", "computed off-chain from mainnet data".

export type Row = Record<string, any>;
export type ShieldItem = { ticker: string; covered: string; debt: string; cap: string; closeWad: string; fairWad: string };
export type ShieldCapped = { raw: string; worstLoss: string; capped: string };
/** Asks the program's pricing to cap a batch of shield targets (`shadow_quote` op `shield_capped`). */
export type CapFn = (items: ShieldItem[]) => Promise<ShieldCapped[]>;

export const SYMS = ['SPYx', 'QQQx', 'NVDAx'] as const;
const WAD = 10n ** 18n;
export const toWad = (x: number) => (BigInt(Math.round(x * 1e9)) * 10n ** 9n).toString();
const usd = (base: string | bigint) => Number(base) / 1e6;

export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const dist = (xs: number[]) => ({ n: xs.length, total: sum(xs), median: median(xs), min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null });

export type Inputs = { meta: Row; summary: Row; state: Row; events: Row[]; prices: Row[]; book: Row[] };

export async function results(inp: Inputs, cap: CapFn) {
  const { summary, state, events, prices, book } = inp;
  const final = [...book].reverse().find((b) => b.final) ?? null;
  const by = (k: string) => events.filter((e) => e.kind === k);

  // Coverage: the final book (premiums from the program's own pricing at the bell).
  const sold = (final?.premiums ?? []).filter((p: Row) => p.premium !== null);
  const coverage = {
    source: 'book.jsonl (final), premiums by pricing::premium + shield_loading via shadow_quote',
    positionsTracked: Object.keys(state.positions ?? {}).length,
    covered: sold.length,
    refused: (final?.premiums ?? []).length - sold.length,
    debtCoveredUsd: summary.totals?.coveredDebtUsd ?? null,
    premiumsUsd: final ? final.premiumsUsd : null,
    perPolicyPremiumUsd: dist(sold.map((p: Row) => usd(p.premium))),
    byAsset: Object.fromEntries(SYMS.map((s) => {
      const r = sold.filter((p: Row) => p.sym === s);
      return [s, { ...dist(r.map((p: Row) => usd(p.premium))), debtUsd: sum(r.map((p: Row) => p.debtUsd)) }];
    })),
  };

  // Prices: the Scope gap per asset, when Scope first moved, the Pyth weekend fair value's path.
  const pxPath = (s: string) => {
    const rows = prices.filter((r) => r[s]?.push !== undefined && r[s].pushPublish >= (summary.close?.[s]?.ts ?? 0));
    let last = NaN;
    const pts: { publish: string; price: number }[] = [];
    for (const r of rows) {
      const k = r[s].pushPublish;
      if (k !== last) { pts.push({ publish: new Date(k * 1000).toISOString(), price: r[s].push }); last = k; }
    }
    const close = summary.close?.[s]?.price;
    return {
      pushes: pts.length, first: pts[0] ?? null, last: pts.at(-1) ?? null,
      min: pts.length ? Math.min(...pts.map((p) => p.price)) : null, max: pts.length ? Math.max(...pts.map((p) => p.price)) : null,
      lastVsClose: pts.length && close ? pts.at(-1)!.price / close - 1 : null,
    };
  };
  const priceRows = Object.fromEntries(SYMS.map((s) => {
    const c = summary.close?.[s]; const o = summary.settle?.[s]; const fm = summary.firstMove?.[s];
    return [s, {
      scopeClose: c?.price ?? null, scopeCloseTs: c ? new Date(c.ts * 1000).toISOString() : null,
      scopeOpen: o?.price ?? null, scopeOpenTs: o ? new Date(o.ts * 1000).toISOString() : null,
      gap: c && o ? o.price / c.price - 1 : null,
      scopeFirstMove: fm ? { at: new Date(fm.at * 1000).toISOString(), price: fm.price, move: c ? fm.price / c.price - 1 : null } : null,
      pyth: pxPath(s),
    }];
  }));

  // Shield: raw (what the live job logged, uncapped) and capped (INV-12, per policy), side by side.
  const lastAdv = new Map<string, Row>();
  for (const e of by('shield-advance')) lastAdv.set(e.ob, e);
  const advs = [...lastAdv.values()];
  const items: ShieldItem[] = advs.map((e) => {
    const c = state.positions[e.ob].cover;
    return { ticker: e.sym, covered: c.covered, debt: c.debt, cap: c.cap, closeWad: summary.close[e.sym].priceWad, fairWad: toWad(e.fair) };
  });
  const capped = items.length ? await cap(items) : [];
  const shieldRows = advs.map((e, i) => ({
    ob: e.ob, sym: e.sym, firstAt: by('shield-advance').find((x) => x.ob === e.ob)!.at, lastAt: e.at,
    rawUsd: e.advancedUsd, rawRecomputedUsd: usd(capped[i].raw), reservedWorstLossUsd: usd(capped[i].worstLoss), cappedUsd: usd(capped[i].capped),
  }));
  const shield = {
    source: 'events.jsonl shield-advance (raw, logged without the INV-12 cap) + shadow_quote shield_capped (capped by each policy\'s reserved worst loss)',
    window: { from: inp.meta.timeline?.shieldStart, to: inp.meta.timeline?.shieldDeadline },
    acted: shieldRows.length > 0,
    policiesAdvanced: shieldRows.length,
    firstAdvanceAt: shieldRows.map((r) => r.firstAt).sort()[0] ?? null,
    rawTotalUsd: sum(shieldRows.map((r) => r.rawUsd)),
    cappedTotalUsd: sum(shieldRows.map((r) => r.cappedUsd)),
    note: 'capped = min(raw, policy reserved worst loss); the group cap (LossVector.max_loss) is not applied here',
    rows: shieldRows,
  };

  // Liquidations: positions Kamino's price made liquidatable, and what the Backstop would have bought.
  const liq = by('liquidatable');
  const bs = liq.map((e) => e.backstop).filter(Boolean);
  const liquidations = {
    source: 'events.jsonl liquidatable (klend rule, shadow-model.ts::liquidation)',
    count: liq.length, covered: liq.filter((e) => e.covered).length,
    savedByShield: summary.totals?.savedByShield ?? 0,
    despiteShield: by('liquidatable-despite-shield').length,
    backstop: { buys: bs.length, repayUsd: sum(bs.map((b) => b.repayUsd)), seizeUsd: sum(bs.map((b) => b.seizeUsd)), bonusUsd: sum(bs.map((b) => b.bonusUsd)), bonusBps: bs.map((b) => b.bonusBps) },
    rows: liq.map((e) => ({ ob: e.ob, sym: e.sym, at: e.at, covered: e.covered, ratio: e.ratio, debtUsd: e.debtUsd, collateralUsd: e.collateralUsd, bonusBps: e.backstop?.bonusBps ?? null, bonusUsd: e.backstop?.bonusUsd ?? null })),
  };

  // Payouts at the real open, net of the Shield advance, and the loss ratio.
  const pay = by('payout');
  const finals = pay.map((e) => e.finalUsd);
  const paid = pay.filter((e) => e.finalUsd > 0);
  const premiums = final ? final.premiumsUsd : null;
  const settled = SYMS.every((s) => summary.settle?.[s]);
  const payouts = {
    source: 'events.jsonl payout (pricing::realized_payout at the Scope settlement price)',
    settled, positionsSettled: pay.length, paying: paid.length,
    totalUsd: sum(finals), shieldAdvancedUsd: sum(pay.map((e) => e.advancedUsd)), remainderUsd: sum(pay.map((e) => e.remainderUsd)), shieldLossUsd: sum(pay.map((e) => e.shieldLossUsd)),
    lossRatio: settled && premiums ? sum(finals) / premiums : null,
    rows: paid.map((e) => ({ ob: e.ob, sym: e.sym, finalUsd: e.finalUsd, advancedUsd: e.advancedUsd, remainderUsd: e.remainderUsd })),
  };

  const headline = !settled
    ? `PENDING: the weekend has not settled yet (${summary.phase}); premiums to collect ${fmt(premiums)} USDC`
    : payouts.totalUsd === 0
      ? `The weekend settled; nobody needed a payout. Premiums collected: ${fmt(premiums)} USDC.`
      : `The weekend settled: ${paid.length} of ${pay.length} policies paid ${fmt(payouts.totalUsd)} USDC against ${fmt(premiums)} USDC of premiums (loss ratio ${(payouts.lossRatio! * 100).toFixed(1)}%).`;

  return {
    kind: 'credence.shadow-results.v1', label: 'read-only shadow on mainnet; computed off-chain from mainnet data',
    closure: summary.closure, shadowAt: summary.at, phase: summary.phase, headline,
    coverage, prices: priceRows, shield, liquidations, payouts,
  };
}

const fmt = (x: number | null) => (x === null ? 'n/a' : x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(3)}%`);

export function markdown(r: Awaited<ReturnType<typeof results>>): string {
  const L: string[] = [];
  L.push(`# Shadow weekend results, closure ${r.closure}`, '', `_${r.label}. Snapshot of the shadow at ${r.shadowAt} (phase: ${r.phase}). No transaction was sent._`, '', `**${r.headline}**`, '');
  const c = r.coverage;
  L.push('## Coverage', '', `- Positions tracked: ${c.positionsTracked}; covered at the bell: ${c.covered} (refused: ${c.refused})`,
    `- Debt covered: ${fmt(c.debtCoveredUsd)} USDC; premiums: ${fmt(c.premiumsUsd)} USDC (median per policy ${fmt(c.perPolicyPremiumUsd.median)})`, '',
    '| Asset | Policies | Debt (USDC) | Premiums | Median | Min | Max |', '|---|---|---|---|---|---|---|');
  for (const [s, a] of Object.entries(c.byAsset)) L.push(`| ${s} | ${a.n} | ${fmt(a.debtUsd)} | ${fmt(a.total)} | ${fmt(a.median)} | ${fmt(a.min)} | ${fmt(a.max)} |`);
  L.push('', '## Prices (Kamino Scope: Friday close vs Monday open)', '', '| Asset | Close | Open | Gap | Scope first moved | Pyth pushes | Pyth last vs close |', '|---|---|---|---|---|---|---|');
  for (const [s, p] of Object.entries(r.prices)) L.push(`| ${s} | ${p.scopeClose?.toFixed(2) ?? 'n/a'} | ${p.scopeOpen?.toFixed(2) ?? 'pending'} | ${pct(p.gap)} | ${p.scopeFirstMove ? `${p.scopeFirstMove.at} (${pct(p.scopeFirstMove.move)})` : 'not yet'} | ${p.pyth.pushes} | ${pct(p.pyth.lastVsClose)} |`);
  const sh = r.shield;
  L.push('', '## Shield', '', sh.acted ? `- Acted on ${sh.policiesAdvanced} policies from ${sh.firstAdvanceAt}.` : `- Did not act${r.phase === 'weekend' || r.phase === 'after-bell' ? ' (the window opens ' + sh.window.from + ')' : ''}.`,
    `- **Raw (as logged, no INV-12 cap): ${fmt(sh.rawTotalUsd)} USDC. Capped by each policy's reserved worst loss: ${fmt(sh.cappedTotalUsd)} USDC.**`, `- ${sh.note}`);
  const l = r.liquidations;
  L.push('', '## Liquidations and the Backstop', '', `- Made liquidatable by Kamino's price: ${l.count} (covered: ${l.covered}); saved by the Shield: ${l.savedByShield}; liquidatable despite it: ${l.despiteShield}`,
    `- Backstop would have bought ${l.backstop.buys}: repay ${fmt(l.backstop.repayUsd)}, seize ${fmt(l.backstop.seizeUsd)}, bonus ${fmt(l.backstop.bonusUsd)} USDC${l.backstop.bonusBps.length ? ` (bonus bps: ${l.backstop.bonusBps.join(', ')})` : ''}`);
  const p = r.payouts;
  L.push('', '## Payouts', '', p.settled ? `- Settled ${p.positionsSettled} policies; paying: ${p.paying}; total ${fmt(p.totalUsd)} USDC (Shield advanced ${fmt(p.shieldAdvancedUsd)}, remainder ${fmt(p.remainderUsd)}); loss ratio ${p.lossRatio === null ? 'n/a' : (p.lossRatio * 100).toFixed(2) + '%'}` : '- Not settled yet (Monday open + 1 to 6 min).', '');
  return L.join('\n');
}
