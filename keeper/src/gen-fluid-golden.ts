// Goldens for risk-core::fluid (B2): `@jup-ag/lend`'s getRatioAtTick and its position debt formula
// (debtRaw = ratio × (colRaw + 1) >> 48, + 1) on ticks across the range and a few real-looking positions.
//   → crates/risk-core/tests/fixtures/fluid_golden.json      Usage: pnpm tsx src/gen-fluid-golden.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
import { getRatioAtTick, MIN_TICK, MAX_TICK } from '@jup-ag/lend/borrow';
const BN = anchor.BN;
const ROOT = new URL('../../', import.meta.url).pathname;
const ticks: number[] = [MIN_TICK, MAX_TICK, 0, 1, -1, 2, -2, 4012, 4001, -4012];
for (let t = MIN_TICK; t <= MAX_TICK; t += 97) ticks.push(t);
for (let i = 0; i < 15; i++) { ticks.push(1 << i); ticks.push(-(1 << i)); ticks.push((1 << i) - 1); }
const uniq = [...new Set(ticks.filter((t) => t >= MIN_TICK && t <= MAX_TICK))].sort((a, b) => a - b);
const ratios = uniq.map((t) => ({ tick: t, ratioX48: getRatioAtTick(t).toString() }));
const cols = ['0', '1', '740021694084', '1000000000', '123456789012345', '18446744073709551615'];
const debts = [];
for (const t of [4012, 4001, 0, -500, 1200, 3000, 8000]) for (const c of cols) {
  debts.push({ tick: t, colRaw: c, debtRaw: getRatioAtTick(t).mul(new BN(c).add(new BN(1))).shrn(48).add(new BN(1)).toString() });
}
writeFileSync(join(ROOT, 'crates/risk-core/tests/fixtures/fluid_golden.json'), JSON.stringify({ source: '@jup-ag/lend 0.4.0', ratios, debts }, null, 1) + '\n');
console.log(`${ratios.length} ratios, ${debts.length} debts`);
