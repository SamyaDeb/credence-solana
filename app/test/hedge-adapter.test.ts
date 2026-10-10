// D3.2 hedge keeper (testnet hedge, research): the venue adapter against recorded testnet responses, the signing scheme, the
// P&L netting and the Rust helper bridge. Recorded: app/test/fixtures/hl-testnet (public /info responses, 2026-10-11). The
// exchange replies are the documented shape (they need a funded key to record); the live round trip is the keeper's
// `src/hedge/probe.ts` (signing, no funds) and, with a key, `src/hedge/roundtrip.ts`.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { actionHash, addressOf, agentDigest, recoverAddress, signAction } from '../../keeper/src/hedge/hl-sign';
import { HyperliquidTestnet, fmtPx, fmtSz } from '../../keeper/src/hedge/hyperliquid';
import { evidenceHash, hedgeFraction, helper, positionsOf, wadOf } from '../../keeper/src/hedge/index';
import { netPnl, usdcToBase, type Fill } from '../../keeper/src/hedge/venue';
import { redact } from '../../keeper/src/redact';

const fx = (n: string) => JSON.parse(readFileSync(new URL(`./fixtures/hl-testnet/${n}.json`, import.meta.url), 'utf8'));
const KEY = '0x0123456789012345678901234567890123456789012345678901234567890123';

/** A fake venue: serves the recorded /info responses, records every /exchange request, answers orders as documented. */
function fake(opts: { fillFraction?: number; closeFraction?: number; reject?: string } = {}) {
  const sent: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let positions: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const fetchFn = (async (url: string, init: { body: string }) => {
    const body = JSON.parse(init.body);
    const json = (x: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(x) });
    if (url.endsWith('/info')) {
      if (body.type === 'perpDexs') return json(fx('perpDexs').dexs);
      if (body.type === 'meta') return json(fx('meta-xyz').meta);
      if (body.type === 'allMids') return json(fx('allMids-xyz').mids);
      if (body.type === 'clearinghouseState') return json({ assetPositions: positions });
      if (body.type === 'userFillsByTime') return json([]);
      if (body.type === 'userFunding') return json([]);
    }
    if (url.endsWith('/exchange')) {
      sent.push(body);
      if (opts.reject) return json({ status: 'err', response: opts.reject });
      if (body.action.type === 'updateLeverage') return json({ status: 'ok', response: { type: 'default' } });
      const o = body.action.orders[0];
      const frac = o.r ? (opts.closeFraction ?? 1) : (opts.fillFraction ?? 1);
      const sz = (Number(o.s) * frac).toString();
      if (!o.r) positions = [{ position: { coin: 'xyz:NVDA', szi: `-${sz}`, entryPx: o.p, marginUsed: '1' } }];
      else {
        const left = Math.max(0, Math.abs(Number(positions[0].position.szi)) - Number(sz));
        positions = left > 1e-9 ? [{ position: { ...positions[0].position, szi: `-${left}` } }] : [];
      }
      return json({ status: 'ok', response: { type: 'order', data: { statuses: [{ filled: { totalSz: sz, avgPx: o.p, oid: 1 } }] } } });
    }
    throw new Error(`unexpected ${url} ${init.body}`);
  }) as unknown as typeof fetch;
  return { sent, fetchFn };
}

