// Shadow results tool (W6): aggregation over a synthetic shadow folder with a −8% open, so the Shield, liquidation and
// payout paths run before Monday. The risk numbers come from the program's pricing (`shadow_quote`), not from JS.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { markdown, median, results, toWad, type Inputs } from '../../scripts/src/lib/shadow-results-model';
import { quoteCap } from '../../scripts/src/shadow-results';

const ROOT = new URL('../../', import.meta.url).pathname;
const BIN = process.env.SHADOW_QUOTE ?? `${ROOT}target/release/examples/shadow_quote`;
const built = existsSync(BIN);
const ask = (reqs: object[]) =>
  spawnSync(BIN, ['--root', ROOT], { input: reqs.map((r) => JSON.stringify(r)).join('\n') + '\n', encoding: 'utf8' }).stdout.trim().split('\n').slice(1).map((l) => JSON.parse(l));

const t = (iso: string) => Date.parse(iso) / 1000;
const cover = { covered: '750000000', debt: '700000000', cap: '700000000' };
const CLOSE = 100;

/** One SPYx policy (C′ 750, D 700), a Friday close of 100, a Shield advance at fair 92 and a Monday open of 92 (−8%). */
function synthetic(open: number | null, fair = 92): Inputs {
  const closeWad = toWad(CLOSE);
  const payoutUsd = open === null ? null : Number(ask([{ op: 'payout', items: [{ ...cover, closeWad, settleWad: toWad(open) }] }])[0].payouts[0]) / 1e6;
  const events: any[] = [
    { at: '2026-10-09T20:00:11.000Z', kind: 'close', sym: 'SPYx', price: CLOSE },
    { at: '2026-10-12T01:00:00.000Z', kind: 'shield-advance', ob: 'OB1', sym: 'SPYx', amountUsd: 0, advancedUsd: 0, fair, close: CLOSE },
    { at: '2026-10-11T00:00:00.000Z', kind: 'liquidatable', ob: 'OB1', sym: 'SPYx', covered: true, ratio: 1.02, debtUsd: 700, collateralUsd: 900, backstop: { bonusBps: 200, repayUsd: 140, seizeUsd: 142.8, bonusUsd: 2.8 } },
  ];
  if (payoutUsd !== null) events.push({ at: '2026-10-12T13:32:00.000Z', kind: 'payout', ob: 'OB1', sym: 'SPYx', finalUsd: payoutUsd, advancedUsd: 23.8, remainderUsd: Math.max(0, payoutUsd - 23.8), shieldLossUsd: Math.max(0, 23.8 - payoutUsd) });
  return {
    meta: { timeline: { shieldStart: '2026-10-12T00:00:00.000Z', shieldDeadline: '2026-10-12T11:00:00.000Z' } },
    summary: {
      at: '2026-10-12T14:30:00.000Z', phase: open === null ? 'weekend' : 'done', closure: 20261009,
      totals: { coveredDebtUsd: 700, savedByShield: 0 },
      close: { SPYx: { priceWad: closeWad, price: CLOSE, ts: t('2026-10-09T20:00:05Z') }, QQQx: { priceWad: closeWad, price: CLOSE, ts: t('2026-10-09T20:00:05Z') }, NVDAx: { priceWad: closeWad, price: CLOSE, ts: t('2026-10-09T20:00:05Z') } },
      settle: open === null ? {} : Object.fromEntries(['SPYx', 'QQQx', 'NVDAx'].map((s) => [s, { priceWad: toWad(open), price: open, ts: t('2026-10-12T13:31:10Z') }])),
      firstMove: { SPYx: { at: t('2026-10-12T00:05:00Z'), price: 99, ts: t('2026-10-12T00:05:00Z') } },
    },
    state: { positions: { OB1: { cover } } },
    events,
    prices: [{ at: 'x', SPYx: { push: fair, pushPublish: t('2026-10-12T01:00:00Z') } }],
    book: [{ final: true, premiumsUsd: 12.5, premiums: [{ ob: 'OB1', sym: 'SPYx', debtUsd: 700, premium: '12500000' }] }],
  };
}

