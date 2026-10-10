// The hedge venue: Hyperliquid's HIP-3 `xyz` dex (equity and index perps, trading around the clock), TESTNET ONLY.
// The constructor refuses any base URL that is not the testnet's. The key is an API (agent) wallet's: it can trade but not
// withdraw. Margin sits in that wallet's account on the venue: the trust assumption the program bounds (README, "Hedging").
//
// Order rules used here (Hyperliquid docs, "Tick and lot size", "Signing"): a perp price has at most 5 significant figures and
// at most 6 − szDecimals decimals; a size has at most szDecimals decimals; a HIP-3 asset id is
// 100000 + perpDexIndex × 10000 + the index in the dex's `meta`. An IOC limit order at the mid ± a band stands for a market
// order. Isolated margin is always used (several xyz markets allow nothing else).
import { addressOf, signAction } from './hl-sign.js';
import type { CloseResult, Fill, HedgeLegOrder, HedgeVenue, OpenResult, Position } from './venue.js';

export const TESTNET_URL = 'https://api.hyperliquid-testnet.xyz';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export type HlOptions = {
  key: string;
  base?: string;
  dex?: string;
  fetchFn?: typeof fetch;
  /** Venue time source (ms), injectable for tests. */
  now?: () => number;
  /** IOC price band around the mid. */
  band?: number;
  leverage?: number;
};

/** 5 significant figures, at most `6 − szDecimals` decimals, no trailing zeros. */
export function fmtPx(px: number, szDecimals: number): string {
  const maxDec = Math.max(0, 6 - szDecimals);
  const sig = Number(px.toPrecision(5));
  return trim(sig.toFixed(maxDec));
}
/** Floor to `szDecimals` decimals. */
export function fmtSz(sz: number, szDecimals: number): string {
  const f = 10 ** szDecimals;
  return trim((Math.floor(sz * f + 1e-9) / f).toFixed(szDecimals));
}
const trim = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);

export class HyperliquidTestnet implements HedgeVenue {
  readonly name = 'hyperliquid-testnet-xyz';
  readonly address: string;
  private readonly key: string;
  private readonly base: string;
  private readonly dex: string;
  private readonly f: typeof fetch;
  private readonly now: () => number;
  private readonly band: number;
  private readonly leverage: number;
  private metaCache?: { dexIndex: number; universe: Json[] };
  private lastNonce = 0;

  constructor(o: HlOptions) {
    const base = (o.base ?? TESTNET_URL).replace(/\/$/, '');
    if (!/^https:\/\/api\.hyperliquid-testnet\.xyz$/.test(base) && !/^http:\/\/127\.0\.0\.1[:/]?/.test(base)) {
      throw new Error('the hedge venue is the testnet only: refusing to talk to ' + new URL(base).host);
    }
    if (!/^(0x)?[0-9a-fA-F]{64}$/.test(o.key)) throw new Error('HEDGE_TESTNET_KEY must be a 32-byte hex private key');
    this.key = o.key;
    this.address = addressOf(o.key);
    this.base = base;
    this.dex = o.dex ?? 'xyz';
    this.f = o.fetchFn ?? fetch;
    this.now = o.now ?? Date.now;
    this.band = o.band ?? 0.02;
    this.leverage = o.leverage ?? 3;
  }

