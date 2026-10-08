// GET: the Gap Oracle's live inputs, from the mainnet recorder's files (scripts/src/record-prices.ts, polling every
// 10 s): Kamino's Scope price per xStock with its refresh time and the last time its value changed, the newest Pyth
// `Crypto.<T>X/USD` push update (raw account, decoded here), the real Friday-close capture if it has landed
// (data/live/close-scope-<group>.json, written by scripts/live), and the S7 history (data/live/s7-history.json).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decodePriceUpdate } from '@/lib/credence';
import { ROOT, fail, json } from '@/lib/server/fork';

const SYMS = ['SPYx', 'QQQx', 'NVDAx'] as const;
type Ev = { at: string; kind: string; sym: string; price: number; ts: number };

function scopeEvents(): Ev[] {
  const dir = join(ROOT, 'data/live');
  const files = readdirSync(dir).filter((f) => /^events-\d+\.jsonl$/.test(f)).sort();
  const out: Ev[] = [];
  for (const f of files.slice(-4)) {
    for (const l of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!l.includes('"kind":"scope"')) continue;
      try { out.push(JSON.parse(l)); } catch { /* partial line while the recorder writes */ }
    }
  }
  return out;
}

export async function GET() {
  try {
    const evs = scopeEvents();
    const live = join(ROOT, 'data/live');
    const assets = SYMS.map((sym) => {
      const mine = evs.filter((e) => e.sym === sym);
      const last = mine.at(-1) ?? null;
      let lastChange: Ev | null = null;
      for (let i = mine.length - 1; i > 0; i--) {
        if (Math.abs(mine[i].price - mine[i - 1].price) > 1e-9) { lastChange = mine[i]; break; }
      }
      const pushFiles = readdirSync(join(live, 'pyth')).filter((f) => f.startsWith(`${sym}-`))
        .sort((a, b) => Number(a.split('-')[1].split('.')[0]) - Number(b.split('-')[1].split('.')[0]));
      const pf = pushFiles.at(-1);
      let push = null;
      if (pf) {
        const j = JSON.parse(readFileSync(join(live, 'pyth', pf), 'utf8'));
        const u = decodePriceUpdate(Buffer.from(j.account.data[0], 'base64'));
        push = { price: u.price, conf: u.conf, publishTime: u.publishTime, file: `data/live/pyth/${pf}`, recorded: pushFiles.length };
      }
      return { sym, scope: last && { price: last.price, refreshedAt: last.ts, readAt: last.at, readings: mine.length, since: mine[0].at,
        lastChange: lastChange && { price: lastChange.price, at: lastChange.at, ts: lastChange.ts } }, push };
    });
    const closes = readdirSync(live).filter((f) => /^close-scope-\d+\.json$/.test(f)).sort().map((f) => {
      const j = JSON.parse(readFileSync(join(live, f), 'utf8')) as { group: number; dryRun?: boolean; results: { ticker: string; closePriceWad: string; scopeRefreshedAt: number; closeTime: number; capture: string }[] };
      return { file: `data/live/${f}`, group: j.group, dryRun: !!j.dryRun, results: j.results };
    }).filter((c) => !c.dryRun);
    const s7 = existsSync(join(live, 's7-history.json')) ? JSON.parse(readFileSync(join(live, 's7-history.json'), 'utf8')) : null;
    const lastEvent = evs.at(-1)?.at ?? null;
    const recorderLog = join(live, 'recorder.log');
    return json({
      recorder: { lastEvent, logUpdated: existsSync(recorderLog) ? statSync(recorderLog).mtime.toISOString() : null },
      assets, closes,
      s7: s7 && { source: s7.source, generatedAt: s7.generatedAt, rows: s7.rows.map((r: Record<string, unknown>) => ({
        weekend: r.weekend, sym: r.sym, firstMove: r.firstMove, firstMoveVsOpenHours: r.firstMoveVsOpenHours, movedOverWeekend: r.movedOverWeekend,
        preMarketMove: r.preMarketMove, weekendMoves: Array.isArray(r.weekendMoves) ? (r.weekendMoves as unknown[]).length : 0,
      })) },
    });
  } catch (e) {
    return fail(e);
  }
}
