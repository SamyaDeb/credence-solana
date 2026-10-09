// The Friday alerts job (C4a.2): the calendar decides when (weekends, holiday closures, half days), the scan decides
// which positions, the program's pricing (keeper/alerts-quote) decides the numbers, and the right message goes once.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Keypair } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { type Assessment, type ScanPosition, type Session, alertText, alertWindow, quoteHelper, runAlerts, scanPositions } from '../../keeper/src/alerts';
import { updateSubscribers } from '../../keeper/src/alerts-store';
import { memoryTransport, telegramTransport } from '../../keeper/src/alerts-transports';
import golden from './fixtures/alerts-quote-golden.json' with { type: 'json' };

const ROOT = join(__dirname, '../..');
const HELPER = join(ROOT, 'keeper/alerts-quote/target/release/alerts_quote');
const sessions = (JSON.parse(readFileSync(join(ROOT, 'data/onchain/calendar-XNYS.json'), 'utf8')) as { sessions: Session[] }).sessions;
const at = (iso: string) => Date.parse(iso) / 1000;

describe('alert window: the XNYS calendar decides', () => {
  it('Friday Oct 9 2026: from 4 h before the 3:45 PM ET bell until the bell', () => {
    const bell = at('2026-10-09T19:45:00Z');
    expect(alertWindow(sessions, bell - 4 * 3600 - 1, 4 * 3600)).toBeNull();
    expect(alertWindow(sessions, bell - 4 * 3600, 4 * 3600)).toMatchObject({ closureId: 20261009, bell, kind: 'weekend' });
    expect(alertWindow(sessions, bell - 1, 4 * 3600)?.closureId).toBe(20261009);
    expect(alertWindow(sessions, bell, 4 * 3600)).toBeNull();
  });
  it('no alert before an overnight (Tuesday)', () => {
    expect(alertWindow(sessions, at('2026-10-13T19:00:00Z'), 4 * 3600)).toBeNull();
  });
  it('Thanksgiving: Wednesday is a holiday closure; Friday\'s half day has its bell at 12:45 PM ET', () => {
    const wed = sessions.find((s) => s.date === 20261125)!;
    expect(alertWindow(sessions, wed.close - 15 * 60 - 60, 4 * 3600)).toMatchObject({ closureId: 20261125, kind: 'holiday' });
    const fri = sessions.find((s) => s.date === 20261127)!;
    expect(fri.close).toBe(at('2026-11-27T18:00:00Z'));
    expect(alertWindow(sessions, at('2026-11-27T17:30:00Z'), 4 * 3600)).toMatchObject({ closureId: 20261127, kind: 'weekend', bell: at('2026-11-27T17:45:00Z') });
  });
});

describe('positions from the read-only mainnet scan', () => {
  it('single-asset USDC positions the program covers, C′ rounded down and the debt up', () => {
    const scan = JSON.parse(readFileSync(join(ROOT, 'data/positions/positions-20261009.json'), 'utf8'));
    const ps = scanPositions(scan, ['SPYx', 'QQQx', 'NVDAx', 'TSLAx', 'GOOGLx', 'AAPLx', 'MSTRx', 'HOODx']);
    expect(ps.length).toBeGreaterThan(500);
    expect(ps.length).toBeLessThanOrEqual(scan.summary.eligiblePhase1);
    const p = scan.positions.find((x: { obligation: string }) => x.obligation === ps[0].position);
    expect(ps[0].owner).toBe(p.owner);
    expect(ps[0].covered).toBe(BigInt(Math.floor(p.coveredValueUsd * 1e6)));
    expect(ps[0].debt).toBe(BigInt(Math.ceil(p.borrows[0].tokens * 1e6)));
  });
});

