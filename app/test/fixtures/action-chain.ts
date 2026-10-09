// A ProtectChain without a fork, for the Action's tests. Positions and the clock are fixed; quotes are fixed numbers
// standing in for the simulated program; `build` uses the real instruction builders (lib/actions/build.ts) on
// synthetic decoded state, so the returned transaction has the real shape.
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import type { Asset, EpochView } from '@/lib/cover';
import { SCOPE_PRICES, USDC_MINT, pdas, program, ticker8 } from '@/lib/credence';
import type { ObligationState, ReserveState } from '@/lib/kamino';
import { type JlAsset, assembleTx, encodeTx, jupiterBuy, kaminoBuy, kaminoMultiBuy } from '@/lib/actions/build';
import type { Lender, Position, ProtectChain } from '@/lib/actions/protect';

const prog = program(new Connection('http://127.0.0.1:1'));
const DEFAULT = '11111111111111111111111111111111';
const MARKET = '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua';
const NOW = 1_791_000_000;
export const QUOTE = 8_612_345n; // stands in for the simulated quote_cover

const pk = () => Keypair.generate().publicKey;
const reserve = (): ReserveState => ({
  lendingMarket: MARKET,
  config: { tokenInfo: { pythConfiguration: { price: DEFAULT }, switchboardConfiguration: { priceAggregator: DEFAULT, twapAggregator: DEFAULT },
    scopeConfiguration: { priceFeed: SCOPE_PRICES.toBase58() } } },
}) as unknown as ReserveState;
const obligation = (deps: PublicKey[], bors: PublicKey[]): ObligationState => ({
  lendingMarket: MARKET,
  deposits: [...deps.map((d) => ({ depositReserve: d.toBase58() })), { depositReserve: DEFAULT }],
  borrows: [...bors.map((b) => ({ borrowReserve: b.toBase58() })), { borrowReserve: DEFAULT }],
}) as unknown as ObligationState;
const asset = (ticker: string, dep: PublicKey): Asset => ({ key: pdas.asset(ticker), ticker, tickerBytes: ticker8(ticker), mint: pk(), sigmaWad: 9_400_000_000_000_000n,
  settleSource: 2, scopeChain: 0, reserves: [dep.toBase58()], enabled: true, feedXstock: [] });
const epoch = (ticker: string, closureId: number): EpochView => ({ key: pdas.epoch(ticker, closureId), ticker, closureId, closureType: 2, state: 0, saleOpen: NOW - 86_400,
  bell: NOW + 3_600, close: NOW + 4_500, open: NOW + 235_800, settleAfter: 0, settledAt: 0, closePriceWad: 0n, settlePriceWad: 0n, policyCount: 0,
  policiesSettled: 0, totalMaxPayout: 0n, totalPremium: 0n, totalPayout: 0n, worstLossSum: 0n });

type Ctx =
  | { kind: 'kamino'; asset: Asset; epoch: EpochView; o: ObligationState; reserves: Map<string, ReserveState> }
  | { kind: 'kamino-multi'; legs: { asset: PublicKey; ticker: string; epoch: PublicKey }[]; closureId: number; o: ObligationState; reserves: Map<string, ReserveState>; borrow: PublicKey }
  | { kind: 'jupiter'; asset: JlAsset; epoch: EpochView; nftAccount: PublicKey };

