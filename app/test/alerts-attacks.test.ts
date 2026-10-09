// Attack tests for the Friday alerts (C4a.2), written before the handler and the job: forged signatures, replayed
// nonces, expired messages, subscribing for another wallet, personal data in logs, sending twice, burst subscriptions,
// and a push endpoint pointing anywhere but a push service (the keeper POSTs to it).
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type AlertMessage, alertMessageText, endpointHash } from '@/lib/actions/alerts-message';
import { RateLimiter } from '@/lib/actions/guard';
import { type AlertsDeps, handleAlerts } from '@/app/api/alerts/_lib/alerts';
import { readSubscribers, updateSubscribers, withLock, writeCode } from '../../keeper/src/alerts-store';
import { type ScanPosition, type Session, runAlerts } from '../../keeper/src/alerts';
import { memoryTransport } from '../../keeper/src/alerts-transports';
import { pollOnce } from '../../keeper/src/alerts-telegram';

vi.mock('server-only', () => ({}));

const NOW = Date.parse('2026-10-09T17:00:00.000Z');
const CHAT = '987654321';
let dir: string;
let deps: AlertsDeps;
let t = NOW;
const big = () => new RateLimiter({ burst: 1000, perSecond: 1000, globalBurst: 1000, globalPerSecond: 1000 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'alerts-test-'));
  t = NOW;
  deps = { dir, limiter: big(), domains: ['localhost:3000'], telegramBot: 'credence_test_bot', vapidPublicKey: null, now: () => t };
});
afterEach(() => vi.restoreAllMocks());

const req = (path: string, body?: unknown, ip = '10.0.0.1') => new Request(`http://localhost:3000/api/alerts/${path}`, body === undefined
  ? { headers: { 'x-forwarded-for': ip } }
  : { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });
const nonce = async () => (await (await handleAlerts(req('nonce'), 'nonce', deps)).json()) as { nonce: string; issuedAt: string; expiresAt: string };
const sign = (text: string, kp: Keypair) => Buffer.from(nacl.sign.detached(new TextEncoder().encode(text), kp.secretKey)).toString('base64');

async function message(kp: Keypair, over: Partial<AlertMessage> = {}): Promise<AlertMessage> {
  const n = await nonce();
  return { domain: 'localhost:3000', wallet: kp.publicKey.toBase58(), action: 'subscribe', channel: 'telegram:ABCDEFGH', threshold: 100,
    nonce: n.nonce, issuedAt: n.issuedAt, expiresAt: n.expiresAt, ...over };
}
const subscribe = (body: unknown, ip?: string) => handleAlerts(req('subscribe', body, ip), 'subscribe', deps);
const unsubscribe = (body: unknown) => handleAlerts(req('unsubscribe', body), 'unsubscribe', deps);
const signed = (m: AlertMessage, kp: Keypair, extra: Record<string, unknown> = {}) => { const text = alertMessageText(m); return { message: text, signature: sign(text, kp), ...extra }; };

describe('a_alert_forged_signature', () => {
  it('refuses a signature by another key, a tampered signature, a signature of another message, and junk', async () => {
    writeCode(dir, 'ABCDEFGH', CHAT);
    const owner = Keypair.generate(), other = Keypair.generate();
    const m = await message(owner);
    const text = alertMessageText(m);
    const good = sign(text, owner);
    const flipped = Buffer.from(good, 'base64'); flipped[10] ^= 1;
    for (const signature of [sign(text, other), flipped.toString('base64'), sign(`${text} `, owner), sign(alertMessageText({ ...m, threshold: 101 }), owner),
      'x', '', Buffer.alloc(64).toString('base64'), 12345, null]) {
      const r = await subscribe({ message: text, signature });
      expect(r.status, String(signature)).toBe(401);
    }
    expect(readSubscribers(dir)).toEqual([]);
    // A forged attempt does not burn the nonce: the owner's own signature still works.
    expect((await subscribe({ message: text, signature: good })).status).toBe(200);
    expect(readSubscribers(dir)).toHaveLength(1);
  });
  it('refuses a message altered after signing (format must be exact)', async () => {
    const owner = Keypair.generate();
    const m = await message(owner);
    const text = alertMessageText(m);
    const r = await subscribe({ message: `${text}\nExtra: 1`, signature: sign(`${text}\nExtra: 1`, owner) });
    expect(r.status).toBe(400);
  });
  it('refuses a message signed for another site (phishing domain)', async () => {
    writeCode(dir, 'ABCDEFGH', CHAT);
    const owner = Keypair.generate();
    const r = await subscribe(signed(await message(owner, { domain: 'credence-app.evil.example' }), owner));
    expect(r.status).toBe(401);
    expect(readSubscribers(dir)).toEqual([]);
  });
});

