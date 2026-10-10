// The Friday alerts' subscription routes (C4a.2), as one handler so every check is tested without a server:
//   GET  /api/alerts/config        the Telegram bot's name and the VAPID public key (both public), if configured
//   GET  /api/alerts/nonce         a single-use nonce with its issue and expiry times (10 minutes)
//   POST /api/alerts/subscribe     {message, signature, subscription?}: the wallet's signed message (lib/actions/
//                                  alerts-message.ts); Telegram via a link code from the bot, web push via the browser's
//                                  PushSubscription (its endpoint's hash is in the signed message)
//   POST /api/alerts/unsubscribe   {message, signature}: the same flow
// The ed25519 signature is verified against the wallet named in the message; the domain must be this app's; the nonce
// must be one this server issued, unexpired and unused. Stored: wallet, channel, channel id, threshold, created_at
// (keeper/src/alerts-store.ts). Nothing personal is logged.
import { createPublicKey, randomBytes, verify } from 'node:crypto';
import { join } from 'node:path';
import { consumeCode, readJson, readSubscribers, updateSubscribers, withLock, writeJsonAtomic } from '../../../../../../keeper/src/alerts-store';
import { InputError, type RateLimiter, clientIp, parsePubkey, readJson as readBody } from '@/lib/actions/guard';
import { type AlertAction, MESSAGE_TTL_SECS, endpointHash, parseAlertMessage } from '@/lib/actions/alerts-message';

export type AlertsDeps = {
  dir: string;
  limiter: RateLimiter;
  /** The hosts a signed message may name (this app's), e.g. localhost:3000. */
  domains: string[];
  telegramBot: string | null;
  vapidPublicKey: string | null;
  now?: () => number;
  maxSubscribers?: number;
  maxPendingNonces?: number;
  /** The public read-only site (NEXT_PUBLIC_NETWORK=mainnet) issues no nonce and stores nothing (audit A-121). */
  network?: 'fork' | 'mainnet';
};

export type AlertsRoute = 'config' | 'nonce' | 'subscribe' | 'unsubscribe';

class Refused extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store', ...extra } });

/** Push services a subscription may point to: the keeper POSTs to the endpoint, so nothing else (no SSRF). */
export const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'push.apple.com', 'notify.windows.com'];
const pushHostOk = (h: string) => PUSH_HOSTS.some((s) => h === s || h.endsWith(`.${s}`));

type Nonces = Record<string, { issuedAt: string; expiresAt: string; used: boolean }>;

export async function handleAlerts(req: Request, route: AlertsRoute, deps: AlertsDeps): Promise<Response> {
  const nowMs = (deps.now ?? Date.now)();
  const wait = deps.limiter.take(clientIp(req), nowMs);
  if (wait !== null) return json({ error: 'too many requests; try again shortly' }, 429, { 'Retry-After': String(wait) });
  try {
    if (route === 'config') {
      if (req.method !== 'GET') throw new Refused('method not allowed', 405);
      return json({ telegramBot: deps.telegramBot, webPush: deps.vapidPublicKey, domain: deps.domains[0] ?? null });
    }
    if (deps.network === 'mainnet') throw new Refused('this public site is read-only: Friday alerts are set up on the local app (scripts/demo-app.sh)', 403);
    if (route === 'nonce') {
      if (req.method !== 'GET') throw new Refused('method not allowed', 405);
      return json(await issueNonce(deps, nowMs));
    }
    if (req.method !== 'POST') throw new Refused('method not allowed', 405);
    return json(await signed(req, route, deps, nowMs));
  } catch (e) {
    if (e instanceof Refused || e instanceof InputError) return json({ error: e.message }, e.status);
    console.error('[alerts] store or verification failure');
    return json({ error: 'alerts are unavailable right now' }, 503);
  }
}

async function issueNonce(deps: AlertsDeps, nowMs: number) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const nonce = [...randomBytes(24)].map((b) => A[b % 62]).join('');
  const issuedAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + MESSAGE_TTL_SECS * 1000).toISOString();
  await withLock(deps.dir, () => {
    const file = join(deps.dir, 'nonces.json');
    const all = readJson<Nonces>(file, {});
    for (const [k, v] of Object.entries(all)) if (Date.parse(v.expiresAt) < nowMs) delete all[k];
    if (Object.values(all).filter((v) => !v.used).length >= (deps.maxPendingNonces ?? 1000)) throw new Refused('too many pending sign-ins; try again shortly', 503);
    all[nonce] = { issuedAt, expiresAt, used: false };
    writeJsonAtomic(file, all);
  });
  return { nonce, issuedAt, expiresAt, domains: deps.domains };
}

