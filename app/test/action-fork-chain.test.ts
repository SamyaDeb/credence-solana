// The fork chain's pure parts (the RPC paths run in the fork e2e, e2e/protect-action.spec.ts): Jupiter Lend account
// layouts and PDAs as keeper/src/jl-demo.ts derives them, the Policy read back from a simulation, the sale notes, and
// the multi-collateral legs in order of first appearance (A-45).
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';
import { BN } from '@anchor-lang/core';
import type { Asset, EpochView } from '@/lib/cover';
import { IDL, USDC_MINT, pdas, program } from '@/lib/credence';
import type { ObligationState, ReserveState } from '@/lib/kamino';
import { JL_MIN_TICK, JL_POSITION_DISC, JL_VAULTS, decodeJlPosition, jlTick, jlVaultState } from '@/lib/actions/build';
import { ForkChain, multiLegs, sale } from '@/lib/actions/fork-chain';

vi.mock('server-only', () => ({}));

const prog = program(new Connection('http://127.0.0.1:1'));
const DEFAULT = '11111111111111111111111111111111';
const MARKET = '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua';
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';

describe('Jupiter Lend layouts', () => {
  it('vault state and tick PDAs as keeper/src/jl-demo.ts derives them', () => {
    const vs = PublicKey.findProgramAddressSync([Buffer.from('vault_state'), Buffer.from([78, 0])], JL_VAULTS)[0];
    expect(jlVaultState(78).equals(vs)).toBe(true);
    const t = Buffer.alloc(4); t.writeUInt32LE(-400 + 16383);
    expect(jlTick(78, -400).equals(PublicKey.findProgramAddressSync([Buffer.from('tick'), Buffer.from([78, 0]), t], JL_VAULTS)[0])).toBe(true);
  });
  it('decodes a Position and refuses other accounts', () => {
    const mint = Keypair.generate().publicKey;
    const d = Buffer.alloc(71);
    JL_POSITION_DISC.copy(d, 0); d.writeUInt16LE(78, 8); d.writeUInt32LE(4242, 10); mint.toBuffer().copy(d, 14); d[46] = 0; d.writeInt32LE(-400, 47);
    expect(decodeJlPosition(d)).toEqual({ vaultId: 78, nftId: 4242, mint, supplyOnly: false, tick: -400 });
    expect(decodeJlPosition(Buffer.alloc(71))).toBeNull();
    expect(decodeJlPosition(d.subarray(0, 40))).toBeNull();
    expect(JL_MIN_TICK).toBe(-16383);
  });
});

describe('Policy read back from a simulation', () => {
  // A zero value of every IDL type, so the test encodes a Policy exactly as the program lays it out.
  type T = string | { array?: [T, number]; defined?: { name: string }; option?: T; vec?: T };
  const zero = (t: T): unknown => {
    if (typeof t === 'string') return t === 'pubkey' ? PublicKey.default : t === 'bool' ? false : /^[ui](64|128)$/.test(t) ? new BN(0) : 0;
    if (t.array) return Array.from({ length: t.array[1] }, () => zero(t.array![0]));
    if (t.defined) return obj(t.defined.name);
    return null;
  };
  const obj = (name: string) => Object.fromEntries(((IDL.types as { name: string; type: { fields: { name: string; type: T }[] } }[])
    .find((x) => x.name === name)!.type.fields).map((f) => [f.name.replace(/_(\w)/g, (_, c: string) => c.toUpperCase()), zero(f.type)]));
  it('decodes premium, C′ and D with the IDL coder under the name the program uses', async () => {
    const p = { ...obj('Policy'), premium: new BN(8_612_345), coveredValue: new BN(52_083_333_333), debt: new BN(50_000_000_000) };
    const data = await prog.coder.accounts.encode('policy', p);
    const back = prog.coder.accounts.decode('policy', data);
    expect(back.premium.toString()).toBe('8612345');
    expect(back.coveredValue.toString()).toBe('52083333333');
    expect(back.debt.toString()).toBe('50000000000');
  });
});