export function fixture() {
  const owner = Keypair.generate();
  const stranger = Keypair.generate();
  const positions = new Map<string, Position & { ctx: Ctx }>();
  const calls = { load: 0, quote: 0, build: 0 };

  const base = (lender: Lender, kind: Position['kind'], ticker: string, ctx: Ctx, over: Partial<Position> = {}) => {
    const key = pk();
    const p: Position & { ctx: Ctx } = {
      lender, kind, key, owner: owner.publicKey, ticker, why: null,
      sale: { epoch: pdas.epoch(ticker.split(' ')[0], 42).toBase58(), closureId: 42, closureType: 2, bell: NOW + 3_600 }, saleNote: null, now: NOW,
      snap: { coveredValue: 52_083_333_333n, debt: 50_000_000_000n }, snapNote: null, odds: kind === 'kamino-multi' ? null : { count: 19, n: 3000, p: 19 / 3000 },
      ctx, ...over,
    };
    positions.set(key.toBase58(), p);
    return p;
  };

  const dep = pk(), bor = pk();
  const single = (): Ctx => ({ kind: 'kamino', asset: asset('SPYx', dep), epoch: epoch('SPYx', 42), o: obligation([dep], [bor]), reserves: new Map([[dep.toBase58(), reserve()], [bor.toBase58(), reserve()]]) });
  const kamino = base('kamino', 'kamino', 'SPYx', single());
  const dep2 = pk();
  const multi = base('kamino', 'kamino-multi', 'SPYx + QQQx', {
    kind: 'kamino-multi', closureId: 42, borrow: bor, o: obligation([dep, dep2], [bor]),
    reserves: new Map([[dep.toBase58(), reserve()], [dep2.toBase58(), reserve()], [bor.toBase58(), reserve()]]),
    legs: [{ asset: pdas.asset('SPYx'), ticker: 'SPYx', epoch: pdas.epoch('SPYx', 42) }, { asset: pdas.asset('QQQx'), ticker: 'QQQx', epoch: pdas.epoch('QQQx', 42) }],
  });
  const jlAsset: JlAsset = { key: pdas.asset('SPYx.J'), ticker: 'SPYx.J', tickerBytes: ticker8('SPYx.J'), lenderVault: pk(), lenderOracle: pk(), enabled: true, sigmaWad: 9_400_000_000_000_000n };
  const jupiter = base('jupiter', 'jupiter', 'SPYx.J', { kind: 'jupiter', asset: jlAsset, epoch: epoch('SPYx.J', 42), nftAccount: pk() });
  const ineligible = base('kamino', 'kamino', 'SPYx', single(), { why: '2 borrows: one USDC borrow is covered' });
  const afterBell = base('kamino', 'kamino', 'SPYx', single(), { sale: null, saleNote: 'sales closed at the bell (Fri Oct 9, 3:45 PM ET)' });
  const bellStale = base('kamino', 'kamino', 'SPYx', single(), { now: NOW + 3_600 }); // the clock reached the bell
  const noHolder = base('jupiter', 'jupiter', 'SPYx.J', { kind: 'jupiter', asset: jlAsset, epoch: epoch('SPYx.J', 42), nftAccount: pk() }, { owner: null });

  const chain: ProtectChain & { failWith?: Error; hang?: boolean; mutate?: (tx: string) => Promise<string> } = {
    async load(_lender, key) {
      calls.load++;
      if (chain.hang) return new Promise(() => {});
      if (chain.failWith) throw chain.failWith;
      const p = positions.get(key.toBase58());
      return p ? { ...p } : null;
    },
    async quote() {
      calls.quote++;
      return { premium: QUOTE, cu: 61_000 };
    },
    async build(p, account, maxPayout, maxPremium) {
      calls.build++;
      const ctx = (p as Position & { ctx: Ctx }).ctx;
      const feeAccount = pk();
      const args = { buyer: account, feeAccount, maxPayout, maxPremium };
      const ixs = ctx.kind === 'kamino'
        ? (await kaminoBuy(prog, { ...args, asset: ctx.asset, epoch: ctx.epoch, obligation: p.key, o: ctx.o, reserves: ctx.reserves })).ixs
        : ctx.kind === 'kamino-multi'
          ? (await kaminoMultiBuy(prog, { ...args, closureId: ctx.closureId, legs: ctx.legs, obligation: p.key, o: ctx.o, reserves: ctx.reserves, borrowReserve: ctx.borrow, sleeve: null })).ixs
          : (await jupiterBuy(prog, { ...args, asset: ctx.asset, epoch: ctx.epoch, position: p.key, pos: { vaultId: 78, nftId: 7, mint: pk(), supplyOnly: false, tick: -400 }, nftAccount: ctx.nftAccount })).ixs;
      const tx = encodeTx(assembleTx(account, pk().toBase58(), ixs, 240_000));
      return { transaction: chain.mutate ? await chain.mutate(tx) : tx, cu: 161_000 };
    },
  };
  return { chain, calls, owner, stranger, kamino, multi, jupiter, ineligible, afterBell, bellStale, noHolder, now: NOW, usdc: USDC_MINT };
}