describe('a_alert_replayed_nonce', () => {
  it('a nonce works once', async () => {
    writeCode(dir, 'ABCDEFGH', CHAT);
    const owner = Keypair.generate();
    const body = signed(await message(owner), owner);
    expect((await subscribe(body)).status).toBe(200);
    writeCode(dir, 'ABCDEFGH', CHAT);
    const again = await subscribe(body);
    expect(again.status).toBe(409);
    expect((await again.json()).error).toMatch(/nonce/);
  });
  it('a nonce this server never issued, or issued for other times, is refused', async () => {
    writeCode(dir, 'ABCDEFGH', CHAT);
    const owner = Keypair.generate();
    const m = await message(owner);
    expect((await subscribe(signed({ ...m, nonce: 'A'.repeat(24) }, owner))).status).toBe(409);
    const later = new Date(Date.parse(m.issuedAt) + 1000).toISOString();
    expect((await subscribe(signed({ ...m, issuedAt: later }, owner))).status).toBe(409);
    expect(readSubscribers(dir)).toEqual([]);
  });
  it('an unsubscribe nonce cannot be replayed either', async () => {
    const owner = Keypair.generate();
    const body = signed(await message(owner, { action: 'unsubscribe', channel: 'all', threshold: undefined }), owner);
    expect((await unsubscribe(body)).status).toBe(200);
    expect((await unsubscribe(body)).status).toBe(409);
  });
});

describe('a_alert_expired', () => {
  it('a message signed in time but sent after its expiry is refused', async () => {
    writeCode(dir, 'ABCDEFGH', CHAT);
    const owner = Keypair.generate();
    const body = signed(await message(owner), owner);
    t = NOW + 11 * 60_000;
    const r = await subscribe(body);
    expect(r.status).toBe(401);
    expect((await r.json()).error).toMatch(/expired/);
    expect(readSubscribers(dir)).toEqual([]);
  });
  it('a wallet cannot extend its own window: expiry longer than 10 minutes, or issued in the future', async () => {
    writeCode(dir, 'ABCDEFGH', CHAT);
    const owner = Keypair.generate();
    const m = await message(owner);
    const long = signed({ ...m, expiresAt: new Date(Date.parse(m.issuedAt) + 3600_000).toISOString() }, owner);
    expect([401, 409]).toContain((await subscribe(long)).status);
    const future = signed({ ...m, issuedAt: new Date(NOW + 3600_000).toISOString(), expiresAt: new Date(NOW + 3900_000).toISOString() }, owner);
    expect([401, 409]).toContain((await subscribe(future)).status);
    expect(readSubscribers(dir)).toEqual([]);
  });
  it('an expired Telegram link code is refused', async () => {
    writeCode(dir, 'ABCDEFGH', CHAT, 900, NOW - 3600_000);
    const owner = Keypair.generate();
    expect((await subscribe(signed(await message(owner), owner))).status).toBe(409);
  });
});