const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');

export function verifySignature(message: string, signatureB64: string, wallet: string): boolean {
  if (typeof signatureB64 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signatureB64)) return false;
  const sig = Buffer.from(signatureB64, 'base64');
  if (sig.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, parsePubkey(wallet, 'wallet').toBuffer()]), format: 'der', type: 'spki' });
  return verify(null, Buffer.from(message, 'utf8'), key, sig);
}

async function signed(req: Request, route: Exclude<AlertsRoute, 'config' | 'nonce'>, deps: AlertsDeps, nowMs: number) {
  const body = await readBody(req, 4096);
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InputError('body: {message, signature}');
  const b = body as { message?: unknown; signature?: unknown; wallet?: unknown; subscription?: unknown };
  const m = parseAlertMessage(b.message as string);
  if (!m) throw new InputError('message: not a Credence alerts message');
  if (m.action !== (route as AlertAction)) throw new InputError(`message: an ${m.action} message sent to ${route}`);
  if (b.wallet !== undefined && b.wallet !== m.wallet) throw new Refused('the message is for another wallet', 403);
  if (!deps.domains.includes(m.domain)) throw new Refused('the message was signed for another site', 401);
  if (!verifySignature(b.message as string, b.signature as string, m.wallet)) throw new Refused('the signature does not match the wallet', 401);
  const issued = Date.parse(m.issuedAt), expires = Date.parse(m.expiresAt);
  if (!(expires > nowMs) || issued > nowMs + 60_000 || expires - issued > MESSAGE_TTL_SECS * 1000) throw new Refused('the signed message has expired; sign a new one', 401);
  // Single use: the nonce must be one this server issued for exactly these times, and unused.
  await withLock(deps.dir, () => {
    const file = join(deps.dir, 'nonces.json');
    const all = readJson<Nonces>(file, {});
    const n = all[m.nonce];
    if (!n || n.used || n.issuedAt !== m.issuedAt || n.expiresAt !== m.expiresAt) throw new Refused('the nonce is unknown or already used; sign a new message', 409);
    n.used = true;
    writeJsonAtomic(file, all);
  });

  if (m.action === 'unsubscribe') {
    let removed = 0;
    await updateSubscribers(deps.dir, (subs) => subs.filter((s) => {
      const drop = s.wallet === m.wallet && (m.channel === 'all' || s.channel === m.channel);
      if (drop) removed++;
      return !drop;
    }));
    return { ok: true, removed };
  }

  const [kind, ref] = m.channel.split(':') as ['telegram' | 'webpush', string];
  let channelId: string;
  if (kind === 'telegram') {
    const chat = consumeCode(deps.dir, ref, Math.floor(nowMs / 1000));
    if (!chat) throw new Refused('the Telegram link code is unknown, used or expired; send /start to the bot for a new one', 409);
    channelId = chat;
  } else {
    const s = b.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
    const ep = s?.endpoint, p256dh = s?.keys?.p256dh, auth = s?.keys?.auth;
    const b64u = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max && /^[A-Za-z0-9_-]+={0,2}$/.test(x);
    if (typeof ep !== 'string' || ep.length > 600 || !b64u(p256dh, 200) || !b64u(auth, 64)) throw new InputError('subscription: a browser PushSubscription');
    let u: URL;
    try { u = new URL(ep); } catch { throw new InputError('subscription: a browser PushSubscription'); }
    if (u.protocol !== 'https:' || !pushHostOk(u.hostname) || u.port !== '' || u.username || u.password) throw new InputError('subscription: not a known web push service');
    if ((await endpointHash(ep)) !== ref) throw new InputError('subscription: does not match the signed message');
    channelId = JSON.stringify({ endpoint: ep, keys: { p256dh, auth } });
  }
  const max = deps.maxSubscribers ?? 10_000;
  await updateSubscribers(deps.dir, (subs) => {
    const rest = subs.filter((s) => !(s.wallet === m.wallet && s.channel === kind));
    if (rest.length >= max) throw new Refused('the alerts list is full', 503);
    return [...rest, { wallet: m.wallet, channel: kind, channelId, threshold: m.threshold!, createdAt: new Date(nowMs).toISOString() }];
  });
  return { ok: true, channel: kind, threshold: m.threshold };
}

/** How many subscriptions a wallet has (for the page; no channel ids). */
export const subscriptionsOf = (dir: string, wallet: string) =>
  readSubscribers(dir).filter((s) => s.wallet === wallet).map((s) => ({ channel: s.channel, threshold: s.threshold, createdAt: s.createdAt }));