  private async post(path: string, body: unknown): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
    const r = await this.f(this.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await r.text();
    if (!r.ok) throw new Error(`venue ${path} ${r.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`venue ${path}: not JSON: ${text.slice(0, 120)}`);
    }
  }
  private info(type: string, extra: Json = {}) {
    return this.post('/info', { type, ...extra });
  }

  private async meta() {
    if (this.metaCache) return this.metaCache;
    const dexes = (await this.info('perpDexs')) as (Json | null)[];
    const dexIndex = dexes.findIndex((d) => d?.name === this.dex);
    if (dexIndex < 0) throw new Error(`the venue has no dex "${this.dex}"`);
    const m = await this.info('meta', { dex: this.dex });
    this.metaCache = { dexIndex, universe: m.universe };
    return this.metaCache;
  }
  private async asset(instrument: string) {
    const { dexIndex, universe } = await this.meta();
    const i = universe.findIndex((u) => u.name === instrument);
    if (i < 0) throw new Error(`the venue does not list ${instrument}`);
    const u = universe[i];
    if (u.isDelisted) throw new Error(`${instrument} is delisted on this venue`);
    return { id: 100000 + dexIndex * 10000 + i, szDecimals: u.szDecimals as number, maxLeverage: u.maxLeverage as number };
  }

  private async exchange(action: Json) {
    // Strictly increasing nonce (ms), as the venue requires.
    this.lastNonce = Math.max(this.now(), this.lastNonce + 1);
    const nonce = this.lastNonce;
    const signature = signAction(this.key, action, nonce);
    const res = await this.post('/exchange', { action, nonce, signature });
    if (res.status !== 'ok') throw new Error(`venue rejected the request: ${typeof res.response === 'string' ? res.response : JSON.stringify(res).slice(0, 200)}`);
    return res.response;
  }

  private async mid(instrument: string): Promise<number> {
    const mids = (await this.info('allMids', { dex: this.dex })) as Record<string, string>;
    const m = Number(mids[instrument]);
    if (!(m > 0)) throw new Error(`no mid price for ${instrument}`);
    return m;
  }

  /** One IOC order; returns the fill or throws. */
  private async order(instrument: string, buy: boolean, sizeNum: number, reduceOnly: boolean) {
    const a = await this.asset(instrument);
    const mid = await this.mid(instrument);
    const px = fmtPx(buy ? mid * (1 + this.band) : mid * (1 - this.band), a.szDecimals);
    const sz = fmtSz(sizeNum, a.szDecimals);
    if (Number(sz) <= 0) throw new Error(`${instrument}: size rounds to zero`);
    if (!reduceOnly) {
      await this.exchange({ type: 'updateLeverage', asset: a.id, isCross: false, leverage: Math.min(this.leverage, a.maxLeverage) });
    }
    const resp = await this.exchange({
      type: 'order',
      orders: [{ a: a.id, b: buy, p: px, s: sz, r: reduceOnly, t: { limit: { tif: 'Ioc' } } }],
      grouping: 'na',
    });
    const st = resp?.data?.statuses?.[0];
    if (st?.error) throw new Error(`${instrument}: ${st.error}`);
    if (!st?.filled) throw new Error(`${instrument}: not filled (${JSON.stringify(st)})`);
    return { sz: st.filled.totalSz as string, px: st.filled.avgPx as string, wantedSz: sz };
  }

  async openHedge(legs: HedgeLegOrder[]): Promise<OpenResult[]> {
    const out: OpenResult[] = [];
    for (const l of legs) {
      await this.asset(l.instrument); // listed and not delisted, before anything is priced or sent
      const mid = await this.mid(l.instrument);
      const usd = Number(l.notional) / 1e6;
      const fill = await this.order(l.instrument, false, usd / mid, false);
      if (Number(fill.sz) < Number(fill.wantedSz)) throw new Error(`${l.instrument}: filled ${fill.sz} of ${fill.wantedSz}`);
      out.push({ ticker: l.ticker, instrument: l.instrument, filledSz: fill.sz, avgPx: fill.px, notional: BigInt(Math.round(Number(fill.sz) * Number(fill.px) * 1e6)) });
    }
    return out;
  }

  async closeHedge(instruments: string[]): Promise<CloseResult[]> {
    // Reduce-only IOC buys until the position is flat (a thin book or the price band can fill part of it); the average price is
    // weighted by size. A position still open after three rounds is an error, never a quiet partial close.
    const out: CloseResult[] = [];
    for (const ins of instruments) {
      let filled = 0, notional = 0, rounds = 0;
      for (;;) {
        const p = (await this.positions()).find((x) => x.instrument === ins);
        const sz = p ? Number(p.sz) : 0;
        if (sz === 0) break;
        if (++rounds > 3) throw new Error(`${ins}: still ${p!.sz} open after 3 close orders`);
        const fill = await this.order(ins, sz < 0, Math.abs(sz), true);
        filled += Number(fill.sz);
        notional += Number(fill.sz) * Number(fill.px);
      }
      if (filled > 0) out.push({ instrument: ins, filledSz: String(filled), avgPx: (notional / filled).toFixed(8) });
    }
    return out;
  }

  async listed(instruments: string[]): Promise<string[]> {
    const { universe } = await this.meta();
    return instruments.filter((n) => universe.some((u) => u.name === n && !u.isDelisted));
  }

  async positions(): Promise<Position[]> {
    const s = await this.info('clearinghouseState', { user: this.address, dex: this.dex });
    return (s.assetPositions ?? []).map((ap: Json) => ({
      instrument: ap.position.coin,
      sz: ap.position.szi,
      entryPx: ap.position.entryPx,
      marginUsed: ap.position.marginUsed,
    }));
  }

  async fills(sinceMs: number): Promise<Fill[]> {
    const fs = (await this.info('userFillsByTime', { user: this.address, startTime: sinceMs, aggregateByTime: false })) as Json[];
    return fs
      .filter((f) => typeof f.coin === 'string' && f.coin.startsWith(this.dex + ':'))
      .map((f) => ({
        instrument: f.coin,
        side: f.side === 'B' ? 'buy' : 'sell',
        px: f.px,
        sz: f.sz,
        time: f.time,
        fee: f.fee,
        closedPnl: f.closedPnl,
        oid: f.oid,
        hash: f.hash,
      }));
  }

  async funding(sinceMs: number, instruments: string[]): Promise<string> {
    const rows = (await this.info('userFunding', { user: this.address, startTime: sinceMs })) as Json[];
    let total = 0n;
    for (const r of rows) {
      if (!instruments.includes(r.delta?.coin)) continue;
      const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(String(r.delta.usdc));
      if (!m) continue;
      const v = BigInt(m[2]) * 10n ** 12n + BigInt((m[3] ?? '').padEnd(12, '0').slice(0, 12));
      total += m[1] ? -v : v;
    }
    const neg = total < 0n;
    const a = neg ? -total : total;
    return `${neg ? '-' : ''}${a / 10n ** 12n}.${(a % 10n ** 12n).toString().padStart(12, '0')}`;
  }
}