describe('a_alert_other_wallet', () => {
  it('cannot subscribe a victim\'s wallet: the attacker cannot sign as it', async () => {
    writeCode(dir, 'ABCDEFGH', CHAT);
    const victim = Keypair.generate(), attacker = Keypair.generate();
    const m = await message(attacker, { wallet: victim.publicKey.toBase58() });
    expect((await subscribe(signed(m, attacker))).status).toBe(401);
    expect(readSubscribers(dir)).toEqual([]);
  });
  it('a body naming another wallet than the signed message is refused', async () => {
    writeCode(dir, 'ABCDEFGH', CHAT);
    const victim = Keypair.generate(), attacker = Keypair.generate();
    const r = await subscribe(signed(await message(attacker), attacker, { wallet: victim.publicKey.toBase58() }));
    expect(r.status).toBe(403);
  });
  it('cannot unsubscribe a victim', async () => {
    const victim = Keypair.generate(), attacker = Keypair.generate();
    await updateSubscribers(dir, () => [{ wallet: victim.publicKey.toBase58(), channel: 'telegram', channelId: CHAT, threshold: 1, createdAt: new Date(NOW).toISOString() }]);
    const m = await message(attacker, { wallet: victim.publicKey.toBase58(), action: 'unsubscribe', channel: 'all', threshold: undefined });
    expect((await unsubscribe(signed(m, attacker))).status).toBe(401);
    expect(readSubscribers(dir)).toHaveLength(1);
    // The attacker's own unsubscribe removes only the attacker's entries.
    const own = await unsubscribe(signed(await message(attacker, { action: 'unsubscribe', channel: 'all', threshold: undefined }), attacker));
    expect((await own.json()).removed).toBe(0);
    expect(readSubscribers(dir)).toHaveLength(1);
  });
  it('a link code is spent once: a second wallet cannot attach the same chat', async () => {
    writeCode(dir, 'ABCDEFGH', CHAT);
    const a = Keypair.generate(), b = Keypair.generate();
    expect((await subscribe(signed(await message(a), a))).status).toBe(200);
    expect((await subscribe(signed(await message(b), b))).status).toBe(409);
    expect(readSubscribers(dir).map((s) => s.wallet)).toEqual([a.publicKey.toBase58()]);
  });
});

describe('a_alert_push_ssrf: the keeper POSTs to the endpoint, so only push services are accepted', () => {
  it.each(['http://fcm.googleapis.com/fcm/send/x', 'https://169.254.169.254/latest/meta-data', 'https://127.0.0.1:8899/', 'https://fcm.googleapis.com.evil.example/x',
    'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'https://localhost/x'])('refuses %s', async (endpoint) => {
    const owner = Keypair.generate();
    const m = await message(owner, { channel: `webpush:${await endpointHash(endpoint)}` });
    const r = await subscribe(signed(m, owner, { subscription: { endpoint, keys: { p256dh: 'BOr1', auth: 'k3y' } } }));
    expect(r.status).toBe(400);
    expect(readSubscribers(dir)).toEqual([]);
  });
  it('accepts a push service endpoint whose hash is the signed one, and stores only endpoint and keys', async () => {
    const owner = Keypair.generate();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123';
    const m = await message(owner, { channel: `webpush:${await endpointHash(endpoint)}` });
    const r = await subscribe(signed(m, owner, { subscription: { endpoint, keys: { p256dh: 'BOr1', auth: 'k3y' }, expirationTime: null, extra: 'x' } }));
    expect(r.status).toBe(200);
    expect(JSON.parse(readSubscribers(dir)[0].channelId)).toEqual({ endpoint, keys: { p256dh: 'BOr1', auth: 'k3y' } });
    // Another endpoint than the signed one is refused.
    const m2 = await message(owner, { channel: `webpush:${await endpointHash(endpoint)}` });
    expect((await subscribe(signed(m2, owner, { subscription: { endpoint: `${endpoint}x`, keys: { p256dh: 'BOr1', auth: 'k3y' } } }))).status).toBe(400);
  });
});

describe('a_alert_rate_limit', () => {
  it('burst subscriptions and nonce requests are throttled (429), per client and overall', async () => {
    process.env.TRUST_PROXY = '1';
    try {
      deps.limiter = new RateLimiter({ burst: 4, perSecond: 0.1, globalBurst: 10, globalPerSecond: 0.5 });
      const owner = Keypair.generate();
      const rs = [];
      for (let i = 0; i < 6; i++) rs.push(await subscribe({ message: 'x', signature: 'y' }, '7.7.7.7'));
      expect(rs.map((r) => r.status)).toEqual([400, 400, 400, 400, 429, 429]);
      expect(Number(rs[4].headers.get('Retry-After'))).toBeGreaterThan(0);
      const others = [];
      for (let i = 0; i < 10; i++) others.push((await handleAlerts(req('nonce', undefined, `8.8.8.${i}`), 'nonce', deps)).status);
      expect(others.filter((s) => s === 429).length).toBe(4);
      void owner;
    } finally { delete process.env.TRUST_PROXY; }
  });
  it('outstanding nonces are capped (no unbounded store growth)', async () => {
    deps.maxPendingNonces = 3;
    const s = [];
    for (let i = 0; i < 5; i++) s.push((await handleAlerts(req('nonce'), 'nonce', deps)).status);
    expect(s).toEqual([200, 200, 200, 503, 503]);
  });
});

