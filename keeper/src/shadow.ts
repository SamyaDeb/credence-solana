// Shadow keeper (W6): what Credence would have done over a real weekend, read from mainnet, logged, never sent.
//
// Every TICK_SECS from now until the weekend's end (Monday open + 1 h), for every obligation Phase 1 cover accepts
// (one SPYx/QQQx/NVDAx deposit + one USDC borrow, borrow factor 100%, both xStocks markets; the scan of
// scripts/src/positions.ts, refreshed), it logs to data/shadow/<closure>/:
//   meta.json        parameters, times, sources (written at start)
//   heartbeat.jsonl  one line per tick: phase, slot, positions, timings, errors
//   prices.jsonl     Kamino's Scope price and the Pyth push update (fair value) per asset, every tick
//   positions.jsonl  per-position state when it changes, plus full snapshots (bell, close, hourly, window, open)
//   book.jsonl       premiums from the program's own pricing (`shadow_quote`): hourly before the bell, final at it
//   events.jsonl     Scope's first move, shield advances, positions turning liquidatable, the backstop's would-be
//                    buys (klend's bonus rule), the Scope close and settlement prices, each covered payout
//   summary.json     running totals, rewritten every tick; state.json lets a restart resume where it stopped
//
// Read-only by construction: this file imports no Keypair, wallet or chain.ts (which builds the keeper's wallet), and
// it reaches the RPC only through `ReadOnlyRpc`, which exposes reads and nothing else. app/test/shadow-model.test.ts
// fails if a signer or a send method appears in the shadow files.
//
// Usage: cargo build -p credence-core --example shadow_quote --release
//        pnpm -C keeper shadow [--closure 20261009] [--once]      (scripts/live/shadow.sh runs it unattended)
import { config } from 'dotenv';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Connection, PublicKey } from '@solana/web3.js';
import { LendingMarket, Obligation, Reserve } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';
import { redact } from './redact.js';
import {
  type LiqParams, type Phase, SF, SHIELD, type Timeline, decodePush, decodeScope, fairValue, liquidation, phase,
  timeline, toWad, usdc, value,
} from './shadow-model.js';

const ROOT = new URL('../../', import.meta.url).pathname;
config({ path: join(ROOT, '.env'), quiet: true });
const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const CLOSURE = Number(arg('--closure') ?? 20261009);
const ONCE = process.argv.includes('--once');
const TICK_SECS = Number(process.env.SHADOW_TICK_SECS ?? 60);
const RESCAN_SECS = 2 * 3600;
const SNAPSHOT_SECS = 3600;
/** Model vault for the premiums (the backtest's): $2M of LP equity; each policy covers the whole debt. */
const MODEL_EQUITY_USDC = 2_000_000_000_000n;

const KLEND = new PublicKey('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD');
const MARKETS: Record<string, string> = {
  '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua': 'xStocks',
  '8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr': 'Sentora',
};
const SCOPE = new PublicKey('3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH');
type Sym = 'SPYx' | 'QQQx' | 'NVDAx';
const ASSETS: Record<Sym, { mint: string; chain: number; push: string; feed: string }> = {
  SPYx: { mint: 'XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W', chain: 344, push: '27Tv3HxU34AKxZ8MgfFAA1gCbWa96msMG5BvSWAHkBfj', feed: '2817b78438c769357182c04346fddaad1178c82f4048828fe0997c3c64624e14' },
  QQQx: { mint: 'Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ', chain: 347, push: 'BMcyd2UQqakGbWnNRAC67TLAFhV64dzLVeEyRHKyzmUi', feed: '178a6f73a5aede9d0d682e86b0047c9f333ed0efe5c6537ca937565219c4054d' },
  NVDAx: { mint: 'Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh', chain: 332, push: 'VSgf6jkwrcs9jbLuR57iN1Gk2c68vT9stZe8G6GGix2', feed: '4244d07890e4610f46bbde67de8f43a4bf8b569eebe904f136b469f148503b7f' },
};
const SYMS = Object.keys(ASSETS) as Sym[];
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDC_CHAIN = 13;
const DEFAULT = '11111111111111111111111111111111';

