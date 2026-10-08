// How likely a policy is to pay anything this weekend, shown next to every premium (Day 5 step 0). Two numbers:
// - the model's: the share of the asset's on-chain WEEKEND scenario set (the set `quote_cover` prices with) whose gap
//   factor g = 1 + σ z / 1000 leaves C′ × g below the debt, i.e. the probability the premium was priced on;
// - history's: how many real market closures since Apr 2016 opened with a gap that would have paid this position
//   (open / previous close − 1 of the underlying, data/sigma/closure-gaps.json, Yahoo daily bars).
import { Connection } from '@solana/web3.js';
import { WAD, pdas } from './credence';

/** ScenarioSet (zero-copy): 8 discriminator, hash 32, ticker 8, n u16 at 48, …, z: [i16; N_SCEN] at 56, ascending. */
export function decodeScenarioZ(data: Uint8Array): Int16Array {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const n = v.getUint16(48, true);
  const z = new Int16Array(n);
  for (let i = 0; i < n; i++) z[i] = v.getInt16(56 + 2 * i, true);
  return z;
}

export async function loadScenarioZ(conn: Connection, ticker: string): Promise<Int16Array> {
  const a = await conn.getAccountInfo(pdas.scen(ticker));
  if (!a) throw new Error(`no ScenarioSet for ${ticker}`);
  return decodeScenarioZ(a.data);
}

/** Pays iff D > C′ × g, with g = 1 + σ z / 1000 (WAD) floored at 0: D × 1000 × WAD > C′ × max(0, 1000 × WAD + σ z). */
export function modelPays(z: Int16Array, sigmaWad: bigint, coveredValue: bigint, debt: bigint): { count: number; n: number; p: number } {
  let count = 0;
  for (const zi of z) {
    const g = 1000n * WAD + sigmaWad * BigInt(zi);
    if (debt * 1000n * WAD > coveredValue * (g > 0n ? g : 0n)) count++;
    else break; // ascending z: the rest pay nothing
  }
  return { count, n: z.length, p: z.length ? count / z.length : 0 };
}

/** Real closures whose opening gap would have paid: C′ × (1 + gap) < D. */
export function historyPays(gaps: number[], coveredValue: bigint, debt: bigint): number {
  const breakEven = Number(debt) / Number(coveredValue) - 1;
  return gaps.filter((g) => g < breakEven).length;
}

export type History = { source: string; closures: Record<string, number>; from: string; to: string; gaps: Record<string, number[]> };

export async function loadHistory(): Promise<History> {
  const r = await fetch('/api/data/history');
  const j = await r.json();
  if (!r.ok) throw new Error(j.error);
  return j as History;
}

/** "0.63%", "<0.01%", or "0%" for the line next to a premium. */
export function oddsPct(p: number): string {
  if (p === 0) return '0%';
  if (p < 0.0001) return '<0.01%';
  return `${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%`;
}