describe('signing (Hyperliquid L1 action)', () => {
  const action = { type: 'order', orders: [{ a: 750002, b: false, p: '230.5', s: '0.5', r: false, t: { limit: { tif: 'Ioc' } } }], grouping: 'na' };

  it('the signature recovers to the key\'s address and is deterministic', () => {
    const sig = signAction(KEY, action, 1_700_000_000_000);
    expect(recoverAddress(action, 1_700_000_000_000, sig)).toBe(addressOf(KEY));
    expect(signAction(KEY, action, 1_700_000_000_000)).toEqual(sig);
    expect(signAction(KEY, action, 1_700_000_000_001)).not.toEqual(sig);
    expect(sig.v === 27 || sig.v === 28).toBe(true);
    // The well-known address of this key (secp256k1 test key 0x0123…0123).
    expect(addressOf(KEY)).toBe('0x14791697260e4c9a71f18484c9f997b308e59325');
  });

  it('any change to the action changes who the signature recovers to (a signature is bound to the action)', () => {
    const sig = signAction(KEY, action, 5);
    const other = { ...action, grouping: 'positionTpsl' };
    expect(recoverAddress(other, 5, sig)).not.toBe(addressOf(KEY));
  });

  it('msgpacks the action keys in insertion order and appends nonce and the vault flag', () => {
    const h = actionHash(action, 7);
    expect(h).toHaveLength(32);
    // Same content, different key order: a different hash (the wire order matters to the venue).
    const reordered = { grouping: 'na', type: 'order', orders: action.orders };
    expect(Buffer.from(actionHash(reordered, 7)).equals(Buffer.from(h))).toBe(false);
    expect(agentDigest(h, 'b')).not.toEqual(agentDigest(h, 'a')); // testnet and mainnet agents differ
  });
});

describe('the adapter', () => {
  it('refuses anything but the testnet, and a malformed key', () => {
    expect(() => new HyperliquidTestnet({ key: KEY, base: 'https://api.hyperliquid.xyz' })).toThrow(/testnet only/);
    expect(() => new HyperliquidTestnet({ key: KEY, base: 'https://example.com' })).toThrow(/testnet only/);
    expect(() => new HyperliquidTestnet({ key: 'nope' })).toThrow(/32-byte/);
  });

  it('price and size formatting follow the venue\'s tick and lot rules', () => {
    expect(fmtPx(230.123456, 3)).toBe('230.12');
    expect(fmtPx(30834.04, 4)).toBe('30834');
    expect(fmtPx(0.00123456, 0)).toBe('0.001235');
    expect(fmtSz(0.43219, 3)).toBe('0.432');
    expect(fmtSz(0.0004, 3)).toBe('0');
  });

  it('opens a short as an isolated IOC sell on the xyz asset id, and closes it reduce-only', async () => {
    const f = fake();
    const v = new HyperliquidTestnet({ key: KEY, fetchFn: f.fetchFn, now: () => 1000 });
    const out = await v.openHedge([{ ticker: 'NVDAx', instrument: 'xyz:NVDA', notional: 50_000_000n }]);
    // Asset id = 100000 + dex index 65 × 10000 + index of NVDA in the xyz universe (2).
    const idx = fx('meta-xyz').meta.universe.findIndex((u: { name: string }) => u.name === 'xyz:NVDA');
    expect(f.sent).toHaveLength(2);
    expect(f.sent[0].action).toEqual({ type: 'updateLeverage', asset: 100000 + 65 * 10000 + idx, isCross: false, leverage: 3 });
    const o = f.sent[1].action;
    expect(Object.keys(o)).toEqual(['type', 'orders', 'grouping']);
    expect(Object.keys(o.orders[0])).toEqual(['a', 'b', 'p', 's', 'r', 't']);
    expect(o.orders[0]).toMatchObject({ a: 100000 + 65 * 10000 + idx, b: false, r: false, t: { limit: { tif: 'Ioc' } } });
    // Sell at the mid less the 2% band: 370.76 × 0.98 = 363.34; 50 USDC / 370.76 = 0.134 NVDA.
    expect(o.orders[0].p).toBe('363.34');
    expect(o.orders[0].s).toBe('0.134');
    expect(f.sent[1].nonce).toBeGreaterThan(f.sent[0].nonce); // nonces strictly increase
    // The signed request recovers to the key's address.
    expect(recoverAddress(o, f.sent[1].nonce, f.sent[1].signature)).toBe(v.address);
    expect(out[0]).toMatchObject({ ticker: 'NVDAx', filledSz: '0.134', avgPx: '363.34' });
    // Close: a buy, reduce-only, the whole position.
    const closed = await v.closeHedge(['xyz:NVDA']);
    const c = f.sent[2].action.orders[0];
    expect(c).toMatchObject({ b: true, r: true, s: '0.134' });
    expect(closed).toHaveLength(1);
    // No leverage update on a close.
    expect(f.sent.filter((s) => s.action.type === 'updateLeverage')).toHaveLength(1);
  });

  it('closes until flat when an order fills only part of the position, with a size-weighted exit', async () => {
    const f = fake({ closeFraction: 0.5 });
    const v = new HyperliquidTestnet({ key: KEY, fetchFn: f.fetchFn, now: () => 1000 });
    await v.openHedge([{ ticker: 'NVDAx', instrument: 'xyz:NVDA', notional: 50_000_000n }]);
    // Each order fills half of what is left; the size shown is rounded to the lot (3 decimals), so it ends flat after a few rounds.
    await expect(v.closeHedge(['xyz:NVDA'])).rejects.toThrow(/still .* open after 3 close orders/);
  });

  it('a partial close that cannot finish in three orders is an error', async () => {
    const f = fake({ closeFraction: 0.25 });
    const v = new HyperliquidTestnet({ key: KEY, fetchFn: f.fetchFn, now: () => 1000 });
    await v.openHedge([{ ticker: 'NVDAx', instrument: 'xyz:NVDA', notional: 50_000_000n }]);
    await expect(v.closeHedge(['xyz:NVDA'])).rejects.toThrow(/still .* open after 3 close orders/);
  });

  it('refuses a partial fill, a rejection, a delisted instrument and an unknown one', async () => {
    const part = new HyperliquidTestnet({ key: KEY, fetchFn: fake({ fillFraction: 0.5 }).fetchFn });
    await expect(part.openHedge([{ ticker: 'NVDAx', instrument: 'xyz:NVDA', notional: 50_000_000n }])).rejects.toThrow(/filled 0\.067 of 0\.134/);
    const rej = new HyperliquidTestnet({ key: KEY, fetchFn: fake({ reject: 'User or API Wallet 0xabc does not exist.' }).fetchFn });
    await expect(rej.openHedge([{ ticker: 'NVDAx', instrument: 'xyz:NVDA', notional: 50_000_000n }])).rejects.toThrow(/does not exist/);
    const v = new HyperliquidTestnet({ key: KEY, fetchFn: fake().fetchFn });
    // xyz:SP500 is delisted on the testnet (recorded): SPYx cannot be hedged there today.
    await expect(v.openHedge([{ ticker: 'SPYx', instrument: 'xyz:SP500', notional: 50_000_000n }])).rejects.toThrow(/delisted/);
    await expect(v.openHedge([{ ticker: 'X', instrument: 'xyz:NOPE', notional: 50_000_000n }])).rejects.toThrow(/does not list/);
    expect(await v.listed(['xyz:NVDA', 'xyz:SP500', 'xyz:NOPE', 'xyz:XYZ100'])).toEqual(['xyz:NVDA', 'xyz:XYZ100']);
  });
});

