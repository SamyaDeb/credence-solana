// ForkChain.loadKamino with the chain reads mocked (the RPC paths themselves run in the fork e2e): which buy a Kamino
// position gets, which epoch it is sold on, and the fork upkeep before any simulation.
import { Keypair, PublicKey } from '@solana/web3.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Asset, EpochView } from '@/lib/cover';
import { KLEND, USDC_MINT, pdas } from '@/lib/credence';
import type { ReserveState } from '@/lib/kamino';

vi.mock('server-only', () => ({}));

const NOW = 1_791_570_000;
const MARKET = '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua';
const DEFAULT = '11111111111111111111111111111111';
const PYUSD = '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo';
const key = () => Keypair.generate().publicKey;
const POS = key(); // the loaded position (the mock chain holds an obligation there only)
const [spyR, qqqR, usdcR, pyusdR] = [key(), key(), key(), key()];
const asset = (ticker: string, r: PublicKey): Asset => ({ key: pdas.asset(ticker), ticker, tickerBytes: [], mint: key(), sigmaWad: 9_420_468_650_103_632n, settleSource: 2,
  scopeChain: 0, reserves: [r.toBase58()], enabled: true, feedXstock: [] });
const ASSETS = [asset('SPYx', spyR), asset('QQQx', qqqR)];
const reserve = (mint: string) => ({ lendingMarket: MARKET, liquidity: { mintPubkey: mint }, config: { borrowFactorPct: 100n,
  tokenInfo: { pythConfiguration: { price: DEFAULT }, switchboardConfiguration: { priceAggregator: DEFAULT, twapAggregator: DEFAULT },
    scopeConfiguration: { priceFeed: DEFAULT, priceChain: [1, 65535, 65535, 65535], twapChain: [65535] } } } }) as unknown as ReserveState;
const RESERVES = new Map([[spyR.toBase58(), reserve('x')], [qqqR.toBase58(), reserve('y')], [usdcR.toBase58(), reserve(USDC_MINT.toBase58())], [pyusdR.toBase58(), reserve(PYUSD)]]);
const ep = (ticker: string, closureType: number, closureId = 20261009): EpochView => ({ key: pdas.epoch(ticker, closureId), ticker, closureId, closureType, state: 0,
  saleOpen: NOW - 86_400, bell: NOW + 3_600, close: NOW + 4_500, open: NOW + 240_000, settleAfter: 0, settledAt: 0, closePriceWad: 0n, settlePriceWad: 0n, policyCount: 0,
  policiesSettled: 0, totalMaxPayout: 0n, totalPremium: 0n, totalPayout: 0n, worstLossSum: 0n });

let obligation: Record<string, unknown>;
let epochs: EpochView[];
const calls: string[] = [];

vi.mock('@/lib/kamino', async (orig) => ({
  ...(await orig<typeof import('@/lib/kamino')>()),
  decodeObligation: () => obligation,
  loadReserves: async () => RESERVES,
  simulateRefreshed: async () => { calls.push('refresh-sim'); return { state: obligation, cu: 1 }; },
  snapshot: () => ({ debt: 50_000_000_000n, coveredValue: 52_083_333_333n, collateralValue: 0n, ltWad: 0n, depositAmount: 0n }),
}));
vi.mock('@/lib/cover', async (orig) => ({ ...(await orig<typeof import('@/lib/cover')>()), loadAssets: async () => ASSETS, loadEpochs: async () => epochs }));
vi.mock('@/lib/credence', async (orig) => ({ ...(await orig<typeof import('@/lib/credence')>()), chainNow: async () => NOW }));
vi.mock('@/lib/odds', async (orig) => ({ ...(await orig<typeof import('@/lib/odds')>()), loadScenarioZ: async () => new Int16Array([-3000, 0, 3000]) }));

const { ForkChain } = await import('@/lib/actions/fork-chain');

/** Addresses holding a Policy on the mock chain (A-125); every other address but the position's own is empty. */
const policyAt = new Set<string>();

