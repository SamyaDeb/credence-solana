// The Friday alerts' server-side store (C4a.2): small JSON files under data/alerts/ (git-ignored, mode 600), each
// written whole (temp file + rename) under a lock file. The app's subscribe routes write the same files
// through this same module (app/src/app/api/alerts/_lib/store.ts imports it); nonces are the app's alone.
//   subscribers.json        {subscribers: [{wallet, channel, channelId, threshold, createdAt}]}   the minimum: no name,
//                           no IP; channelId is the Telegram chat id or the browser's push subscription
//   codes/<CODE>.json       {chatId, expiresAt}   Telegram link codes, written by the bot poller, consumed once by the app
//   sent-<closureId>.json   {<hash>: {at, attempts, ok}}   the job's ledger, keyed by a hash (no wallet or chat id)
//   telegram-offset.json    {offset}
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Channel = 'telegram' | 'webpush';
export type Subscriber = { wallet: string; channel: Channel; channelId: string; threshold: number; createdAt: string };

/** data/alerts under the repo root; ALERTS_DIR overrides it. The app passes its own root (this module is also bundled
 * into the app's routes, where import.meta.url is not this file). */
export const alertsDir = (root = join(/* turbopackIgnore: true */ dirname(fileURLToPath(import.meta.url)), '../..')) => process.env.ALERTS_DIR ?? join(/* turbopackIgnore: true */ root, 'data/alerts');

export function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(readFileSync(/* turbopackIgnore: true */ file, 'utf8')) as T; } catch { return fallback; }
}

export function writeJsonAtomic(file: string, value: unknown) {
  mkdirSync(/* turbopackIgnore: true */ join(/* turbopackIgnore: true */ file, '..'), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(/* turbopackIgnore: true */ tmp, JSON.stringify(value, null, 1), { mode: 0o600 });
  renameSync(/* turbopackIgnore: true */ tmp, file);
}

/** Runs `fn` holding `<dir>/<name>` (O_EXCL); a lock older than `staleMs` is stale and taken over. */
export async function withLock<T>(dir: string, fn: () => T | Promise<T>, name = '.lock', staleMs = 10_000, tries = 200): Promise<T> {
  mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true, mode: 0o700 });
  const lock = join(/* turbopackIgnore: true */ dir, name);
  for (let i = 0; ; i++) {
    try {
      closeSync(openSync(/* turbopackIgnore: true */ lock, 'wx', 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      try { if (Date.now() - statSync(/* turbopackIgnore: true */ lock).mtimeMs > staleMs) rmSync(/* turbopackIgnore: true */ lock, { force: true }); } catch { /* gone */ }
      if (i > tries) throw new Error(`alerts store is locked (${name})`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  try { return await fn(); } finally { rmSync(/* turbopackIgnore: true */ lock, { force: true }); }
}

export const readSubscribers = (dir: string): Subscriber[] =>
  readJson<{ subscribers: Subscriber[] }>(join(/* turbopackIgnore: true */ dir, 'subscribers.json'), { subscribers: [] }).subscribers;

export async function updateSubscribers(dir: string, fn: (s: Subscriber[]) => Subscriber[]) {
  return withLock(dir, () => {
    const next = fn(readSubscribers(dir));
    writeJsonAtomic(join(/* turbopackIgnore: true */ dir, 'subscribers.json'), { subscribers: next });
    return next;
  });
}

/** A Telegram link code: 8 characters of base32 (no 0/1/8/9 lookalikes), valid 15 minutes. */
export const CODE_RE = /^[A-Z2-7]{8}$/;
export function newCode(): string {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  return [...randomBytes(8)].map((b) => A[b & 31]).join('');
}
/** Writes a link code for `chatId`, after removing expired codes and that chat's earlier ones (one live code per
 * chat). False, nothing written, when `maxPending` codes are already live (audit A-119). */
export function writeCode(dir: string, code: string, chatId: string, ttlSecs = 900, now = Date.now(), maxPending = 500): boolean {
  const codes = join(/* turbopackIgnore: true */ dir, 'codes');
  mkdirSync(/* turbopackIgnore: true */ codes, { recursive: true, mode: 0o700 });
  let live = 0;
  for (const f of readdirSync(/* turbopackIgnore: true */ codes)) {
    if (!/^[A-Z2-7]{8}\.json$/.test(f)) continue;
    const c = readJson<{ chatId: string; expiresAt: number } | null>(join(/* turbopackIgnore: true */ codes, f), null);
    if (!c || c.expiresAt <= Math.floor(now / 1000) || c.chatId === chatId) {
      try { unlinkSync(/* turbopackIgnore: true */ join(/* turbopackIgnore: true */ codes, f)); } catch { /* consumed meanwhile */ }
    } else live++;
  }
  if (live >= maxPending) return false;
  writeJsonAtomic(join(/* turbopackIgnore: true */ codes, `${code}.json`), { chatId, expiresAt: Math.floor(now / 1000) + ttlSecs });
  return true;
}

/** The ledger key of one alert: a hash of the destination and the position (the ledger holds no personal data). */
export const ledgerKey = (s: Pick<Subscriber, 'wallet' | 'channel' | 'channelId'>, position: string) =>
  createHash('sha256').update(`${s.wallet}|${s.channel}|${s.channelId}|${position}`).digest('hex').slice(0, 32);

export type Ledger = Record<string, { at: string; attempts: number; ok: boolean }>;
export const ledgerFile = (dir: string, closureId: number) => join(/* turbopackIgnore: true */ dir, `sent-${closureId}.json`);

/** Consumes a link code once: its chat id, or null when unknown, used or expired (the unlink decides a race). */
export function consumeCode(dir: string, code: string, nowSecs: number): string | null {
  if (!CODE_RE.test(code)) return null;
  const file = join(/* turbopackIgnore: true */ dir, 'codes', `${code}.json`);
  const c = readJson<{ chatId: string; expiresAt: number } | null>(file, null);
  if (!c) return null;
  try { unlinkSync(/* turbopackIgnore: true */ file); } catch { return null; }
  return c.expiresAt > nowSecs && /^-?\d{1,20}$/.test(c.chatId) ? c.chatId : null;
}