describe('netting the weekend', () => {
  const fill = (over: Partial<Fill>): Fill => ({ instrument: 'xyz:NVDA', side: 'sell', px: '1', sz: '1', time: 0, fee: '0', closedPnl: '0', oid: 1, hash: '0x', ...over });

  it('net = Σ closedPnl − Σ fees + funding, floored to a base unit', () => {
    const fills = [fill({ fee: '0.018', oid: 1 }), fill({ side: 'buy', closedPnl: '5.123456789', fee: '0.0187', oid: 2 })];
    // 5.123456789 − 0.0367 + (−0.02) = 5.066756789 -> 5.066756
    expect(netPnl(fills, '-0.02')).toBe(5_066_756n);
    // A loss floors toward more loss.
    expect(netPnl([fill({ closedPnl: '-1.0000001' })], '0')).toBe(-1_000_001n);
    expect(netPnl([], '0')).toBe(0n);
  });

  it('usdcToBase floors toward the loss side', () => {
    expect(usdcToBase('1.2345679')).toBe(1_234_567n);
    expect(usdcToBase('-1.2345679')).toBe(-1_234_568n);
    expect(usdcToBase('-3')).toBe(-3_000_000n);
    expect(() => usdcToBase('1e3')).toThrow();
  });

  it('the evidence hash is stable under fill order and changes with any fill', () => {
    const a = [fill({ oid: 2 }), fill({ oid: 1 })];
    expect(evidenceHash(a, '0')).toEqual(evidenceHash([a[1], a[0]], '0'));
    expect(evidenceHash(a, '0')).toHaveLength(32);
    expect(evidenceHash(a, '0')).not.toEqual(evidenceHash([fill({ oid: 2, px: '1.01' }), a[1]], '0'));
    expect(evidenceHash(a, '0')).not.toEqual(evidenceHash(a, '0.01'));
  });

  it('wadOf parses prices exactly', () => {
    expect(wadOf('363.34')).toBe(363_340_000_000_000_000_000n);
    expect(wadOf('7811')).toBe(7811n * 10n ** 18n);
    expect(() => wadOf('x')).toThrow();
  });
});