// The job: a test subscriber, one position over its threshold, a mocked transport.
const SESSIONS: Session[] = [
  { date: 20261008, open: 1791466200, close: 1791489600 },
  { date: 20261009, open: 1791552600, close: 1791576000 },
  { date: 20261012, open: 1791811800, close: 1791835200 },
];
const FRIDAY = 1791576000 - 15 * 60 - 3600; // an hour before the bell
const fixedPricing = async (items: { id: string; ticker: string }[]) => items.map((x) => ({ id: x.id, ticker: x.ticker, need8: 2_083_333_334n, paysCount: 19, n: 3000,
  premium: 57_388_142n, cap: 2_083_333_334n }));

async function jobSetup() {
  const owner = Keypair.generate();
  const position: ScanPosition = { position: Keypair.generate().publicKey.toBase58(), owner: owner.publicKey.toBase58(), ticker: 'SPYx', covered: 52_083_333_333n, debt: 50_000_000_000n, lender: 'kamino' };
  await updateSubscribers(dir, () => [{ wallet: owner.publicKey.toBase58(), channel: 'telegram', channelId: CHAT, threshold: 100, createdAt: new Date(NOW).toISOString() }]);
  return { owner, position };
}
const job = (position: ScanPosition, transport: ReturnType<typeof memoryTransport>, now = FRIDAY) =>
  runAlerts({ dir, now, sessions: SESSIONS, positions: [position], pricing: fixedPricing, transports: { telegram: transport }, appUrl: 'http://localhost:3000', sleep: async () => {} });

describe('a_alert_idempotent', () => {
  it('re-running the job in the same window sends nothing twice', async () => {
    const { position } = await jobSetup();
    const tr = memoryTransport();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (let i = 0; i < 3; i++) await job(position, tr, FRIDAY + i * 600);
    expect(tr.sent).toHaveLength(1);
  });
  it('two overlapping runs send once', async () => {
    const { position } = await jobSetup();
    const tr = memoryTransport();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await Promise.all([job(position, tr), job(position, tr), job(position, tr)]);
    expect(tr.sent).toHaveLength(1);
  });
  it('a failed send is retried (in the run, then by the next run), and sent once', async () => {
    const { position } = await jobSetup();
    const tr = memoryTransport('telegram', (n) => n <= 3); // the first run's three attempts fail
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const r1 = await job(position, tr);
    expect([r1.sent, r1.failed, tr.calls()]).toEqual([0, 1, 3]);
    const r2 = await job(position, tr, FRIDAY + 900);
    expect([r2.sent, tr.sent.length]).toEqual([1, 1]);
    await job(position, tr, FRIDAY + 1800);
    expect(tr.sent).toHaveLength(1);
  });
  it('the next weekend is a new alert', async () => {
    const { position } = await jobSetup();
    const tr = memoryTransport();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await job(position, tr);
    const next: Session[] = [...SESSIONS, { date: 20261016, open: 1792157400, close: 1792180800 }, { date: 20261019, open: 1792416600, close: 1792440000 }];
    await runAlerts({ dir, now: 1792180800 - 900 - 600, sessions: next, positions: [position], pricing: fixedPricing, transports: { telegram: tr }, appUrl: 'http://localhost:3000' });
    expect(tr.sent).toHaveLength(2);
  });
});