describe('shadow results', () => {
  it('median', () => {
    expect(median([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it.skipIf(!built)('a −8% open: the payout, the Shield and the liquidation are reported, with raw and capped Shield side by side', async () => {
    const r = await results(synthetic(92), quoteCap(BIN));
    expect(r.prices.SPYx.gap).toBeCloseTo(-0.08, 12);
    expect(r.payouts.settled).toBe(true);
    expect(r.payouts.totalUsd).toBe(10); // realized_payout(750, 700, cap 700, close 100, open 92) = 700 − 750·0.92
    expect(r.payouts.lossRatio).toBeCloseTo(10 / 12.5, 12);
    expect(r.shield.acted).toBe(true);
    expect(r.shield.rows[0].rawRecomputedUsd).toBeCloseTo(23.8, 6); // shield_target at fair 92, b 2%
    expect(r.shield.rows[0].cappedUsd).toBeLessThanOrEqual(r.shield.rows[0].reservedWorstLossUsd);
    expect(r.shield.rows[0].cappedUsd).toBe(r.shield.rows[0].rawRecomputedUsd); // the cap does not bind here
    expect(r.liquidations.backstop.bonusUsd).toBeCloseTo(2.8, 12);
    expect(r.headline).toMatch(/1 of 1 policies paid 10\.00 USDC against 12\.50 USDC/);
    expect(markdown(r)).toMatch(/Raw \(as logged, no INV-12 cap\)/);
  });

  it.skipIf(!built)('a fair value far below the open: the capped advance is the reserved worst loss, below the raw one (INV-12)', async () => {
    const r = await results(synthetic(100, 60), quoteCap(BIN));
    const s = r.shield.rows[0];
    expect(s.rawRecomputedUsd).toBe(259); // min(α·cap 350, need 259)
    expect(s.cappedUsd).toBe(s.reservedWorstLossUsd);
    expect(s.cappedUsd).toBeLessThan(s.rawRecomputedUsd);
    expect(r.shield.cappedTotalUsd).toBeLessThan(r.shield.rawTotalUsd + 1e-9 + s.rawRecomputedUsd);
  });

  it.skipIf(!built)('a flat open: the plain result is "nobody needed a payout"', async () => {
    const r = await results(synthetic(100), quoteCap(BIN));
    expect(r.payouts.totalUsd).toBe(0);
    expect(r.headline).toBe('The weekend settled; nobody needed a payout. Premiums collected: 12.50 USDC.');
  });

  it.skipIf(!built)('before the open it says PENDING, not a result', async () => {
    const r = await results(synthetic(null), quoteCap(BIN));
    expect(r.headline).toMatch(/^PENDING/);
    expect(r.prices.SPYx.gap).toBeNull();
  });

  it('the results tool signs nothing and has no RPC', () => {
    const code = (f: string) => readFileSync(new URL(`../../scripts/src/${f}`, import.meta.url), 'utf8').replace(/\/\/.*$/gm, '');
    for (const f of ['shadow-results.ts', 'lib/shadow-results-model.ts']) {
      for (const bad of [/Keypair/, /\bWallet\b/, /sendTransaction/, /sendRawTransaction/, /sendAndConfirm/, /signTransaction/, /\.sign\(/, /simulateTransaction/, /new Connection/, /MAINNET_RPC/, /requestAirdrop/]) expect(code(f)).not.toMatch(bad);
    }
  });

  it('the replay refuses a non-local RPC and never reads the mainnet RPC itself', () => {
    const code = (f: string) => readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/ \/\/ .*$/gm, '');
    const replay = code('keeper/src/replay.ts');
    expect(replay).toMatch(/RPC_URL must be a local fork/);
    expect(replay).not.toMatch(/MAINNET_RPC/);
    expect(replay).not.toMatch(/mainnet-beta|helius|api\.mainnet/);
    // the wrapper script gives the mainnet URL only to surfpool's datasource (lazy reads), through the environment
    const sh = code('scripts/replay-weekend.sh');
    expect([...sh.matchAll(/MAINNET_RPC/g)].length).toBeLessThanOrEqual(4);
    expect(sh).toMatch(/SURFPOOL_DATASOURCE_RPC_URL="\$MAINNET_RPC"/);
    expect(sh).not.toMatch(/solana (program )?(deploy|transfer)|sendTransaction/);
  });
});
