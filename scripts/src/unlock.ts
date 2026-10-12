// C1 credit unlock (plan/09 "Phase C, C1", method unlock.v1): how much more credit full Gap Cover with the Liquidation
// Shield would allow the scanned positions at a target D/C′ of 0.85 / 0.90 / 0.95, what it costs, and the LP equity it
// needs. What cover would allow, not measured demand.
//
// Every number comes from the program's pricing through `examples/unlock_quote.rs` (premiums, losses, probabilities,
// capacity, shield sizing); this script only reads the scan, converts it to base units, orders the book, sums and
// takes medians. Mainnet is read-only (borrow reserves for the APR); Jupiter's borrow rate comes from its vault API.
//
// Usage: pnpm tsx src/unlock.ts [--scan <path to positions-<yyyymmdd>.json>]   (default: the latest scan in data/positions)
//   → data/unlock/unlock-<yyyymmdd>.json and .md (date of the scan)
import { config } from 'dotenv';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { address, createSolanaRpc, getBase64Encoder } from '@solana/kit';
import { Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';
import { KaminoReserve } from '@kamino-finance/klend-sdk';
import { basisSigmaFor } from './basis.js';
import { redact } from './lib/redact.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });

export const METHOD = 'unlock.v1';
export const CAVEAT = 'What cover would allow, not measured demand.';
const TARGETS = [0.85, 0.9, 0.95];
const SLICES = [0.25, 0.5, 1];
/** Weekly closures a year: holiday weekends priced as plain weekends (an under-estimate for ~9 of them; plan/09). */
export const WEEKENDS_PER_YEAR = 52;
const WAD = 10n ** 18n;
const STABLES = new Set(['USDC', 'PYUSD']);
/** Extra-credit size buckets (USD, at least) for the cost by size. */
const SIZE_BUCKETS = [0, 1_000, 10_000, 100_000];
/** The deployed minimum premium before the shield loading (5 USDC). */
const MIN_PREMIUM = 5_000_000n;

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const rel = (p: string) => relative(ROOT, p);
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const readJ = <T>(p: string): T => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as T;
/** USD → USDC base units: covered values DOWN, debt UP (the program's snapshot rounding). */
const down = (usd: number) => BigInt(Math.floor(usd * 1e6));
const up = (usd: number) => BigInt(Math.ceil(usd * 1e6));
/** load-onchain.ts's `wad` (6 decimals of precision). */
const wad = (x: number) => (BigInt(Math.round(x * 1e6)) * WAD) / 1_000_000n;

type Dep = { symbol: string; reserve: string; valueUsd: number };
type KPos = {
  obligation: string; market: string; elevationGroup: number; eligibleB1: boolean; deposits: Dep[];
  borrows: { symbol: string; reserve: string; valueUsd: number }[]; debtUsd: number; coveredValueUsd: number; lastUpdateSlot: string;
};
type JPos = { position: string; vaultId: number; asset: string; debt: string; debtUsd: number; coveredValueUsd: number; eligibleB2: boolean };
type Scan = {
  summary: {
    generatedAt: string; b4: { after: { kamino: number; jupiterLend: number; both: number } };
    w4: { debtUsdEligibleB1: number; excludedB1ByReason: Record<string, number>; excludedB1ByUncoveredAsset: Record<string, number> };
    jupiterLend: { debtUsd: { eligible: number }; excludedB2ByReason: Record<string, number> };
  };
  positions: KPos[];
  jupiterLend: { positions: JPos[] };
};
type Leg = { ticker: string; covered: string };
export type HelperPos = { id: string; legs: Leg[]; stable: string; debt: string; multi: boolean };
type Row = {
  id: string; lender: 'kamino' | 'jupiter'; asset: string; path: 'single' | 'multi' | 'jupiter'; borrow: string;
  borrowReserve: string; pos: HelperPos; covered: bigint; debt: bigint;
};

/** The scan's eligible positions in base units, as the program's snapshot would take them. */
export function positionsFromScan(scan: Scan, reserves: Record<string, Record<string, { ltPct: number }>>): Row[] {
  const rows: Row[] = [];
  for (const p of scan.positions) {
    if (!p.eligibleB1) continue;
    const xs = p.deposits.filter((d) => !STABLES.has(d.symbol));
    const bor = p.borrows[0];
    // C′ per leg = value × the reserve's LT (rounded DOWN); a single-asset obligation in an elevation group uses its own
    // covered value (the group's LT), as the scan. Stablecoins: the rest of the scan's C′.
    const single = p.deposits.length === 1 && bor.symbol === 'USDC';
    const legs: Leg[] = single && p.elevationGroup !== 0
      ? [{ ticker: xs[0].symbol, covered: down(p.coveredValueUsd).toString() }]
      : xs.map((d) => ({ ticker: d.symbol, covered: down((d.valueUsd * reserves[d.symbol][p.market].ltPct) / 100).toString() }));
    const legSum = legs.reduce((a, l) => a + Number(l.covered) / 1e6, 0);
    const stable = xs.length === p.deposits.length ? 0n : down(Math.max(0, p.coveredValueUsd - legSum));
    const covered = legs.reduce((a, l) => a + BigInt(l.covered), 0n) + stable;
    const multi = !single;
    const asset = multi ? (bor.symbol === 'PYUSD' && xs.length === 1 && stable === 0n ? `${xs[0].symbol}` : 'multi') : xs[0].symbol;
    rows.push({
      id: p.obligation, lender: 'kamino', asset, path: multi ? 'multi' : 'single', borrow: bor.symbol, borrowReserve: bor.reserve,
      pos: { id: p.obligation, legs, stable: stable.toString(), debt: up(p.debtUsd).toString(), multi }, covered, debt: up(p.debtUsd),
    });
  }
  for (const p of scan.jupiterLend.positions) {
    if (!p.eligibleB2) continue;
    const t = `${p.asset}.J`;
    rows.push({
      id: p.position, lender: 'jupiter', asset: p.asset, path: 'jupiter', borrow: p.debt, borrowReserve: `jl-vault-${p.vaultId}`,
      pos: { id: p.position, legs: [{ ticker: t, covered: down(p.coveredValueUsd).toString() }], stable: '0', debt: up(p.debtUsd).toString(), multi: false },
      covered: down(p.coveredValueUsd), debt: up(p.debtUsd),
    });
  }
  return rows;
}

/** The helper: one JSON line in, one out. */
export class Helper {
  private queue: { res: (v: unknown) => void; rej: (e: Error) => void }[] = [];
  private proc;
  private dead: Error | null = null;
  ready: Promise<void>;
  constructor(bin: string) {
    this.proc = spawn(bin, ['--root', ROOT], { stdio: ['pipe', 'pipe', 'inherit'] });
    let first: () => void, fail: (e: Error) => void;
    this.ready = new Promise((r, j) => ((first = r), (fail = j)));
    let started = false;
    createInterface({ input: this.proc.stdout }).on('line', (l) => {
      if (!started) { started = true; first(); return; }
      this.queue.shift()?.res(JSON.parse(l));
    });
    // A helper that dies (a panic) rejects every pending call instead of leaving them unsettled (audit A-75).
    const die = (why: string) => {
      this.dead ??= new Error(`unlock_quote helper ${why}`);
      fail(this.dead);
      for (const q of this.queue.splice(0)) q.rej(this.dead);
    };
    this.proc.on('error', (e) => die(`failed: ${e.message}`));
    this.proc.on('exit', (code, sig) => die(`exited (code ${code}, signal ${sig})`));
  }
  async call<T>(req: unknown): Promise<T> {
    await this.ready;
    if (this.dead) throw this.dead;
    return new Promise((res, rej) => {
      this.queue.push({ res: (v) => ((v as { error?: string }).error ? rej(new Error((v as { error: string }).error)) : res(v as T)), rej });
      this.proc.stdin.write(JSON.stringify(req) + '\n');
    });
  }
  close() { this.proc.stdin.end(); }
}

export function buildHelper(): string {
  execFileSync('cargo', ['build', '-q', '-p', 'credence-core', '--example', 'unlock_quote', '--release'], { cwd: ROOT, stdio: 'inherit' });
  return join(ROOT, 'target/release/examples/unlock_quote');
}

/** σ_b per xStock, exactly as `load-onchain.ts` loads it. */
export function basisWad(): Record<string, string> {
  let study = null;
  try { study = readJ('data/shield-basis.json'); } catch { /* none */ }
  const assets = readJ<{ ticker: string; sigmaWad: string }[]>('data/onchain/assets.json');
  const sigma = Object.fromEntries(assets.map((a) => [a.ticker, Number(a.sigmaWad) / 1e18]));
  return Object.fromEntries(assets.map((a) => [a.ticker, wad(basisSigmaFor(a.ticker, study as never, sigma)).toString()]));
}

/** Borrow APR now: Kamino from each borrow reserve (klend-sdk's curve at its utilisation + the host fixed rate),
 * Jupiter from the vault API's `borrowRate` (bps). Read-only. */
async function borrowAprs(rows: Row[]): Promise<{ apr: Record<string, number>; source: Record<string, string>; slot: string }> {
  const rpc = createSolanaRpc(process.env.MAINNET_RPC ?? '');
  const apr: Record<string, number> = {};
  const source: Record<string, string> = {};
  const keys = [...new Set(rows.filter((r) => r.lender === 'kamino').map((r) => r.borrowReserve))];
  const accs = await rpc.getMultipleAccounts(keys.map((k) => address(k)), { encoding: 'base64', commitment: 'confirmed' }).send();
  // The slot the reserves were read at (audit A-80).
  const slot = accs.context.slot.toString();
  const b64 = getBase64Encoder();
  keys.forEach((k, i) => {
    const a = accs.value[i];
    if (!a) throw new Error(`reserve ${k} not found`);
    const state = Reserve.decode(Buffer.from(b64.encode(a.data[0]) as Uint8Array));
    const kr = new KaminoReserve(state as never, k as never, undefined as never, undefined as never, 400);
    apr[k] = kr.calculateBorrowRate() + kr.getFixedHostInterestRate().toNumber() * kr.rateAdjustmentFactor();
    source[k] = `kamino reserve ${k} at slot ${slot} (klend-sdk calculateBorrowRate + fixed host rate)`;
  });
  const vaults = (await (await fetch('https://api.jup.ag/lend/v1/borrow/vaults')).json()) as { id: number; borrowRate: string }[];
  const at = new Date().toISOString();
  for (const v of new Set(rows.filter((r) => r.lender === 'jupiter').map((r) => r.borrowReserve))) {
    const id = Number(v.replace('jl-vault-', ''));
    const x = vaults.find((y) => y.id === id);
    if (!x) throw new Error(`Jupiter vault ${id} not in the API`);
    apr[v] = Number(x.borrowRate) / 10_000;
    source[v] = `api.jup.ag/lend/v1/borrow/vaults id ${id} borrowRate ${x.borrowRate} bps at ${at}`;
  }
  return { apr, source, slot };
}

const hashOrder = (id: string) => createHash('sha256').update(id).digest('hex');
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const usd = (b: bigint) => Number(b) / 1e6;

type TargetRes = {
  targetWad: string; debt: string; extra: string; quote: { premium: string; loading: string; worstLoss: string; expectedLoss: string };
  pLiquidatable: { n: number; of: number }; residual: { basisSigmas: number; n: number; of: number; maxAdvance: string; inv12Capped: number }[];
};
type Analysed = { id: string; covered: string; pLiquidatable: { n: number; of: number }; history: { n: number; of: number }; targets: (TargetRes | null)[] };

async function main() {
  // The latest scan unless one is named; a named path resolves from the working directory (audit A-76).
  const scans = readdirSync(join(ROOT, 'data/positions')).filter((f) => /^positions-\d{8}\.json$/.test(f)).sort();
  const named = arg('--scan');
  const scanPath = named ? resolve(named) : join(ROOT, 'data/positions', scans[scans.length - 1] ?? 'none');
  const scan = JSON.parse(readFileSync(scanPath, 'utf8')) as Scan;
  const ageH = (Date.now() - Date.parse(scan.summary.generatedAt)) / 3.6e6;
  if (ageH > 24) throw new Error(`scan is ${ageH.toFixed(1)} h old: re-run positions.ts (read-only) first`);
  const reservesFile = join(ROOT, 'data/onchain/xstock-reserves.json');
  const reserves = (JSON.parse(readFileSync(reservesFile, 'utf8')) as { reserves: Record<string, Record<string, { ltPct: number }>> }).reserves;
  const rows = positionsFromScan(scan, reserves);

  // Reconciliation with the scan.
  const k = rows.filter((r) => r.lender === 'kamino');
  const j = rows.filter((r) => r.lender === 'jupiter');
  const recon = {
    kamino: { positions: k.length, scan: scan.summary.b4.after.kamino, debtUsd: usd(k.reduce((a, r) => a + r.debt, 0n)), scanDebtUsd: scan.summary.w4.debtUsdEligibleB1 },
    jupiter: { positions: j.length, scan: scan.summary.b4.after.jupiterLend, debtUsd: usd(j.reduce((a, r) => a + r.debt, 0n)), scanDebtUsd: scan.summary.jupiterLend.debtUsd.eligible },
    note: 'debt rounded UP to the USDC base unit per position: at most 1e-6 USD × positions above the scan',
  };
  for (const [l, v] of Object.entries(recon).filter(([x]) => x !== 'note') as [string, { positions: number; scan: number; debtUsd: number; scanDebtUsd: number }][]) {
    if (v.positions !== v.scan) throw new Error(`${l}: ${v.positions} positions, the scan says ${v.scan}`);
    if (Math.abs(v.debtUsd - v.scanDebtUsd) > v.positions * 1e-6 + 1e-6) throw new Error(`${l}: debt ${v.debtUsd} vs scan ${v.scanDebtUsd}`);
  }

  // UNLOCK_QUOTE_BIN: a prebuilt helper (the Railway data host has no cargo).
  const h = new Helper(process.env.UNLOCK_QUOTE_BIN ?? buildHelper());
  const basis = basisWad();
  await h.call({ op: 'init', basisWad: basis });
  const targetsWad = TARGETS.map((t) => wad(t).toString());
  const analysed: Analysed[] = [];
  for (let i = 0; i < rows.length; i += 100) {
    const r = await h.call<{ positions: Analysed[] }>({ op: 'analyse', positions: rows.slice(i, i + 100).map((x) => x.pos), targets: targetsWad });
    analysed.push(...r.positions);
    process.stderr.write(`\ranalysed ${analysed.length}/${rows.length}`);
  }
  process.stderr.write('\n');

  // Capacity per target: the unlocked book (positions below the target, at the target debt) in sha256(id) order.
  const cap: Record<string, unknown> = {};
  const bookPrem = new Map<string, Map<string, { premium: bigint; expectedLoss: bigint }>>();
  for (const [ti, t] of TARGETS.entries()) {
    const book = rows
      .map((r, i) => ({ r, a: analysed[i].targets[ti] }))
      .filter((x) => x.a)
      .sort((x, y) => (hashOrder(x.r.id) < hashOrder(y.r.id) ? -1 : 1));
    const total = book.reduce((s, x) => s + BigInt(x.a!.extra), 0n);
    let acc = 0n;
    const cum = book.map((x) => (acc += BigInt(x.a!.extra)));
    const prefixes = SLICES.map((f) => {
      const goal = (total * BigInt(Math.round(f * 1e6))) / 1_000_000n;
      const n = cum.findIndex((c) => c >= goal);
      return n < 0 ? book.length : n + 1;
    });
    const res = await h.call<{ slices: Record<string, unknown>[]; bookEquity: string; book: { id: string; premium?: string; expectedLoss?: string; refused?: boolean }[] }>({
      op: 'capacity', positions: book.map((x) => ({ ...x.r.pos, debt: x.a!.debt })), prefixes,
    });
    const m = new Map<string, { premium: bigint; expectedLoss: bigint }>();
    for (const b of res.book) {
      if (b.refused) throw new Error(`t ${t}: ${b.id} refused at the book's own equity`);
      m.set(b.id, { premium: BigInt(b.premium!), expectedLoss: BigInt(b.expectedLoss!) });
    }
    bookPrem.set(String(t), m);
    const premTotal = [...m.values()].reduce((s, x) => s + x.premium, 0n);
    const elTotal = [...m.values()].reduce((s, x) => s + x.expectedLoss, 0n);
    cap[String(t)] = {
      positions: book.length, extraDebtUsd: usd(total),
      slices: res.slices.map((s, i) => ({ share: SLICES[i], extraDebtUsd: usd(cum[(s.n as number) - 1] ?? 0n), ...s,
        equityUsd: usd(BigInt(s.equity as string)) })),
      bookEquityUsd: usd(BigInt(res.bookEquity)),
      lpLine: {
        premiumPerWeekendUsd: usd(premTotal), expectedLossPerWeekendUsd: usd(elTotal),
        grossYield: (usd(premTotal) * WEEKENDS_PER_YEAR) / usd(BigInt(res.bookEquity)),
        expectedLossRate: (usd(elTotal) * WEEKENDS_PER_YEAR) / usd(BigInt(res.bookEquity)),
      },
    };
  }
  h.close();

  const rates = await borrowAprs(rows);

  // Per position.
  const out = rows.map((r, i) => {
    const a = analysed[i];
    const apr = rates.apr[r.borrowReserve];
    return {
      id: r.id, lender: r.lender, asset: r.asset, path: r.path, borrow: r.borrow, legs: r.pos.legs, stable: r.pos.stable,
      covered: a.covered, debt: r.pos.debt, dc: Number(r.debt) / Number(r.covered || 1n), headroom: (r.covered - r.debt).toString(),
      pLiquidatable: a.pLiquidatable, history: a.history, borrowApr: apr,
      targets: Object.fromEntries(TARGETS.map((t, ti) => {
        const x = a.targets[ti];
        if (!x) return [String(t), null];
        const b = bookPrem.get(String(t))!.get(r.id)!;
        const extra = Number(x.extra) / 1e6;
        const annual = (Number(b.premium) / 1e6) * WEEKENDS_PER_YEAR / extra;
        return [String(t), { ...x, bookPremium: b.premium.toString(), bookExpectedLoss: b.expectedLoss.toString(),
          annualisedCost: annual, quoteAnnualisedCost: (Number(x.quote.premium) / 1e6) * WEEKENDS_PER_YEAR / extra, allIn: apr + annual }];
      })),
    };
  });

  // Aggregates per lender × asset × target, and totals.
  type O = (typeof out)[number];
  const group = (sel: (o: O) => boolean) => {
    const os = out.filter(sel);
    const debt = os.reduce((s, o) => s + BigInt(o.debt), 0n);
    const today = { liquidatableDebtWeighted: os.reduce((s, o) => s + (o.pLiquidatable.n / o.pLiquidatable.of) * Number(o.debt), 0) / Math.max(1, Number(debt)),
      positionsWithP: os.filter((o) => o.pLiquidatable.n > 0).length };
    const per = Object.fromEntries(TARGETS.map((t) => {
      const ts = os.map((o) => ({ o, x: o.targets[String(t)] })).filter((y) => y.x) as { o: O; x: NonNullable<O['targets'][string]> }[];
      const extra = ts.reduce((s, y) => s + BigInt(y.x.extra), 0n);
      const prem = ts.reduce((s, y) => s + BigInt(y.x.bookPremium), 0n);
      const premQ = ts.reduce((s, y) => s + BigInt(y.x.quote.premium), 0n);
      const tdebt = ts.reduce((s, y) => s + BigInt(y.x.debt), 0n);
      const dw = (f: (y: (typeof ts)[number]) => number) => ts.reduce((s, y) => s + f(y) * Number(y.x.debt), 0) / Math.max(1, Number(tdebt));
      const res = [0, -1, 1].map((k) => ({
        basisSigmas: k,
        debtWeighted: dw((y) => { const q = y.x.residual.find((z) => z.basisSigmas === k)!; return q.n / q.of; }),
        positionsWithP: ts.filter((y) => y.x.residual.find((z) => z.basisSigmas === k)!.n > 0).length,
        inv12Capped: ts.reduce((s, y) => s + y.x.residual.find((z) => z.basisSigmas === k)!.inv12Capped, 0),
      }));
      const xd = Number(extra) / 1e6;
      // The 5 USDC minimum premium dominates small positions: the cost by size of the extra credit.
      const bySize = Object.fromEntries(SIZE_BUCKETS.map((lo) => {
        const s = ts.filter((y) => Number(y.x.extra) / 1e6 >= lo);
        const e = s.reduce((a, y) => a + BigInt(y.x.extra), 0n);
        const pr = s.reduce((a, y) => a + BigInt(y.x.bookPremium), 0n);
        return [String(lo), { positions: s.length, extraDebtUsd: usd(e), annualisedCostMedian: median(s.map((y) => y.x.annualisedCost)),
          annualisedCostDebtWeighted: e > 0n ? (usd(pr) * WEEKENDS_PER_YEAR) / usd(e) : null }];
      }));
      const minPremium = ts.filter((y) => BigInt(y.x.quote.premium) - BigInt(y.x.quote.loading) <= MIN_PREMIUM).length;
      return [String(t), {
        atMinimumPremium: minPremium, bySize,
        positions: ts.length, extraDebtUsd: xd, premiumPerWeekendUsd: usd(prem), quotePremiumPerWeekendUsd: usd(premQ),
        annualisedCostMedian: median(ts.map((y) => y.x.annualisedCost)),
        annualisedCostDebtWeighted: xd > 0 ? (usd(prem) * WEEKENDS_PER_YEAR) / xd : null,
        allInMedian: median(ts.map((y) => y.x.allIn)),
        allInDebtWeighted: xd > 0 ? ts.reduce((s, y) => s + y.o.borrowApr * (Number(y.x.extra) / 1e6), 0) / xd + (usd(prem) * WEEKENDS_PER_YEAR) / xd : null,
        pUncoveredAtTargetDebtWeighted: dw((y) => y.x.pLiquidatable.n / y.x.pLiquidatable.of),
        residual: res,
      }];
    }));
    return { positions: os.length, debtUsd: usd(debt), headroomUsd: usd(os.reduce((s, o) => s + BigInt(o.headroom), 0n)), today, targets: per };
  };
  const lenders = ['kamino', 'jupiter'] as const;
  const assets = [...new Set(out.map((o) => o.asset))].sort();
  const aggregates = {
    total: group(() => true),
    byLender: Object.fromEntries(lenders.map((l) => [l, group((o) => o.lender === l)])),
    byLenderAsset: Object.fromEntries(lenders.map((l) => [l, Object.fromEntries(assets.filter((a) => out.some((o) => o.lender === l && o.asset === a)).map((a) => [a, group((o) => o.lender === l && o.asset === a)]))])),
    pyusd: group((o) => o.borrow === 'PYUSD'),
  };

  const inputs = [scanPath, reservesFile, ...['data/onchain/assets.json', 'data/onchain/joint-v2.json', 'data/shield-basis.json', 'data/sigma/closure-gaps.json',
    ...readJ<{ ticker: string }[]>('data/onchain/assets.json').map((a) => `data/onchain/${a.ticker}-WEEKEND.json`)].map((p) => join(ROOT, p))]
    .filter((p) => existsSync(p)); // shield-basis.json is optional, as in basisWad() (audit A-81)
  const excluded = {
    kamino: scan.summary.w4.excludedB1ByReason, kaminoByUncoveredAsset: scan.summary.w4.excludedB1ByUncoveredAsset,
    jupiter: scan.summary.jupiterLend.excludedB2ByReason,
    note: 'CRCLx (no calibrated history), cbBTC and USDG deposits (not covered), multi-borrow and borrow factor ≠ 100% (not accepted by buy_cover_multi), JupUSD debt (not covered).',
  };
  const day = scan.summary.generatedAt.slice(0, 10).replaceAll('-', '');
  const doc = {
    kind: 'credence.unlock.v1', method: METHOD, caveat: CAVEAT, generatedAt: new Date().toISOString(), generatedBy: 'scripts/src/unlock.ts',
    scan: { file: rel(scanPath), generatedAt: scan.summary.generatedAt, slot: null, slotNote: 'the Oct 9 scan did not record a slot; per-obligation lastUpdateSlot is in each Kamino row of the scan', maxObligationSlot: scan.positions.filter((p) => p.eligibleB1).reduce((m, p) => (BigInt(p.lastUpdateSlot) > m ? BigInt(p.lastUpdateSlot) : m), 0n).toString() },
    inputs: Object.fromEntries(inputs.map((p) => [rel(p), sha(p)])),
    parameters: { targets: TARGETS, slices: SLICES, weekendsPerYear: WEEKENDS_PER_YEAR, saleOrder: 'sha256(position id) ascending', headlinePremium: 'book: the premium at the utilisation after each sale when the whole unlocked book sells at the equity it needs', basisWad: basis,
      deployed: 'θ 1, c 10%, η 1, β 97.5%, κ 0, min premium 5 USDC, u_max 50%, max asset share 50%, debt growth est 0.1% / cap 0.5%, shield α 50%, b 2%, h 0, λ 2, k 2' },
    rounding: 'Premiums, losses and capacity in USDC base units as the program rounds them; totals are sums of base units; medians on exact per-position values; USD in this file = base units / 1e6.',
    borrowApr: { slot: rates.slot, sources: rates.source, apr: rates.apr },
    reconciliation: recon, excluded, capacity: cap, aggregates, positions: out,
  };
  const dir = join(ROOT, 'data/unlock');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `unlock-${day}.json`), JSON.stringify(doc) + '\n');
  writeFileSync(join(dir, `unlock-${day}.md`), markdown(doc));
  console.log(`wrote data/unlock/unlock-${day}.json and .md`);
}