const W = { closureId: 20261009, bell: at('2026-10-09T19:45:00Z'), close: at('2026-10-09T20:00:00Z'), open: at('2026-10-12T13:30:00Z'), kind: 'weekend' as const };
const POSITION: ScanPosition = { position: '89JmfLinBbr4ZGVNcr4G2MSQe6miVN93aTsmBzPf9ACL', owner: 'x', ticker: 'SPYx', covered: 52_083_333_333n, debt: 50_000_000_000n, lender: 'kamino' };
const fromGolden = (g: (typeof golden.items)[number]): Assessment => ({ id: g.id, ticker: g.ticker, need8: BigInt(g.need8), paysCount: g.paysCount, n: g.n,
  premium: g.premium ? BigInt(g.premium) : null, cap: g.cap ? BigInt(g.cap) : null });

describe('the message', () => {
  it('names the −8% need, the cost, the chance and the /protect link, and says fork, not live, not insurance', () => {
    const text = alertText(POSITION, fromGolden(golden.items[0]), W, 'http://localhost:3000/app/protect?position=89Jm&lender=kamino');
    expect(text).toBe('A −8% Monday would need $2,083.33 to keep your SPYx position 89Jm…9ACL on Kamino healthy; gap protection for this weekend costs $34.51 '
      + '(cap $2,083.33, model vault). Chance of a gap that liquidates it: 0.63%. http://localhost:3000/app/protect?position=89Jm&lender=kamino\n'
      + 'Credence runs on a local mainnet fork; not live; not insurance.');
  });
});

describe('acceptance: a test subscriber gets the right message once (mocked transport)', () => {
  it('scan data → program pricing (golden) → one message; a re-run sends nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alerts-job-'));
    const owner = Keypair.generate().publicKey.toBase58();
    await updateSubscribers(dir, () => [{ wallet: owner, channel: 'telegram', channelId: '42', threshold: 500, createdAt: '2026-10-09T12:00:00.000Z' },
      { wallet: Keypair.generate().publicKey.toBase58(), channel: 'telegram', channelId: '43', threshold: 1, createdAt: '2026-10-09T12:00:00.000Z' }]);
    const mine = { ...POSITION, owner };
    const small = { ...POSITION, position: Keypair.generate().publicKey.toBase58(), owner, debt: 30_000_000_000n }; // −8% need below 500 USD
    const pricing = vi.fn(async (items: { id: string }[]) => items.map((x) => ({ ...fromGolden(golden.items.find((g) => g.id === (x.id === mine.position ? 'demo' : 'far'))!), id: x.id })));
    const tr = memoryTransport();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const run = () => runAlerts({ dir, now: W.bell - 1800, sessions, positions: [mine, small, { ...POSITION, position: 'other', owner: 'nobody' }], pricing,
      transports: { telegram: tr }, appUrl: 'http://localhost:3000' });
    const r = await run();
    expect(r).toMatchObject({ subscribers: 2, matched: 1, sent: 1 });
    expect(pricing.mock.calls[0][0].map((x) => x.id).sort()).toEqual([mine.position, small.position].sort()); // only subscribers' positions are priced
    expect(tr.sent).toHaveLength(1);
    expect(tr.sent[0].channelId).toBe('42');
    expect(tr.sent[0].url).toBe(`http://localhost:3000/app/protect?position=${mine.position}&lender=kamino`);
    expect(tr.sent[0].text).toContain('would need $2,083.33');
    expect(tr.sent[0].text).toContain('costs $34.51');
    expect((await run()).sent).toBe(0);
    expect(tr.sent).toHaveLength(1);
  });
});

describe.skipIf(!existsSync(HELPER))('the pricing helper (keeper/alerts-quote, built)', () => {
  it('reproduces the golden numbers from the program\'s functions', async () => {
    const h = await quoteHelper(ROOT);
    try {
      expect(h.tickers).toEqual(['SPYx', 'QQQx', 'NVDAx', 'TSLAx', 'GOOGLx', 'AAPLx', 'MSTRx', 'HOODx']);
      const got = await h.pricing(golden.request.map((x) => ({ id: x.id, ticker: x.ticker, covered: BigInt(x.covered), debt: BigInt(x.debt) })));
      expect(got.map((a) => ({ id: a.id, need8: a.need8.toString(), paysCount: a.paysCount, premium: a.premium?.toString() ?? null })))
        .toEqual(golden.items.map((g) => ({ id: g.id, need8: g.need8, paysCount: g.paysCount, premium: g.premium ?? null })));
    } finally { h.close(); }
  });
});

