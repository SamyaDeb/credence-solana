// Railway data host: every read-only mainnet job in one container, writing to one volume mounted at data/ (a Railway
// volume belongs to one service, and these jobs share their files). Nothing here holds a key or signs; every job reads
// mainnet through MAINNET_RPC only.
//
//   always on   record-prices.ts, record-prices-more.ts (restarted 30 s after any exit)
//   every 10 m  gap-feed-mainnet.ts
//   every 6 h   positions.ts, then unlock.ts (not while a shadow run is live: memory)
//   every 10 m  site-snapshot.ts (data/site/snapshot.json), a minute after the gap feed
//   closures    capture-scope.ts over [close − 2 m, close + 15 m] and [open − 2 m, open + 15 m] of every weekend or
//               holiday closure (36 h or longer, the XNYS calendar decides); shadow.ts from the closure's last session
//               open until its summary says done
//
// On start, the image's data/ (seed/data) is copied onto the volume: inputs (onchain, calendars, sigma, …) are refreshed,
// the jobs' own outputs are never overwritten. Logs go to stdout, one prefix per job; no job logs a secret.
//
// HTTP (PORT), read-only, for the Vercel site (DATA_HOST_URL): /snapshot.json and /gap-feed.json (the files as written),
// /unlock.json (the latest unlock analysis without its per-position rows) and /candidates.json (the latest scan's
// near-threshold candidates, app/src/lib/scan-candidates.ts). Nothing else on the volume is served.
//
// Usage (the image's CMD): scripts/node_modules/.bin/tsx deploy/railway/runner.ts
import { type ChildProcess, spawn } from 'node:child_process';
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { type ScanFile, candidates } from '../../app/src/lib/scan-candidates';

const ROOT = new URL('../../', import.meta.url).pathname;
const SEED = join(ROOT, 'seed/data');
const DATA = join(ROOT, 'data');
const TSX = join(ROOT, 'scripts/node_modules/.bin/tsx');
const BIN = join(ROOT, 'target/release/examples');
/** The jobs' own outputs: kept on the volume across deploys. */
const OUTPUTS = new Set(['live', 'shadow', 'positions', 'unlock', 'site']);
const MIN_CLOSURE_SECS = 36 * 3600;
const HOUR = 3600_000;

const log = (job: string, line: string) => console.log(`${new Date().toISOString()} [${job}] ${line}`);

function seed() {
  if (!existsSync(SEED)) return;
  for (const name of readdirSync(SEED)) {
    cpSync(join(SEED, name), join(DATA, name), { recursive: true, force: !OUTPUTS.has(name), errorOnExist: false });
  }
  log('runner', 'data seeded');
}

const env = {
  ...process.env,
  SHADOW_ROOT: ROOT,
  UNLOCK_QUOTE_BIN: join(BIN, 'unlock_quote'),
  CREDENCE_COMMIT: process.env.CREDENCE_COMMIT ?? (existsSync(join(ROOT, 'COMMIT')) ? readFileSync(join(ROOT, 'COMMIT'), 'utf8').trim() : 'unknown'),
};

function run(job: string, cwd: string, args: string[], timeoutMs?: number): { child: ChildProcess; done: Promise<number> } {
  const child = spawn(TSX, args, { cwd: join(ROOT, cwd), env, stdio: ['ignore', 'pipe', 'pipe'] });
  const pipe = (s: NodeJS.ReadableStream | null) => {
    let buf = '';
    s?.on('data', (d: Buffer) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const l of lines) if (l.trim()) log(job, l);
    });
  };
  pipe(child.stdout);
  pipe(child.stderr);
  const timer = timeoutMs ? setTimeout(() => { log(job, `timed out after ${timeoutMs / 60_000} min, killing`); child.kill('SIGTERM'); }, timeoutMs) : null;
  const done = new Promise<number>((res) => child.on('exit', (code) => { if (timer) clearTimeout(timer); res(code ?? 1); }));
  return { child, done };
}