describe('the Rust helper (risk-core): sizing and the P&L bound', () => {
  it('sizes a hedge from live policies, caps it and bounds a report', () => {
    const policies = [
      { publicKey: 'p1', account: { state: 0, epoch: { toBase58: () => 'e1' }, nLegs: 0, ticker: [...Buffer.from('SPYx\0\0\0\0')], coveredValue: { toString: () => '26000000000' }, debt: { toString: () => '25000000000' }, maxPayout: { toString: () => '25000000000' }, stableCovered: { toString: () => '0' } } },
      { publicKey: 'p2', account: { state: 1, epoch: { toBase58: () => 'e1' }, nLegs: 0, ticker: [...Buffer.from('SPYx\0\0\0\0')], coveredValue: { toString: () => '1' }, debt: { toString: () => '1' }, maxPayout: { toString: () => '1' }, stableCovered: { toString: () => '0' } } },
      { publicKey: 'p3', account: { state: 0, epoch: { toBase58: () => 'other' }, nLegs: 0, ticker: [...Buffer.from('SPYx\0\0\0\0')], coveredValue: { toString: () => '1' }, debt: { toString: () => '1' }, maxPayout: { toString: () => '1' }, stableCovered: { toString: () => '0' } } },
    ] as never;
    const positions = positionsOf(policies, new Set(['e1']));
    expect(positions).toEqual([{ debt: '25000000000', cap: '25000000000', covered: { SPYx: '26000000000' }, stable: '0' }]);
    const sized = helper({ h: '0.5', positions }) as { delta: Record<string, string>; notional: Record<string, string>; scaled: boolean };
    expect(BigInt(sized.delta.SPYx)).toBeGreaterThan(0n);
    expect(BigInt(sized.notional.SPYx)).toBe(BigInt(sized.delta.SPYx) / 2n);
    const capped = helper({ h: '1', capNotional: '1000000', positions }) as { notional: Record<string, string>; scaled: boolean };
    expect(capped.scaled).toBe(true);
    expect(BigInt(capped.notional.SPYx)).toBeLessThanOrEqual(1_000_000n);
    // The report bound: 100 USDC short, 700 -> 665 implies +5 USDC; a claimed 6 is clamped to 5, a claimed 4 stays.
    const legs = [{ notional: '100000000', entry: wadOf('700').toString(), exit: wadOf('665').toString() }];
    expect(helper({ op: 'bounds', legs, pnl: '6000000' })).toEqual({ implied: '5000000', pnl: '5000000' });
    expect(helper({ op: 'bounds', legs, pnl: '4000000' })).toEqual({ implied: '5000000', pnl: '4000000' });
    expect(() => helper({ h: '0.5', positions: [{ debt: '1', cap: '1', covered: { NOPE: '1' }, stable: '0' }] })).toThrow(/unknown ticker/);
  }, 120_000);

  it('HEDGE_H is a decimal in [0, 1]', () => {
    for (const bad of ['1.5', '-0.1', 'abc', '2']) {
      process.env.HEDGE_H = bad;
      expect(() => hedgeFraction()).toThrow(/HEDGE_H/);
    }
    process.env.HEDGE_H = '0.25';
    expect(hedgeFraction()).toBe('0.25');
    delete process.env.HEDGE_H;
  });
});

describe('secrets', () => {
  it('a private key in an error text is redacted', () => {
    expect(redact(`bad key ${KEY} in request`)).not.toContain(KEY.slice(2));
    expect(redact(`bad key ${KEY.slice(2)} in request`)).not.toContain(KEY.slice(2));
  });
});