describe('Telegram transport', () => {
  it('posts sendMessage and never puts the token in an error', async () => {
    const token = '123456:SECRET-TOKEN';
    const calls: string[] = [];
    const ok = telegramTransport(token, (async (u: string, init: RequestInit) => { calls.push(String(init.body)); expect(u).toContain('/sendMessage'); return new Response('{}', { status: 200 }); }) as typeof fetch);
    await ok.send('42', 'hello', 'http://x');
    expect(JSON.parse(calls[0])).toMatchObject({ chat_id: '42', text: 'hello' });
    const bad = telegramTransport(token, (async () => { throw new Error(`connect ECONNREFUSED https://api.telegram.org/bot${token}/sendMessage`); }) as typeof fetch);
    await expect(bad.send('42', 'x', 'y')).rejects.toThrow(/^telegram failed$/);
    const gone = telegramTransport(token, (async () => new Response('{"description":"Forbidden: bot was blocked by the user 42"}', { status: 403 })) as typeof fetch);
    await expect(gone.send('42', 'x', 'y')).rejects.toMatchObject({ message: 'telegram failed (HTTP 403)', permanent: true });
  });
});

describe('A-117: alerts price the closure the program would sell, not always a plain weekend', () => {
  it('the job asks the helper for this closure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'alerts-job-'));
    const owner = Keypair.generate().publicKey.toBase58();
    await updateSubscribers(dir, () => [{ wallet: owner, channel: 'telegram', channelId: '42', threshold: 1, createdAt: '2026-10-09T12:00:00.000Z' }]);
    const pricing = vi.fn(async (items: { id: string }[]) => items.map((x) => ({ ...fromGolden(golden.items[0]), id: x.id })));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const thu = sessions.find((s) => s.date === 20270325)!; // Good Friday 2027: Thursday's close to Monday's open
    await runAlerts({ dir, now: thu.close - 15 * 60 - 60, sessions, positions: [{ ...POSITION, owner }], pricing, transports: { telegram: memoryTransport() }, appUrl: 'http://x' });
    expect((pricing.mock.calls[0][0][0] as { closureId?: number }).closureId).toBe(20270325);
  });
  it.skipIf(!existsSync(HELPER))('the helper: Good Friday is a 4-day HOLIDAY_WEEKEND, Thanksgiving Wednesday a 2-night OVERNIGHT, each its own set and σ', async () => {
    const h = await quoteHelper(ROOT);
    try {
      const x = { ticker: 'SPYx', covered: 52_083_333_333n, debt: 50_000_000_000n };
      const [weekend, holiday, midweek] = await h.pricing([{ id: 'w', ...x, closureId: 20261009 }, { id: 'h', ...x, closureId: 20270325 }, { id: 'm', ...x, closureId: 20261125 }]);
      expect([weekend.closureType, weekend.days]).toEqual([2, 3]);
      expect([holiday.closureType, holiday.days]).toEqual([3, 4]);
      expect([midweek.closureType, midweek.days]).toEqual([1, 2]);
      expect(holiday.premium).not.toBe(weekend.premium);
      expect(midweek.paysCount).not.toBe(weekend.paysCount);
    } finally { h.close(); }
  });
});

describe('A-122: a missing or crashing pricing helper is an error, not a crash', () => {
  it('no binary: quoteHelper rejects', async () => {
    const root = mkdtempSync(join(tmpdir(), 'no-helper-'));
    await expect(quoteHelper(`${root}/`)).rejects.toThrow(/alerts_quote/);
  });
});