const ep = (ticker: string, over: Partial<EpochView>): EpochView => ({ key: pdas.epoch(ticker, 42), ticker, closureId: 42, closureType: 2, state: 0, saleOpen: 100, bell: 200,
  close: 215, open: 500, settleAfter: 0, settledAt: 0, closePriceWad: 0n, settlePriceWad: 0n, policyCount: 0, policiesSettled: 0, totalMaxPayout: 0n, totalPremium: 0n,
  totalPayout: 0n, worstLossSum: 0n, ...over });

describe('sale', () => {
  it('an epoch on sale', () => {
    const e = ep('SPYx', {});
    expect(sale([e], ['SPYx'], 150, e)).toEqual({ sale: { epoch: e.key.toBase58(), closureId: 42, closureType: 2, bell: 200 }, saleNote: null });
  });
  it('after the bell, before the sale opens, nothing open, weekend-only', () => {
    expect(sale([ep('SPYx', {})], ['SPYx'], 250, null).saleNote).toMatch(/^sales closed at the bell/);
    expect(sale([ep('SPYx', {})], ['SPYx'], 50, null).saleNote).toMatch(/^sales open/);
    expect(sale([], ['SPYx'], 50, null).saleNote).toMatch(/no epoch is open/);
    expect(sale([ep('SPYx', { closureType: 1 })], ['SPYx'], 150, null, 'weekend epochs only').saleNote).toBe('weekend epochs only');
  });
});

describe('multi-collateral legs', () => {
  const r = (mint: string): ReserveState => ({ liquidity: { mintPubkey: mint } }) as unknown as ReserveState;
  const key = () => Keypair.generate().publicKey;
  const [spyR, qqqR, usdcR, borR, otherR] = [key(), key(), key(), key(), key()];
  const asset = (ticker: string): Asset => ({ key: pdas.asset(ticker), ticker } as Asset);
  const byReserve = new Map([[spyR.toBase58(), asset('SPYx')], [qqqR.toBase58(), asset('QQQx')]]);
  const reserves = new Map([[spyR.toBase58(), r('x')], [qqqR.toBase58(), r('x')], [usdcR.toBase58(), r(USDC_MINT.toBase58())], [borR.toBase58(), r(USDC_MINT.toBase58())],
    [otherR.toBase58(), r('So11111111111111111111111111111111111111112')]]);
  const ob = (deps: PublicKey[], bors: PublicKey[] = [borR], market = MARKET) => ({ lendingMarket: market,
    deposits: [...deps.map((d) => ({ depositReserve: d.toBase58() })), { depositReserve: DEFAULT }],
    borrows: [...bors.map((b) => ({ borrowReserve: b.toBase58() })), { borrowReserve: DEFAULT }] }) as unknown as ObligationState;
  const stables = [USDC_MINT.toBase58(), PYUSD];
  it('legs in order of first appearance; stablecoin deposits allowed', () => {
    expect(multiLegs(ob([qqqR, usdcR, spyR]), reserves, byReserve, stables)!.legs.map((l) => l.ticker)).toEqual(['QQQx', 'SPYx']);
  });
  it('refuses an uncovered deposit, a non-stable borrow, two borrows, another market, a single deposit', () => {
    expect(multiLegs(ob([spyR, otherR]), reserves, byReserve, stables)).toBeNull();
    expect(multiLegs(ob([spyR, qqqR], [otherR]), reserves, byReserve, stables)).toBeNull();
    expect(multiLegs(ob([spyR, qqqR], [borR, usdcR]), reserves, byReserve, stables)).toBeNull();
    expect(multiLegs(ob([spyR, qqqR], [borR], key().toBase58()), reserves, byReserve, stables)).toBeNull();
    expect(multiLegs(ob([spyR]), reserves, byReserve, stables)).toBeNull();
    expect(multiLegs(ob([usdcR, usdcR]), reserves, byReserve, stables)).toBeNull();
  });
});

describe('fork upkeep only on a local fork', () => {
  it('a non-local RPC never gets cheatcodes', () => {
    expect(new ForkChain('https://example.invalid').local).toBe(false);
    expect(new ForkChain('http://127.0.0.1:8909').local).toBe(true);
  });
});