const pct = (x: number | null, d = 2) => (x == null ? '–' : `${(x * 100).toFixed(d)}%`);
const m$ = (x: number) => (x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${x.toFixed(0)}`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function markdown(d: any): string {
  const L: string[] = [];
  L.push(`# Credit unlock, scan ${d.scan.generatedAt.slice(0, 10)} (${d.method})`, '', `**${d.caveat}** Every number below is what full Gap Cover with the Liquidation Shield would allow at a target D/C′, priced by the program's own pricing; no borrower was asked and none is assumed to borrow more.`, '');
  L.push(`Scan: \`${d.scan.file}\` (${d.scan.generatedAt}). Generated by \`${d.generatedBy}\` at ${d.generatedAt}. Inputs hashed in the JSON.`, '');
  L.push('## Today, without cover', '', '| Lender | Positions | Debt | Headroom (C′ − D) | P(liquidatable after a weekend), debt-weighted | Positions with P > 0 |', '|---|---:|---:|---:|---:|---:|');
  for (const [l, g] of [['Kamino', d.aggregates.byLender.kamino], ['Jupiter Lend', d.aggregates.byLender.jupiter], ['Both', d.aggregates.total]] as [string, any][])
    L.push(`| ${l} | ${g.positions} | ${m$(g.debtUsd)} | ${m$(g.headroomUsd)} | ${pct(g.today.liquidatableDebtWeighted, 3)} | ${g.today.positionsWithP} |`);
  for (const t of Object.keys(d.capacity)) {
    L.push('', `## Target D/C′ ${t}`, '', '| Lender | Positions below target | Extra credit allowed | Premium / weekend (book) | Annualised cost: median · debt-weighted | All-in (borrow APR + cover): median · debt-weighted | P(liquidatable) at target, no cover | Residual P with cover + Shield (e = 0 · −σ_b · +σ_b) |', '|---|---:|---:|---:|---:|---:|---:|---:|');
    for (const [l, g] of [['Kamino', d.aggregates.byLender.kamino], ['Jupiter Lend', d.aggregates.byLender.jupiter], ['Both', d.aggregates.total]] as [string, any][]) {
      const x = g.targets[t];
      L.push(`| ${l} | ${x.positions} | ${m$(x.extraDebtUsd)} | ${m$(x.premiumPerWeekendUsd)} | ${pct(x.annualisedCostMedian)} · ${pct(x.annualisedCostDebtWeighted)} | ${pct(x.allInMedian)} · ${pct(x.allInDebtWeighted)} | ${pct(x.pUncoveredAtTargetDebtWeighted, 3)} | ${x.residual.map((r: any) => pct(r.debtWeighted, 4)).join(' · ')} |`);
    }
    const c = d.capacity[t];
    L.push('', `LP equity (u_max 50%, asset share 50%; sale order sha256(id)):`, '', '| Share of the unlocked book | Extra credit | LP equity needed | Binding rule | Closest to its concentration cap (equity it alone needs) |', '|---:|---:|---:|---|---|');
    for (const s of c.slices) {
      const top = (Object.entries(s.perAssetEquity) as [string, string][]).sort((a, b) => Number(BigInt(b[1]) - BigInt(a[1]))).slice(0, 2);
      L.push(`| ${pct(s.share, 0)} | ${m$(s.extraDebtUsd)} | ${m$(s.equityUsd)} | ${s.binding} | ${top.map(([k, v]) => `${k} ${m$(Number(v) / 1e6)}`).join(', ')} |`);
    }
    L.push('', `At 100%: premiums ${m$(c.lpLine.premiumPerWeekendUsd)} a weekend → gross ${pct(c.lpLine.grossYield, 1)} a year on ${m$(c.bookEquityUsd)} of LP equity; model expected loss ${pct(c.lpLine.expectedLossRate, 1)} a year (before Shield costs, fees and the Backstop).`);
    const tb = d.aggregates.total.targets[t];
    L.push('', `Cost by size of the extra credit (both lenders; ${tb.atMinimumPremium} of ${tb.positions} positions pay the 5 USDC minimum premium plus loading):`, '', '| Extra credit at least | Positions | Extra credit | Annualised cost: median · debt-weighted |', '|---:|---:|---:|---:|');
    for (const [lo, b] of Object.entries(tb.bySize) as [string, any][]) L.push(`| ${m$(Number(lo))} | ${b.positions} | ${m$(b.extraDebtUsd)} | ${pct(b.annualisedCostMedian)} · ${pct(b.annualisedCostDebtWeighted)} |`);
    L.push('', '| Lender · asset | Positions | Extra credit | Annualised cost: median · debt-weighted | All-in median | Residual P (e = +σ_b) |', '|---|---:|---:|---:|---:|---:|');
    for (const l of ['kamino', 'jupiter'])
      for (const [a, g] of Object.entries(d.aggregates.byLenderAsset[l]) as [string, any][]) {
        const x = g.targets[t];
        if (!x.positions) continue;
        L.push(`| ${l === 'kamino' ? 'Kamino' : 'Jupiter'} · ${a} | ${x.positions} | ${m$(x.extraDebtUsd)} | ${pct(x.annualisedCostMedian)} · ${pct(x.annualisedCostDebtWeighted)} | ${pct(x.allInMedian)} | ${pct(x.residual[2].debtWeighted, 4)} |`);
      }
  }
  L.push('', '## Assumptions', '',
    `- Full cover (cap = debt at the target), priced as \`quote_cover\` / \`quote_cover_multi\` / \`buy_cover_jl\` price it, shield loading included; headline premium at the vault fill that takes the whole unlocked book (the u = 0 quote is in the JSON).`,
    `- Annualised = premium × ${d.parameters.weekendsPerYear} / extra debt: holiday weekends priced as plain weekends (an under-estimate), overnight gaps not covered by weekend cover.`,
    '- P(liquidatable): the weekend gap alone, the asset\'s 3,000-point WEEKEND set at its σ (the app\'s `modelPays` rule) or, for multi-collateral, the joint set with each scenario one of 564 closures.',
    '- Residual: the Shield advances at a fair value f = open × (1 + e), capped at α × cap and the policy\'s reserved worst loss (INV-12); e = −σ_b means the Shield sees a price below the open (it advances more), +σ_b the adverse case. Jupiter residuals assume Jupiter\'s oracle takes the Sunday payback (plan/06 open item).',
    '- Borrow APR read now: Kamino from the borrow reserve, Jupiter from its vault API (sources in the JSON).',
    '', '## Not covered (outside every total)', '',
    `Kamino: ${Object.entries(d.excluded.kamino).map(([k, v]) => `${k} ${v}`).join(', ')}. Jupiter Lend: ${Object.entries(d.excluded.jupiter).map(([k, v]) => `${k} ${v}`).join(', ')}. ${d.excluded.note}`, '');
  return L.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(redact(String(e?.stack ?? e)));
    process.exit(1);
  });
}