/** The only door to the RPC: reads. No method here can send, sign or simulate a transaction. */
class ReadOnlyRpc {
  readonly #c: Connection;
  readonly label: string;
  constructor(url: string) {
    this.#c = new Connection(url, 'confirmed');
    this.label = redact(url);
  }
  slot() { return this.#c.getSlot('confirmed'); }
  async accounts(keys: PublicKey[]) {
    const out = [];
    for (let i = 0; i < keys.length; i += 100) out.push(...(await this.#c.getMultipleAccountsInfo(keys.slice(i, i + 100), 'confirmed')));
    return out;
  }
  obligations(market: string) {
    return this.#c.getProgramAccounts(KLEND, {
      commitment: 'confirmed',
      filters: [{ dataSize: Obligation.layout.span + 8 }, { memcmp: { offset: 32, bytes: market } }],
    });
  }
  reserves(market: string) {
    return this.#c.getProgramAccounts(KLEND, {
      commitment: 'confirmed',
      filters: [{ dataSize: Reserve.layout.span + 8 }, { memcmp: { offset: 32, bytes: market } }],
    });
  }
}

/** The program's pricing (`examples/shadow_quote.rs`), one JSON line per request. */
class Quote {
  #queue: ((v: Record<string, unknown>) => void)[] = [];
  #proc = spawn(join(ROOT, 'target/release/examples/shadow_quote'), ['--root', ROOT], { stdio: ['pipe', 'pipe', 'inherit'] });
  ready: Promise<Record<string, unknown>>;
  constructor() {
    const lines = createInterface({ input: this.#proc.stdout });
    this.ready = new Promise((res) => this.#queue.push(res));
    lines.on('line', (l) => this.#queue.shift()?.(JSON.parse(l)));
    this.#proc.on('exit', (code) => { log({ kind: 'fatal', message: `shadow_quote exited ${code}` }); process.exit(1); });
  }
  ask(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((res) => { this.#queue.push(res); this.#proc.stdin.write(JSON.stringify(req) + '\n'); });
  }
}

const OUT = process.env.SHADOW_OUT ?? join(ROOT, 'data/shadow', String(CLOSURE));
mkdirSync(OUT, { recursive: true });
const iso = (t: number) => new Date(t * 1000).toISOString();
const write = (file: string, row: Record<string, unknown>) =>
  appendFileSync(join(OUT, file), JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? v.toString() : v)) + '\n');
const log = (row: Record<string, unknown>) => write('heartbeat.jsonl', { at: new Date().toISOString(), ...row });
const event = (now: number, kind: string, row: Record<string, unknown>) => write('events.jsonl', { at: iso(now), kind, ...row });

type ReserveInfo = {
  key: string; market: string; symbol: string; decimals: number; ltPct: number; bfPct: number;
  rateBsf: bigint; exchangeRate: number;
  minBonusBps: number; maxBonusBps: number; badDebtBonusBps: number;
};
type Cover = { covered: string; debt: string; cap: string; premium?: string; utilAfterWad?: string; refused?: string };
type Pos = {
  ob: string; market: string; owner: string; sym: Sym; depReserve: string; borReserve: string; elevationGroup: number;
  cTokens: string; borrowedSf: string; ownRateBsf: string; ltGroup: number;
  cover?: Cover;
  /** Shield advance so far, USDC base units (the program's `Policy.advanced`). */
  advanced: string;
  liquidatableAt?: number; liquidatableShieldedAt?: number;
  payout?: string;
  last?: string;
};
type State = {
  closure: number;
  positions: Record<string, Pos>;
  lastScan: number; lastSnapshot: number; lastQuote: number;
  bookFinal: boolean;
  close: Partial<Record<Sym, { priceWad: string; price: number; ts: number }>>;
  firstMove: Partial<Record<Sym, { at: number; price: number; ts: number }>>;
  settle: Partial<Record<Sym, { priceWad: string; price: number; ts: number }>>;
  marks: Partial<Record<'window' | 'deadline' | 'open' | 'close' | 'bell', boolean>>;
  totals: Record<string, number>;
};

const bsf = (v: { value: { toString(): string }[] }) =>
  v.value.reduce<bigint>((acc, limb, i) => acc + (BigInt(limb.toString()) << BigInt(64 * i)), 0n);
const usdOfSf = (sf: { toString(): string }) => Number(BigInt(sf.toString())) / SF;

async function main() {
  const rpc = new ReadOnlyRpc(process.env.MAINNET_RPC ?? '');
  const sessions = JSON.parse(readFileSync(join(ROOT, 'data/onchain/calendar-XNYS.json'), 'utf8')).sessions;
  const t: Timeline = timeline(sessions, CLOSURE);
  const quote = new Quote();
  const ready = await quote.ready;
  const statePath = join(OUT, 'state.json');
  const st: State = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, 'utf8'))
    : { closure: CLOSURE, positions: {}, lastScan: 0, lastSnapshot: 0, lastQuote: 0, bookFinal: false, close: {}, firstMove: {}, settle: {}, marks: {}, totals: {} };
  writeFileSync(join(OUT, 'meta.json'), JSON.stringify({
    kind: 'credence.shadow.v1', closure: CLOSURE, startedAt: new Date().toISOString(), resumed: existsSync(statePath),
    rpc: rpc.label, tickSecs: TICK_SECS,
    timeline: Object.fromEntries(Object.entries(t).map(([k, v]) => [k, k === 'closureId' ? v : iso(v as number)])),
    shield: { ...SHIELD, rule: 'pricing::shield_target: min(⌊α·cap⌋, realized_payout(⌈C′/(1+h)⌉, D, cap, close, ⌈fair·(1−b)⌉))' },
    premium: { source: 'pricing::premium + capacity via examples/shadow_quote.rs (deployed Phase 1 parameters)', modelVaultEquityUsdc: MODEL_EQUITY_USDC.toString(), cap: 'debt', order: 'obligation pubkey', sigmaWad: ready.sigmaWad },
    prices: { kamino: 'Scope OraclePrices 3t4JZcue… chains SPYx 344, QQQx 347, NVDAx 332, USDC 13', fair: 'Pyth pro-compatible push accounts Crypto.<T>X/USD', settlement: 'Scope read refreshed in [open + 60 s, open + 6 min] (post_settlement, SCOPE)', close: 'Scope read refreshed in [close − 60 s, close + 15 min]' },
    backstop: 'klend liquidation rule as read from source (shadow-model.ts::liquidation); first liquidation round at the first tick a position is liquidatable',
    sendsTransactions: false,
  }, null, 2) + '\n');

  let reserves: Record<string, ReserveInfo> = {};
  let liqMarket: Record<string, Omit<LiqParams, 'collMinBonusBps' | 'collMaxBonusBps' | 'collBadDebtBonusBps' | 'debtMinBonusBps' | 'debtMaxBonusBps' | 'debtBadDebtBonusBps' | 'emodeMaxBonusBps'> & { emode: Record<number, number> }> = {};

  async function scan(now: number) {
    reserves = {};
    for (const m of Object.keys(MARKETS)) {
      for (const a of await rpc.reserves(m)) {
        const r = Reserve.decode(a.account.data);
        const dec = Number(r.liquidity.mintDecimals.toString());
        const toBase = (x: { toString(): string }) => Number(BigInt(x.toString()) >> 60n);
        const supplyBase = Number(r.liquidity.totalAvailableAmount.toString()) + toBase(r.liquidity.borrowedAmountSf)
          - toBase(r.liquidity.accumulatedProtocolFeesSf) - toBase(r.liquidity.accumulatedReferrerFeesSf) - toBase(r.liquidity.pendingReferrerFeesSf);
        const cSupply = Number(r.collateral.mintTotalSupply.toString());
        const mint = r.liquidity.mintPubkey;
        reserves[a.pubkey.toBase58()] = {
          key: a.pubkey.toBase58(), market: m, decimals: dec,
          symbol: mint === USDC_MINT ? 'USDC' : (SYMS.find((s) => ASSETS[s].mint === mint) ?? mint),
          ltPct: r.config.liquidationThresholdPct, bfPct: Number(r.config.borrowFactorPct.toString()),
          rateBsf: bsf(r.liquidity.cumulativeBorrowRateBsf), exchangeRate: cSupply > 0 ? supplyBase / cSupply : 1,
          minBonusBps: r.config.minLiquidationBonusBps, maxBonusBps: r.config.maxLiquidationBonusBps, badDebtBonusBps: r.config.badDebtLiquidationBonusBps,
        };
      }
    }
    const marketAccts = await rpc.accounts(Object.keys(MARKETS).map((m) => new PublicKey(m)));
    Object.keys(MARKETS).forEach((m, i) => {
      const lm = LendingMarket.decode(marketAccts[i]!.data);
      liqMarket[m] = {
        closeFactorPct: Number(lm.liquidationMaxDebtCloseFactorPct.toString()),
        insolvencyLtvPct: Number(lm.insolvencyRiskUnhealthyLtvPct.toString()),
        minFullLiquidationUsd: Number(lm.minFullLiquidationValueThreshold.toString()),
        maxAtOnceUsd: Number(lm.maxLiquidatableDebtMarketValueAtOnce.toString()),
        emode: Object.fromEntries(lm.elevationGroups.map((g) => [g.id, g.maxLiquidationBonusBps])),
      };
    });
    let found = 0;
    for (const m of Object.keys(MARKETS)) {
      for (const a of await rpc.obligations(m)) {
        const o = Obligation.decode(a.account.data);
        const deps = o.deposits.filter((d) => d.depositReserve !== DEFAULT);
        const bors = o.borrows.filter((b) => b.borrowReserve !== DEFAULT);
        if (deps.length !== 1 || bors.length !== 1) continue;
        const dr = reserves[deps[0].depositReserve];
        const br = reserves[bors[0].borrowReserve];
        if (!dr || !br || !SYMS.includes(dr.symbol as Sym) || br.symbol !== 'USDC' || br.bfPct !== 100) continue;
        const key = a.pubkey.toBase58();
        found++;
        const prev = st.positions[key];
        st.positions[key] = {
          ...prev,
          ob: key, market: m, owner: o.owner, sym: dr.symbol as Sym, depReserve: dr.key, borReserve: br.key,
          elevationGroup: o.elevationGroup,
          cTokens: deps[0].depositedAmount.toString(), borrowedSf: bors[0].borrowedAmountSf.toString(),
          ownRateBsf: bsf(bors[0].cumulativeBorrowRateBsf).toString(),
          ltGroup: usdOfSf(o.depositedValueSf) > 0 ? usdOfSf(o.unhealthyBorrowValueSf) / usdOfSf(o.depositedValueSf) : 0,
          advanced: prev?.advanced ?? '0',
        };
      }
    }
    st.lastScan = now;
    return found;
  }

  /** Re-reads the tracked obligations (deposits, borrows) between full scans. */
  async function refreshTracked() {
    const keys = Object.keys(st.positions);
    const accts = await rpc.accounts(keys.map((k) => new PublicKey(k)));
    keys.forEach((k, i) => {
      const a = accts[i];
      const p = st.positions[k];
      if (!a || a.data.length === 0) { p.cTokens = '0'; p.borrowedSf = '0'; return; }
      const o = Obligation.decode(a.data);
      const d = o.deposits.find((x) => x.depositReserve === p.depReserve);
      const b = o.borrows.find((x) => x.borrowReserve === p.borReserve);
      p.cTokens = d ? d.depositedAmount.toString() : '0';
      p.borrowedSf = b ? b.borrowedAmountSf.toString() : '0';
      if (b) p.ownRateBsf = bsf(b.cumulativeBorrowRateBsf).toString();
    });
  }

  /** Collateral tokens, debt (USDC) and LT of a position now. Debt accrues to its reserve's cumulative borrow rate. */
  function amounts(p: Pos) {
    const dr = reserves[p.depReserve];
    const br = reserves[p.borReserve];
    const tokens = (Number(p.cTokens) * dr.exchangeRate) / 10 ** dr.decimals;
    const own = BigInt(p.ownRateBsf);
    const sf = own > 0n ? (BigInt(p.borrowedSf) * br.rateBsf) / own : BigInt(p.borrowedSf);
    const debt = Number(sf >> 60n) / 10 ** br.decimals;
    const lt = p.elevationGroup !== 0 && p.ltGroup > 0 ? p.ltGroup : dr.ltPct / 100;
    return { tokens, debt, lt };
  }

  function liqParams(p: Pos): LiqParams {
    const m = liqMarket[p.market];
    const dr = reserves[p.depReserve];
    const br = reserves[p.borReserve];
    return {
      closeFactorPct: m.closeFactorPct, insolvencyLtvPct: m.insolvencyLtvPct, minFullLiquidationUsd: m.minFullLiquidationUsd, maxAtOnceUsd: m.maxAtOnceUsd,
      collMinBonusBps: dr.minBonusBps, collMaxBonusBps: dr.maxBonusBps, collBadDebtBonusBps: dr.badDebtBonusBps,
      debtMinBonusBps: br.minBonusBps, debtMaxBonusBps: br.maxBonusBps, debtBadDebtBonusBps: br.badDebtBonusBps,
      emodeMaxBonusBps: p.elevationGroup !== 0 ? (m.emode[p.elevationGroup] ?? 0) : 0,
    };
  }

  async function tick() {
    const started = Date.now();
    const now = Math.floor(started / 1000);
    const ph: Phase = phase(t, now);
    const errors: string[] = [];
    let slot = 0;
    try { slot = await rpc.slot(); } catch (e) { errors.push(`slot: ${redact(String(e)).slice(0, 160)}`); }
    // 1. Positions: full scan every RESCAN_SECS and once right after the bell, else re-read the tracked ones.
    try {
      const bellScan = now >= t.bell && st.lastScan < t.bell;
      if (now - st.lastScan >= RESCAN_SECS || bellScan || Object.keys(reserves).length === 0) {
        // Positions found after the bell are watched but never covered: sales stop at the bell (INV-3).
        log({ kind: 'scan', positions: await scan(now) });
      } else {
        await refreshTracked();
        // reserves: exchange and borrow rates move with every refresh on mainnet
        const keys = [...new Set(Object.values(st.positions).flatMap((p) => [p.depReserve, p.borReserve]))];
        const accts = await rpc.accounts(keys.map((k) => new PublicKey(k)));
        keys.forEach((k, i) => {
          const a = accts[i];
          if (!a) return;
          const r = Reserve.decode(a.data);
          reserves[k].rateBsf = bsf(r.liquidity.cumulativeBorrowRateBsf);
        });
      }
    } catch (e) {
      errors.push(`positions: ${redact(String(e)).slice(0, 160)}`);
    }

    // 2. Prices: Scope (Kamino's view) and the Pyth push accounts (weekend fair value).
    const prices: Record<string, unknown> = {};
    const scope: Partial<Record<Sym | 'USDC', ReturnType<typeof decodeScope>>> = {};
    const fair: Partial<Record<Sym, ReturnType<typeof fairValue>>> = {};
    try {
      const accts = await rpc.accounts([SCOPE, ...SYMS.map((s) => new PublicKey(ASSETS[s].push))]);
      const sd = accts[0]!.data;
      scope.USDC = decodeScope(sd, USDC_CHAIN);
      SYMS.forEach((s, i) => {
        scope[s] = decodeScope(sd, ASSETS[s].chain);
        const push = decodePush(accts[i + 1]!.data);
        fair[s] = fairValue(push, ASSETS[s].feed, now);
        prices[s] = { scope: scope[s]!.price, scopeTs: scope[s]!.ts, push: push.price, pushConf: push.conf, pushPublish: push.publishTime, pushFull: push.full, fairOk: fair[s]!.ok, ...(fair[s]!.ok ? {} : { fairWhy: (fair[s] as { why: string }).why }) };
      });
      prices.USDC = scope.USDC.price;
      write('prices.jsonl', { at: iso(now), slot, phase: ph, ...prices });
    } catch (e) {
      errors.push(`prices: ${redact(String(e)).slice(0, 160)}`);
    }

    const ready = Object.keys(reserves).length > 0 && scope.USDC !== undefined;
    let watched = 0;
    if (ready) {
      // 3. Close and settlement prices (the keeper's SCOPE windows), and the moment Scope first moves.
      for (const s of SYMS) {
        const sp = scope[s]!;
        if (!st.close[s] && now >= t.close && sp.ts >= t.close - 60 && sp.ts <= t.close + 15 * 60) {
          st.close[s] = { priceWad: sp.priceWad.toString(), price: sp.price, ts: sp.ts };
          event(now, 'close', { sym: s, price: sp.price, scopeTs: iso(sp.ts) });
        }
        const c = st.close[s];
        if (c && !st.firstMove[s] && sp.priceWad.toString() !== c.priceWad && now > t.close) {
          st.firstMove[s] = { at: now, price: sp.price, ts: sp.ts };
          event(now, 'scope-first-move', { sym: s, close: c.price, price: sp.price, move: sp.price / c.price - 1, scopeTs: iso(sp.ts) });
        }
        if (c && !st.settle[s] && sp.ts >= t.settleFrom && sp.ts <= t.settleTo) {
          st.settle[s] = { priceWad: sp.priceWad.toString(), price: sp.price, ts: sp.ts };
          event(now, 'settlement-price', { sym: s, close: c.price, settle: sp.price, gap: sp.price / c.price - 1, scopeTs: iso(sp.ts) });
        }
      }

      // 4. Value every position at Kamino's price; cover terms at the bell (C′ and D as buy_cover snapshots them).
      const rows = Object.values(st.positions).sort((a, b) => a.ob.localeCompare(b.ob));
      const usdcPx = scope.USDC!.price;
      const cur = new Map<string, { tokens: number; debt: number; lt: number; v: ReturnType<typeof value> }>();
      for (const p of rows) {
        if (!reserves[p.depReserve] || !reserves[p.borReserve]) continue;
        const a = amounts(p);
        cur.set(p.ob, { ...a, v: value(a.tokens, scope[p.sym]!.price, a.lt, a.debt * usdcPx) });
        if (a.debt > 0 && a.tokens > 0) watched++;
      }
      const terms = (p: Pos) => {
        const c = cur.get(p.ob)!;
        return { ticker: p.sym, covered: usdc(c.v.coveredUsd / usdcPx, 'down'), debt: usdc(c.debt, 'up'), cap: usdc(c.debt, 'up') };
      };
      const quoteBook = async (final: boolean) => {
        const book = rows.filter((p) => cur.get(p.ob) && cur.get(p.ob)!.debt > 0 && cur.get(p.ob)!.tokens > 0);
        const r = await quote.ask({ op: 'book', equityUsdc: MODEL_EQUITY_USDC.toString(), positions: book.map((p) => ({ id: p.ob, ...terms(p) })) });
        if (r.error) throw new Error(`book: ${r.error}`);
        const prem = r.premiums as { id: string; premium?: string; utilAfterWad?: string; refused?: string }[];
        prem.forEach((q, i) => {
          const p = book[i];
          if (final) p.cover = { ...terms(p), premium: q.premium, utilAfterWad: q.utilAfterWad, refused: q.refused };
        });
        const sold = prem.filter((q) => q.premium);
        const total = sold.reduce((x, q) => x + Number(q.premium), 0) / 1e6;
        write('book.jsonl', {
          at: iso(now), final, positions: book.length, sold: sold.length, refused: prem.length - sold.length,
          premiumsUsd: total, reservedWorstLossUsdc: r.reservedWorstLoss,
          premiums: prem.map((q, i) => ({ ob: book[i].ob, sym: book[i].sym, ratio: cur.get(book[i].ob)!.v.ratio, debtUsd: cur.get(book[i].ob)!.debt, premium: q.premium ?? null, refused: q.refused })),
        });
        if (final) Object.assign(st.totals, { covered: sold.length, premiumsUsd: total, coveredDebtUsd: sold.reduce((x, q) => x + Number(book.find((p) => p.ob === q.id)!.cover!.debt), 0) / 1e6 });
        st.lastQuote = now;
      };
      try {
        if (ph === 'pre-bell' && now - st.lastQuote >= SNAPSHOT_SECS) await quoteBook(false);
        if (!st.bookFinal && now >= t.bell) { await quoteBook(true); st.bookFinal = true; event(now, 'book-final', { covered: st.totals.covered, premiumsUsd: st.totals.premiumsUsd }); }
      } catch (e) {
        errors.push(`book: ${String(e).slice(0, 160)}`);
      }

      // 5. Shield (window only): the target from the program's own `shield_target` at the push fair value.
      const covered = rows.filter((p) => p.cover?.premium && cur.get(p.ob));
      if (ph === 'shield-window') {
        const items = covered.filter((p) => st.close[p.sym] && fair[p.sym]?.ok);
        if (items.length > 0) {
          const r = await quote.ask({
            op: 'shield', alphaWad: toWad(SHIELD.alpha), bufferWad: toWad(SHIELD.buffer), healthWad: toWad(SHIELD.health),
            items: items.map((p) => ({ covered: p.cover!.covered, debt: p.cover!.debt, cap: p.cover!.cap, closeWad: st.close[p.sym]!.priceWad, fairWad: (fair[p.sym] as { priceWad: bigint }).priceWad.toString() })),
          });
          if (r.error) errors.push(`shield: ${r.error}`);
          else (r.targets as string[]).forEach((target, i) => {
            const p = items[i];
            const add = BigInt(target) - BigInt(p.advanced);
            if (add > 0n) {
              const f = fair[p.sym] as { price: number; publishTime: number };
              event(now, 'shield-advance', { ob: p.ob, sym: p.sym, amountUsd: Number(add) / 1e6, advancedUsd: Number(target) / 1e6, capUsd: Number(p.cover!.cap) / 1e6, fair: f.price, fairPublish: iso(f.publishTime), close: st.close[p.sym]!.price, ratioAtScope: cur.get(p.ob)!.v.ratio });
              p.advanced = target;
            }
          });
        }
      }

      // 6. Liquidatable at Kamino's price, with and without the shield, and the backstop's would-be buy.
      if (now >= t.close) {
        for (const p of rows) {
          const c = cur.get(p.ob);
          if (!c || c.debt <= 0 || c.tokens <= 0) continue;
          if (c.v.ratio >= 1 && !p.liquidatableAt) {
            p.liquidatableAt = now;
            const l = liquidation(c.v, c.tokens, liqParams(p));
            event(now, 'liquidatable', { ob: p.ob, sym: p.sym, covered: !!p.cover?.premium, ratio: c.v.ratio, debtUsd: c.v.debtUsd, collateralUsd: c.v.collateralUsd, scope: scope[p.sym]!.price, backstop: l });
          }
          const adv = Number(p.advanced) / 1e6;
          if (adv > 0) {
            const vs = value(c.tokens, scope[p.sym]!.price, c.lt, (c.debt - adv) * usdcPx);
            if (vs.ratio >= 1 && !p.liquidatableShieldedAt) {
              p.liquidatableShieldedAt = now;
              event(now, 'liquidatable-despite-shield', { ob: p.ob, sym: p.sym, ratio: vs.ratio, advancedUsd: adv, backstop: liquidation(vs, c.tokens, liqParams(p)) });
            }
          }
        }
      }

      // 7. Settlement: each covered position's Gap Cover payout at the real open, net of its shield advance.
      const pending = covered.filter((p) => p.payout === undefined && st.settle[p.sym] && st.close[p.sym]);
      if (pending.length > 0) {
        const r = await quote.ask({ op: 'payout', items: pending.map((p) => ({ covered: p.cover!.covered, debt: p.cover!.debt, cap: p.cover!.cap, closeWad: st.close[p.sym]!.priceWad, settleWad: st.settle[p.sym]!.priceWad })) });
        if (r.error) errors.push(`payout: ${r.error}`);
        else (r.payouts as string[]).forEach((pay, i) => {
          const p = pending[i];
          p.payout = pay;
          const fin = BigInt(pay);
          const adv = BigInt(p.advanced);
          event(now, 'payout', { ob: p.ob, sym: p.sym, finalUsd: Number(fin) / 1e6, advancedUsd: Number(adv) / 1e6, remainderUsd: Number(fin > adv ? fin - adv : 0n) / 1e6, shieldLossUsd: Number(adv > fin ? adv - fin : 0n) / 1e6 });
        });
      }

      // 8. Per-position log: a row when its amounts or flags change (tokens, debt to the cent, cover, advance,
      // liquidatable), full snapshots at the marks and hourly. D/C′ at any tick follows from prices.jsonl and the row's
      // tokens, debt and LT, so a price move alone does not write a row.
      const marks: [keyof State['marks'], boolean][] = [['bell', now >= t.bell], ['close', now >= t.close + 15 * 60], ['window', now >= t.shieldStart], ['deadline', now >= t.shieldDeadline], ['open', now >= t.settleTo]];
      const mark = marks.find(([k, on]) => on && !st.marks[k])?.[0];
      const snapshot = mark !== undefined || now - st.lastSnapshot >= SNAPSHOT_SECS;
      for (const p of rows) {
        const c = cur.get(p.ob);
        if (!c) continue;
        const row = {
          ob: p.ob, sym: p.sym, market: MARKETS[p.market], tokens: +c.tokens.toFixed(8), debtUsd: +c.debt.toFixed(2),
          lt: c.lt, covered: !!p.cover?.premium, advancedUsd: Number(p.advanced) / 1e6, liquidatable: c.v.ratio >= 1,
        };
        const key = JSON.stringify(row);
        if (snapshot || key !== p.last) {
          write('positions.jsonl', { at: iso(now), snapshot: snapshot ? (mark ?? 'hourly') : undefined, ...row, ratio: +c.v.ratio.toFixed(4) });
        }
        p.last = key;
      }
      if (mark) st.marks[mark] = true;
      if (snapshot) st.lastSnapshot = now;

      // Totals.
      const ev = (f: (p: Pos) => boolean) => rows.filter(f).length;
      Object.assign(st.totals, {
        watched,
        shieldAdvances: ev((p) => BigInt(p.advanced) > 0n),
        shieldAdvancedUsd: rows.reduce((x, p) => x + Number(p.advanced), 0) / 1e6,
        liquidatable: ev((p) => !!p.liquidatableAt),
        liquidatableCovered: ev((p) => !!p.liquidatableAt && !!p.cover?.premium),
        savedByShield: ev((p) => !!p.liquidatableAt && BigInt(p.advanced) > 0n && !p.liquidatableShieldedAt),
        payouts: ev((p) => p.payout !== undefined && BigInt(p.payout) > 0n),
        payoutsUsd: rows.reduce((x, p) => x + Number(p.payout ?? 0), 0) / 1e6,
      });
    }

    writeFileSync(statePath, JSON.stringify(st) + '\n');
    writeFileSync(join(OUT, 'summary.json'), JSON.stringify({
      at: iso(now), phase: ph, closure: CLOSURE, totals: st.totals, close: st.close, firstMove: st.firstMove, settle: st.settle,
      sendsTransactions: false,
    }, null, 2) + '\n');
    log({ phase: ph, slot, tracked: Object.keys(st.positions).length, watched, ms: Date.now() - started, errors });
    return ph;
  }

  for (;;) {
    const started = Date.now();
    let ph: Phase = 'pre-bell';
    try {
      ph = await tick();
    } catch (e) {
      log({ kind: 'error', message: redact(String(e)).slice(0, 300) }); // never exit on a bad tick; the next one retries
    }
    if (ONCE || ph === 'done') break;
    // A tick starts every TICK_SECS (a slow RPC read eats into the wait, not the cadence).
    await new Promise((r) => setTimeout(r, Math.max(1000, TICK_SECS * 1000 - (Date.now() - started))));
  }
  process.exit(0);
}

main().catch((e) => { log({ kind: 'fatal', message: redact(String(e)).slice(0, 300) }); process.exit(1); });