/** A process that should always run: restarted 30 s after it exits. */
async function always(job: string, cwd: string, args: string[]) {
  for (;;) {
    log(job, 'start');
    const code = await run(job, cwd, args).done;
    log(job, `exited ${code}, restarting in 30 s`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

const running = new Set<string>();
/** Runs a job once unless the same job is still running. */
async function once(job: string, cwd: string, args: string[], timeoutMs: number) {
  if (running.has(job)) return;
  running.add(job);
  log(job, 'start');
  try {
    const code = await run(job, cwd, args, timeoutMs).done;
    log(job, `exited ${code}`);
  } finally {
    running.delete(job);
  }
}

type Session = { date: number; open: number; close: number };
const sessions = (): Session[] => JSON.parse(readFileSync(join(DATA, 'onchain/calendar-XNYS.json'), 'utf8')).sessions;

/** Weekend and holiday closures: the session before, and the open after. */
function closures(): { id: number; lastOpen: number; close: number; open: number }[] {
  const s = sessions();
  const out = [];
  for (let i = 0; i + 1 < s.length; i++) {
    if (s[i + 1].open - s[i].close >= MIN_CLOSURE_SECS) out.push({ id: s[i].date, lastOpen: s[i].open, close: s[i].close, open: s[i + 1].open });
  }
  return out;
}

const iso = (t: number) => new Date(t * 1000).toISOString();
const shadowDone = (id: number) => {
  try { return readFileSync(join(DATA, 'shadow', String(id), 'summary.json'), 'utf8').includes('"phase": "done"'); } catch { return false; }
};

const last: Record<string, number> = {};
const every = (job: string, ms: number, now: number) => {
  if (now - (last[job] ?? 0) < ms) return false;
  last[job] = now;
  return true;
};

async function tick() {
  const now = Date.now();
  const nowS = Math.floor(now / 1000);

  for (const c of closures()) {
    for (const [kind, t] of [['close', c.close], ['open', c.open]] as const) {
      const from = t - 120, to = t + 900;
      if (nowS >= from && nowS < to) {
        void once(`capture-scope-${kind}-${c.id}`, 'scripts', ['src/capture-scope.ts', '--from', iso(Math.max(from, nowS)), '--to', iso(to)], (to - nowS + 120) * 1000);
      }
    }
    if (nowS >= c.lastOpen && nowS < c.open + 3600 && !shadowDone(c.id)) {
      // Resumes from data/shadow/<closure>/state.json after a restart.
      void once(`shadow-${c.id}`, 'keeper', ['src/shadow.ts', '--closure', String(c.id)], (c.open + 7200 - nowS) * 1000);
    }
  }

  if (every('gap-feed', 10 * 60_000, now)) void once('gap-feed', 'scripts', ['src/gap-feed-mainnet.ts'], 10 * 60_000);
  // The scan peaks near 560 MB and the shadow keeper holds about as much (it scans too, every tick): together they pass
  // the service's 1 GB, so the scan waits out the weekend's shadow run.
  const shadowRunning = [...running].some((j) => j.startsWith('shadow-'));
  if (!shadowRunning && every('positions', 6 * HOUR, now)) {
    void (async () => {
      await once('positions', 'scripts', ['src/positions.ts'], HOUR);
      await once('unlock', 'scripts', ['src/unlock.ts'], HOUR);
    })();
  }
  // A minute after each gap feed (the snapshot copies it).
  last['site-snapshot'] ??= now - 9 * 60_000;
  if (every('site-snapshot', 10 * 60_000, now)) void once('site-snapshot', 'scripts', ['src/site-snapshot.ts'], 10 * 60_000);
}

/** The files the site reads as written; nothing else on the volume is served. */
const PUBLISHED: Record<string, string> = { '/snapshot.json': 'site/snapshot.json', '/gap-feed.json': 'live/gap-feed-mainnet.json' };

const newest = (dir: string, re: RegExp) => {
  try { return readdirSync(join(DATA, dir)).filter((f) => re.test(f)).sort().pop() ?? null; } catch { return null; }
};
/** Documents derived from the MB-sized outputs, rebuilt when the newest file changes. */
const derived = new Map<string, { key: string; body: Buffer; mtime: Date }>();
function derive(path: string, dir: string, re: RegExp, make: (rel: string, doc: unknown) => unknown) {
  const f = newest(dir, re);
  if (!f) return null;
  const abs = join(DATA, dir, f);
  const st = statSync(abs);
  const key = `${f}:${st.mtimeMs}`;
  const hit = derived.get(path);
  if (hit?.key === key) return hit;
  const out = { key, body: Buffer.from(JSON.stringify(make(`data/${dir}/${f}`, JSON.parse(readFileSync(abs, 'utf8'))))), mtime: st.mtime };
  derived.set(path, out);
  return out;
}
const DERIVED: Record<string, () => { body: Buffer; mtime: Date } | null> = {
  '/unlock.json': () => derive('/unlock.json', 'unlock', /^unlock-\d{8}\.json$/, (file, d) => ({ file, ...(d as object), positions: undefined })),
  '/candidates.json': () => derive('/candidates.json', 'positions', /^positions-\d+\.json$/, (file, d) => candidates(file, d as ScanFile)),
};

function serve() {
  const port = Number(process.env.PORT ?? 8080);
  createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
    if (path === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }).end('ok'); return; }
    let doc: { body: Buffer; mtime: Date } | null = null;
    try {
      const file = PUBLISHED[path];
      if (file && existsSync(join(DATA, file))) doc = { body: readFileSync(join(DATA, file)), mtime: statSync(join(DATA, file)).mtime };
      else if (DERIVED[path]) doc = DERIVED[path]();
    } catch (e) {
      log('runner', `serving ${path} failed: ${e instanceof Error ? e.message : e}`);
    }
    if (!doc) { res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}'); return; }
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'public, max-age=60',
      'last-modified': doc.mtime.toUTCString(),
      'x-content-type-options': 'nosniff',
    }).end(req.method === 'HEAD' ? undefined : doc.body);
  }).listen(port, () => log('runner', `serving the published files on :${port}`));
}

function main() {
  seed();
  serve();
  if (!process.env.MAINNET_RPC) {
    log('runner', 'MAINNET_RPC is not set: every job reads mainnet through it. Set the variable on the service; idling.');
    setInterval(() => {}, HOUR);
    return;
  }
  const forever = '2100-01-01T00:00:00Z';
  void always('record-prices', 'scripts', ['src/record-prices.ts', '--until', forever]);
  void always('record-prices-more', 'scripts', ['src/record-prices-more.ts', '--until', forever]);
  void tick();
  setInterval(() => void tick().catch((e) => log('runner', `tick failed: ${e instanceof Error ? e.message : e}`)), 30_000);
}

main();
