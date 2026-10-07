// S7 (task 3.5): when do Kamino's xStock prices move around a weekend? Kamino API hourly reserve history
// (`assetPriceUSD`, Kamino's oracle price via Scope) for the last N weekends of SPYx/QQQx/NVDAx in the xStocks
// Market, plus the live recorder's Scope and Pyth events (data/live/events-*.jsonl) when present.
//
// Per weekend: the last hourly change before the Friday 16:00 ET close, how long the price stays flat, the first hour
// it moves again (and whether that is before the 9:30 ET open, i.e. pre-market), and the move from the Friday close
// level to the first post-open hour.
// Usage: pnpm tsx src/s7-history.ts [weekends=6]   → data/live/s7-history.json
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const MARKET = '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua';
const RESERVES: Record<string, string> = {
  SPYx: 'UvXjBuC7YZYaGB9Rn1PpBD1GySmjzunXgE8Zev9ua8d',
  QQQx: '2jerdAXR8r2B6z3P7P6VgSiePQX7wqcpbEqdDbm8mgeB',
  NVDAx: '7B66Az3tJhAo4bLkX8PzTixQ9ZGyHkkjxfVLhF26sP5q',
};
const N = Number(process.argv[2] ?? 6);
const iso = (t: number) => new Date(t).toISOString().slice(0, 16) + 'Z';

/** Fridays (UTC dates) of the last N completed weekends; US EDT until Nov 1, 2026 (close 20:00 UTC, open 13:30). */
function weekends(): { friday: string; close: number; open: number }[] {
  const out = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  while (d.getUTCDay() !== 5) d.setUTCDate(d.getUTCDate() - 1);
  for (let i = 0; out.length < N; i++) {
    const f = new Date(d.getTime() - i * 7 * 86_400_000);
    const close = Date.parse(f.toISOString().slice(0, 10) + 'T20:00:00Z');
    const open = close + (2 * 24 + 17.5) * 3_600_000; // Monday 13:30 UTC
    if (open + 6 * 3_600_000 > Date.now()) continue; // not finished
    out.push({ friday: f.toISOString().slice(0, 10), close, open });
  }
  return out.reverse();
}

async function history(reserve: string, start: number, end: number): Promise<{ t: number; p: number }[]> {
  const url = `https://api.kamino.finance/kamino-market/${MARKET}/reserves/${reserve}/metrics/history?env=mainnet-beta`
    + `&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}&frequency=hour`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Kamino API ${r.status}`);
  const j = (await r.json()) as { history: { timestamp: string; metrics: { assetPriceUSD: string } }[] };
  return j.history.map((h) => ({ t: Date.parse(h.timestamp), p: Number(h.metrics.assetPriceUSD) }));
}

async function main() {
  const rows = [];
  for (const w of weekends()) {
    for (const [sym, reserve] of Object.entries(RESERVES)) {
      const h = await history(reserve, w.close - 4 * 3_600_000, w.open + 4 * 3_600_000);
      const atClose = [...h].reverse().find((x) => x.t <= w.close);
      if (!atClose) continue;
      // Hours after the close whose price differs from the close level.
      const moves = h.filter((x) => x.t > w.close && x.p !== atClose.p);
      const firstMove = moves[0];
      const weekendMoves = moves.filter((x) => x.t < w.open - 6 * 3_600_000); // before Monday 07:30 UTC
      const firstAfterOpen = h.find((x) => x.t >= w.open + 30 * 60_000);
      const beforeOpen = [...h].reverse().find((x) => x.t <= w.open);
      rows.push({
        weekend: w.friday, sym,
        closeLevel: atClose.p,
        flatFrom: iso(atClose.t),
        firstMove: firstMove ? iso(firstMove.t) : null,
        firstMoveVsOpenHours: firstMove ? (firstMove.t - w.open) / 3_600_000 : null,
        movedOverWeekend: weekendMoves.length > 0,
        weekendMoves: weekendMoves.map((x) => ({ at: iso(x.t), price: x.p })),
        levelAtOpen: beforeOpen?.p ?? null,
        preMarketMove: beforeOpen ? beforeOpen.p / atClose.p - 1 : null,
        firstHourAfterOpen: firstAfterOpen ? { at: iso(firstAfterOpen.t), price: firstAfterOpen.p, vsClose: firstAfterOpen.p / atClose.p - 1 } : null,
      });
      console.log(`${w.friday} ${sym.padEnd(5)} flat from ${iso(atClose.t)} at ${atClose.p.toFixed(4)}; first move ${firstMove ? iso(firstMove.t) : '—'}`
        + ` (${firstMove ? ((firstMove.t - w.open) / 3_600_000).toFixed(1) : '?'} h vs open); weekend moves ${weekendMoves.length};`
        + ` at open ${rows.at(-1)!.preMarketMove !== null ? ((rows.at(-1)!.preMarketMove as number) * 100).toFixed(2) : '?'}%`);
    }
  }
  // Live recorder: Scope value changes and Pyth pushes, if any events were recorded.
  const dir = join(ROOT, 'data/live');
  const events = readdirSync(dir).filter((f) => /^events-\d+\.jsonl$/.test(f)).flatMap((f) =>
    readFileSync(join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));
  const live: Record<string, unknown> = {};
  for (const sym of Object.keys(RESERVES)) {
    const scope = events.filter((e) => e.kind === 'scope' && e.sym === sym);
    const changes = scope.filter((e, i) => i > 0 && e.price !== scope[i - 1].price);
    const pyth = events.filter((e) => e.kind === 'pyth' && e.sym === sym);
    live[sym] = {
      scopeUpdates: scope.length, scopeValueChanges: changes.length,
      firstScope: scope[0]?.at ?? null, lastScope: scope.at(-1)?.at ?? null,
      lastScopeValueChange: changes.at(-1)?.at ?? null,
      pythPushes: pyth.map((e) => ({ observed: e.at, publishTime: new Date(e.publishTime * 1000).toISOString(), price: e.price })),
    };
  }
  writeFileSync(join(ROOT, 'data/live/s7-history.json'), JSON.stringify({ generatedAt: new Date().toISOString(), source: 'api.kamino.finance reserves/metrics/history (hourly assetPriceUSD)', rows, live }, null, 2) + '\n');
  console.log(JSON.stringify(live, (k, v) => (k === 'pythPushes' ? (v as unknown[]).length : v), 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