describe('a_alert_no_pii_logged', () => {
  it('subscribing, the job, failures and the Telegram bot log no wallet, chat id, link code, endpoint or position', async () => {
    const lines: string[] = [];
    const capture = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
    for (const k of ['log', 'error', 'warn', 'info', 'debug'] as const) vi.spyOn(console, k).mockImplementation(capture);
    const { owner, position } = await jobSetup();
    writeCode(dir, 'ABCDEFGH', CHAT);
    await subscribe(signed(await message(owner), owner));
    await subscribe(signed(await message(owner), Keypair.generate()));
    const endpoint = 'https://fcm.googleapis.com/fcm/send/secret-endpoint-token';
    await subscribe(signed(await message(owner, { channel: `webpush:${await endpointHash(endpoint)}` }), owner, { subscription: { endpoint, keys: { p256dh: 'BOr1', auth: 'k3y' } } }));
    await job(position, memoryTransport('telegram', () => true));
    await job(position, memoryTransport(), FRIDAY + 900);
    const sent: string[] = [];
    await pollOnce({ updates: async () => [{ update_id: 5, message: { chat: { id: Number(CHAT), type: 'private' }, text: '/start' } }, { update_id: 6, message: { chat: { id: Number(CHAT), type: 'private' }, text: '/stop' } }],
      reply: async (_c, text) => { sent.push(text); } }, dir);
    const code = /code: ([A-Z2-7]{8})/.exec(sent[0])![1];
    const log = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const pii of [owner.publicKey.toBase58(), CHAT, 'ABCDEFGH', code, 'secret-endpoint-token', position.position]) expect(log, pii).not.toContain(pii);
    // The ledger is keyed by hashes: no wallet, chat id or position in it either.
    const ledgers = readdirSync(dir).filter((f) => f.startsWith('sent-')).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');
    for (const pii of [owner.publicKey.toBase58(), CHAT, position.position]) expect(ledgers).not.toContain(pii);
    // The subscriber record holds only the minimum.
    for (const s of readSubscribers(dir)) expect(Object.keys(s).sort()).toEqual(['channel', 'channelId', 'createdAt', 'threshold', 'wallet']);
  });
});

describe('A-118: one failing Telegram reply does not stall the bot', () => {
  it('a user who blocked the bot: their update is skipped, the others answered, the offset moves on', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const replies: string[] = [];
    const api = {
      updates: vi.fn(async (offset: number) => offset <= 10 ? [
        { update_id: 10, message: { chat: { id: 111, type: 'private' }, text: '/start' } },
        { update_id: 11, message: { chat: { id: 222, type: 'private' }, text: '/start' } },
      ] : []),
      reply: async (chatId: string) => { if (chatId === '111') throw new Error('telegram sendMessage failed (HTTP 403)'); replies.push(chatId); },
    };
    expect(await pollOnce(api, dir)).toBe(12);
    expect(replies).toEqual(['222']);
    expect(await pollOnce(api, dir)).toBe(12);
    expect(api.updates).toHaveBeenLastCalledWith(12);
    // The code the blocked chat never received is not left behind.
    expect(readdirSync(join(dir, 'codes'))).toHaveLength(1);
  });
});

describe('A-119: link codes do not pile up', () => {
  it('one live code per chat, expired codes pruned, and a cap on pending codes', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    writeCode(dir, 'AAAAAAAA', '1', 900, NOW - 3600_000); // expired an hour ago
    const replies: string[] = [];
    let id = 0;
    const start = (chat: number) => ({ update_id: ++id, message: { chat: { id: chat, type: 'private' }, text: '/start' } });
    const api = (ups: ReturnType<typeof start>[]) => ({ updates: async () => ups, reply: async (_c: string, t: string) => { replies.push(t); } });
    await pollOnce(api([start(7), start(7), start(7), start(7)]), dir);
    const files = () => readdirSync(join(dir, 'codes'));
    expect(files()).toHaveLength(1); // chat 7's latest; the expired one is gone
    for (let c = 100; c < 105; c++) await pollOnce(api([start(c)]), dir, () => {}, 5);
    expect(files().length).toBeLessThanOrEqual(5);
    expect(replies.at(-1)).toMatch(/try again/);
  });
});

describe('A-120: a long-held lock is not taken over, and a holder only releases its own lock', () => {
  it('a holder working past staleMs keeps the lock (heartbeat): the next one waits', async () => {
    const order: string[] = [];
    const a = withLock(dir, async () => { order.push('a-in'); await new Promise((r) => setTimeout(r, 600)); order.push('a-out'); }, '.run.lock', 200, 400);
    await new Promise((r) => setTimeout(r, 50));
    const b = withLock(dir, async () => { order.push('b-in'); }, '.run.lock', 200, 400);
    await Promise.all([a, b]);
    expect(order).toEqual(['a-in', 'a-out', 'b-in']);
  });
  it('releasing a lock someone else now holds leaves it in place', async () => {
    await withLock(dir, async () => { writeFileSync(join(dir, '.x.lock'), 'someone-else'); }, '.x.lock');
    expect(readFileSync(join(dir, '.x.lock'), 'utf8')).toBe('someone-else');
  });
});