function chain() {
  const c = new ForkChain('http://127.0.0.1:8909');
  const any = c as unknown as Record<string, unknown>;
  any.conn = { getAccountInfo: async (k: PublicKey) => (k.equals(POS) ? { owner: KLEND, data: Buffer.alloc(8) } : policyAt.has(k.toBase58()) ? { owner: key(), data: Buffer.alloc(8) } : null) };
  any.prog = { account: { config: { fetch: async () => ({ pyusdMint: new PublicKey(PYUSD) }) } } };
  any.freshenScope = async () => { calls.push('freshen'); };
  any.probe = async (p: { snap: unknown }) => { calls.push('probe'); p.snap = { coveredValue: 1n, debt: 1n }; };
  return c;
}
const ob = (deps: PublicKey[], bors: PublicKey[]) => ({ lendingMarket: MARKET, owner: key().toBase58(),
  deposits: [...deps.map((d) => ({ depositReserve: d.toBase58() })), { depositReserve: DEFAULT }],
  borrows: [...bors.map((b) => ({ borrowReserve: b.toBase58() })), { borrowReserve: DEFAULT }],
  borrowFactorAdjustedDebtValueSf: 1n, borrowedAssetsMarketValueSf: 1n });

beforeEach(() => { calls.length = 0; policyAt.clear(); });

describe('A-113: multi-collateral positions get the fork\'s Scope upkeep before any simulation', () => {
  it('SPYx + QQQx against USDC: Scope restamped, then the probe', async () => {
    obligation = ob([spyR, qqqR], [usdcR]);
    epochs = [ep('SPYx', 2), ep('QQQx', 2)];
    const p = await chain().load('kamino', POS);
    expect(p!.kind).toBe('kamino-multi');
    expect(calls).toEqual(['freshen', 'probe']);
  });
});

describe('A-114: the Action sells weekend epochs only (its odds and wording are the weekend\'s)', () => {
  it('a single-asset position with only an OVERNIGHT epoch on sale is not offered, with the reason', async () => {
    obligation = ob([spyR], [usdcR]);
    epochs = [ep('SPYx', 1, 20261013)];
    const p = await chain().load('kamino', POS);
    expect(p!.sale).toBeNull();
    expect(p!.saleNote).toMatch(/weekend/);
    expect(calls).not.toContain('refresh-sim');
  });
  it('a WEEKEND epoch is offered', async () => {
    obligation = ob([spyR], [usdcR]);
    epochs = [ep('SPYx', 1, 20261008), ep('SPYx', 2)];
    const p = await chain().load('kamino', POS);
    expect(p!.sale?.closureType).toBe(2);
    expect(p!.sale?.closureId).toBe(20261009);
  });
});

describe('A-115: one xStock against a PYUSD debt is buy_cover_multi\'s, not refused', () => {
  it('SPYx against PYUSD', async () => {
    obligation = ob([spyR], [pyusdR]);
    epochs = [ep('SPYx', 2)];
    const p = await chain().load('kamino', POS);
    expect(p!.why).toBeNull();
    expect(p!.kind).toBe('kamino-multi');
    expect(p!.ticker).toBe('SPYx');
  });
});

describe('A-125: an existing Policy is read before any simulation', () => {
  it('Kamino multi: the Policy PDA exists → p.policy is set and nothing is refreshed or simulated', async () => {
    obligation = ob([spyR, qqqR], [usdcR]);
    epochs = [ep('SPYx', 2), ep('QQQx', 2)];
    const c = chain();
    const open = await c.load('kamino', POS);
    expect(open!.policy ?? null).toBeNull();
    expect(calls).toEqual(['freshen', 'probe']);
    calls.length = 0;
    const { pdas } = await import('@/lib/credence');
    policyAt.add(pdas.policy(epochs[0].key, POS).toBase58());
    const p = await c.load('kamino', POS);
    expect(p!.policy).toBe(pdas.policy(epochs[0].key, POS).toBase58());
    expect(calls).toEqual([]);
  });
});
