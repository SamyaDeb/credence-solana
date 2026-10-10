// D4.0 research data (read-only, mainnet): how the lender prices the NAV assets used as collateral on Kamino, and how that
// price moved. For each asset: the Kamino market and reserve, the collateral deposited and the debt borrowed in the market
// (public API), the mint's authorities (RPC), and 90 days of hourly lender-oracle price (Kamino API reserve history),
// summarised as daily and Fri→Mon log returns. Output: data/nav/nav-assets.json.   pnpm -C scripts tsx src/nav-assets.ts
import { config } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
config({ path: join(import.meta.dirname, '../../.env'), quiet: true });

const API = 'https://api.kamino.finance';
const ASSETS = [
  { name: 'ONyc', issuer: 'OnRe (tokenized reinsurance)', market: '47tfyEG9SsdEnUm9cw5kY9BXngQGqu3LBoop9j5uTAv8', mint: '5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5' },
  { name: 'PRIME', issuer: 'Hastra (Figure Democratized Prime HELOC pool)', market: 'CqAoLuqWtavaVE8deBjMKe8ZfSt9ghR6Vb8nfsyabyHA', mint: '3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7' },
  { name: 'USTB', issuer: 'Superstate (US Treasuries)', market: 'CF32kn7AY8X1bW7ZkGcHc4X9ZWTxqKGCJk6QwrQkDcdw', mint: 'CCz3SGVziFeLYk2xfEstkiqJfYkjaSWb2GCABYsVcjo2' },
];
const get = async (u: string) => (await fetch(u, { headers: { 'user-agent': 'credence-research' } })).json() as Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const rpc = async (method: string, params: unknown[]) => (await (await fetch(process.env.MAINNET_RPC!, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json() as any).result; // eslint-disable-line @typescript-eslint/no-explicit-any
const std = (xs: number[]) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };

const out: unknown[] = [];
for (const a of ASSETS) {
  const rs = (await get(`${API}/kamino-market/${a.market}/reserves/metrics`)) as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = rs.find((x) => x.liquidityTokenMint === a.mint);
  if (!r) { out.push({ ...a, error: 'reserve not found' }); continue; }
  const debt = rs.filter((x) => x.liquidityTokenMint !== a.mint).reduce((s, x) => s + Number(x.totalBorrowUsd), 0);
  const mint = (await rpc('getAccountInfo', [a.mint, { encoding: 'jsonParsed' }])).value.data.parsed.info;
  const end = new Date(), start = new Date(end.getTime() - 90 * 86_400_000);
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const h = await get(`${API}/kamino-market/${a.market}/reserves/${r.reserve}/metrics/history?env=mainnet-beta&start=${day(start)}&end=${day(end)}&frequency=hour`);
  const pts = (h.history as { timestamp: string; metrics: { assetOraclePriceUSD: string } }[]).map((p) => ({ t: new Date(p.timestamp), px: Number(p.metrics.assetOraclePriceUSD) })).filter((p) => p.px > 0);
  const closes = new Map<string, number>();
  for (const p of pts) closes.set(day(p.t), p.px);
  const days = [...closes.keys()].sort();
  const dr = days.slice(1).map((d, i) => Math.log(closes.get(d)! / closes.get(days[i])!));
  const wk: number[] = [];
  days.forEach((d, i) => { if (new Date(d).getUTCDay() === 5 && days[i + 3] === day(new Date(new Date(d).getTime() + 3 * 86_400_000))) wk.push(Math.log(closes.get(days[i + 3])! / closes.get(d)!)); });
  const r3 = days.slice(3).map((d, i) => Math.log(closes.get(d)! / closes.get(days[i])!));
  const hr = pts.slice(1).map((p, i) => Math.log(p.px / pts[i].px));
  out.push({
    ...a, reserve: r.reserve, maxLtv: Number(r.maxLtv), collateralDepositedUsd: Number(r.totalSupplyUsd), debtBorrowedInMarketUsd: debt,
    mint: { program: 'spl-token', decimals: mint.decimals, supply: mint.supply, mintAuthority: mint.mintAuthority, freezeAuthority: mint.freezeAuthority, extensions: (mint.extensions ?? []).map((e: { extension: string }) => e.extension) },
    history: { source: 'Kamino API reserve history, assetOraclePriceUSD, hourly', from: day(pts[0].t), to: day(pts.at(-1)!.t), points: pts.length, first: pts[0].px, last: pts.at(-1)!.px },
    returns: {
      daily: { n: dr.length, mean: dr.reduce((s, x) => s + x, 0) / dr.length, std: std(dr), min: Math.min(...dr), max: Math.max(...dr), downDays: dr.filter((x) => x < 0).length },
      friToMon: { n: wk.length, min: wk.length ? Math.min(...wk) : null, max: wk.length ? Math.max(...wk) : null },
      worst3Day: Math.min(...r3), hourlyStd: std(hr), hourlyMin: Math.min(...hr),
    },
  });
}
mkdirSync(join(import.meta.dirname, '../../data/nav'), { recursive: true });
writeFileSync(join(import.meta.dirname, '../../data/nav/nav-assets.json'), JSON.stringify({ generatedAt: new Date().toISOString(), note: 'read-only mainnet data; see README, "NAV-priced assets (D4)"', assets: out }, null, 1) + '\n');
console.log(JSON.stringify(out, null, 1).slice(0, 3000));
