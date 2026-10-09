// The Protect Action's chain on the local mainnet fork (server only). Every number comes from the program:
//   C′ and D: Kamino single-asset, klend's refresh simulated and read as buy_cover reads it (lib/kamino `snapshot`, the
//     app's own mirror of credence-core `snapshot_values`); multi-collateral and Jupiter Lend, the buy itself simulated
//     (cap 1 base unit) and its Policy account read back from the simulation (credence-core's own snapshot)
//   the premium: quote_cover simulated (Kamino single-asset, as the app does), else the buy simulated and its Policy's
//     premium read back
//   the chance it pays anything: lib/odds `modelPays` over the asset's on-chain WEEKEND scenario set, as the app shows it
// Fork upkeep (labelled, fork only, as the app does before a buy): Kamino's Scope refresh times and Jupiter's oracle
// cache refresh time are moved to the fork clock (prices unchanged), and accounts the buy creates are marked local-only.
import 'server-only';
import { ComputeBudgetProgram, Connection, PublicKey, type TransactionInstruction } from '@solana/web3.js';
import { POST as forkOffline } from '@/app/api/fork/offline/route';
import { POST as scopeFresh } from '@/app/api/fork/scope-fresh/route';
import { type Asset, type EpochView, type Row, currentEpoch, loadAssets, loadEpochs, reserveToAsset, scopeChains, simulateQuote } from '@/lib/cover';
import { type CoreProgram, EPOCH, KLEND, USDC_MINT, XSTOCKS_MARKETS, big, chainNow, pdas, program, tickerStr } from '@/lib/credence';
import { et } from '@/lib/format';
import { type ObligationState, type ReserveState, borrows, decodeObligation, deposits, ineligibility, loadReserves, simulateRefreshed, snapshot } from '@/lib/kamino';
import { loadScenarioZ, modelPays } from '@/lib/odds';
import { FORK_RPC, getAccount, setAccount } from '@/lib/server/fork';
import { TxError, decodeError } from '@/lib/tx';
import { type JlAsset, type JlPosition, JL_MIN_TICK, JL_VAULTS, type Leg, assembleTx, cuLimitFor, decodeJlPosition, encodeTx, jupiterBuy, kaminoBuy, kaminoMultiBuy } from './build';
import { timeoutFetch } from './guard';
import { type Lender, type Position, type ProtectChain, Refusal } from './protect';

const WEEKEND = 2;
const U64_MAX = (1n << 64n) - 1n;
const CACHE_DISC = Buffer.from([65, 102, 75, 47, 79, 156, 109, 193]);
const LOCAL = /^(127\.0\.0\.1|localhost)$/;

type Ctx =
  | { kind: 'kamino'; asset: Asset; epoch: EpochView | null; o: ObligationState; reserves: Map<string, ReserveState> }
  | { kind: 'kamino-multi'; legs: Leg[]; closureId: number; o: ObligationState; reserves: Map<string, ReserveState>; borrow: PublicKey }
  | { kind: 'jupiter'; asset: JlAsset; epoch: EpochView | null; pos: JlPosition; nftAccount: PublicKey | null };

export class ForkChain implements ProtectChain {
  readonly conn: Connection;
  readonly prog: CoreProgram;
  private ctx = new WeakMap<Position, Ctx>();
  readonly local: boolean;

  constructor(rpcUrl = FORK_RPC, rpcTimeoutMs = 8_000) {
    this.conn = new Connection(rpcUrl, { commitment: 'confirmed', fetch: timeoutFetch(rpcTimeoutMs) });
    this.prog = program(this.conn);
    this.local = LOCAL.test(new URL(rpcUrl).hostname);
  }

  async load(lender: Lender, key: PublicKey): Promise<Position | null> {
    const acc = await this.conn.getAccountInfo(key, 'confirmed');
    if (!acc) return null;
    return lender === 'kamino' ? this.loadKamino(key, acc.owner, acc.data) : this.loadJupiter(key, acc.owner, acc.data);
  }

  private async loadKamino(key: PublicKey, owner: PublicKey, data: Buffer): Promise<Position | null> {
    if (!owner.equals(KLEND)) return null;
    let o: ObligationState;
    try { o = decodeObligation(data); } catch { return null; }
    const [assets, epochs, now, cfg] = await Promise.all([loadAssets(this.prog), loadEpochs(this.prog), chainNow(this.conn), this.prog.account.config.fetch(pdas.config())]);
    const reserves = await loadReserves(this.conn, [...deposits(o), ...borrows(o)]);
    const byReserve = reserveToAsset(assets);
    const tickers = new Map([...byReserve].map(([r, a]) => [r, a.ticker]));
    const base = { lender: 'kamino' as const, key, owner: new PublicKey(o.owner), now, snap: null, snapNote: null, odds: null };
    const single = ineligibility(o, reserves, tickers);
    if (single === null) {
      const asset = byReserve.get(deposits(o)[0].toBase58())!;
      const epoch = currentEpoch(epochs, asset.ticker, now) ?? null;
      const p: Position = { ...base, kind: 'kamino', ticker: asset.ticker, why: null, ...sale(epochs, [asset.ticker], now, epoch) };
      this.ctx.set(p, { kind: 'kamino', asset, epoch, o, reserves });
      if (!p.sale) return p;
      await this.freshenScope(reserves);
      try {
        const r = await simulateRefreshed(this.conn, p.owner!, key, o, reserves);
        const s = snapshot(r.state);
        p.snap = { coveredValue: s.coveredValue, debt: s.debt };
        const z = await loadScenarioZ(this.conn, asset.ticker);
        p.odds = modelPays(z, asset.sigmaWad, s.coveredValue, s.debt);
      } catch (e) {
        p.snapNote = 'klend refresh could not be simulated';
        console.error('[actions/protect] refresh', (e as Error).message?.split('\n')[0]?.slice(0, 120));
      }
      return p;
    }
    // Several deposits: buy_cover_multi if every deposit is a covered xStock or a stablecoin and the one borrow is USDC
    // or PYUSD (credence-core cover_multi.rs; weekend epochs only, A-63).
    const multi = multiLegs(o, reserves, byReserve, [USDC_MINT.toBase58(), (cfg.pyusdMint as PublicKey).toBase58()]);
    if (!multi) return { ...base, kind: 'kamino', ticker: tickerOf(o, byReserve), why: single, sale: null, saleNote: null };
    const leg0 = weekendEpoch(epochs, multi.legs[0].ticker, now);
    const legEpochs = leg0 ? multi.legs.map((l) => epochs.find((e) => e.ticker === l.ticker && e.closureId === leg0.closureId && e.state === EPOCH.OPEN)) : [];
    const ok = leg0 && legEpochs.every(Boolean);
    const legs: Leg[] = multi.legs.map((l, i) => ({ asset: l.asset.key, ticker: l.asset.ticker, epoch: ok ? legEpochs[i]!.key : PublicKey.default }));
    const p: Position = { ...base, kind: 'kamino-multi', ticker: multi.legs.map((l) => l.ticker).join(' + '), why: null,
      ...sale(epochs, multi.legs.map((l) => l.ticker), now, ok ? leg0 : null, 'multi-collateral cover sells weekend epochs only') };
    const ctx: Ctx = { kind: 'kamino-multi', legs, closureId: leg0?.closureId ?? 0, o, reserves, borrow: borrows(o)[0] };
    this.ctx.set(p, ctx);
    if (!p.sale) return p;
    await this.freshenScope(reserves); // the probe, the quote and the buy all run klend's refreshes (audit A-113)
    await this.probe(p, ctx);
    return p;
  }

  private async loadJupiter(key: PublicKey, owner: PublicKey, data: Buffer): Promise<Position | null> {
    if (!owner.equals(JL_VAULTS)) return null;
    const pos = decodeJlPosition(data);
    if (!pos) return null;
    const [assets, epochs, now] = await Promise.all([jlAssets(this.prog), loadEpochs(this.prog), chainNow(this.conn)]);
    const configs = await this.conn.getMultipleAccountsInfo(assets.map((a) => a.lenderVault), 'confirmed');
    const asset = assets.find((_, i) => configs[i] && configs[i]!.data.length >= 10 && configs[i]!.data.readUInt16LE(8) === pos.vaultId);
    const holder = await this.nftHolder(pos.mint);
    const base = { lender: 'jupiter' as const, kind: 'jupiter' as const, key, owner: holder?.owner ?? null, now, snap: null, snapNote: null, odds: null };
    if (!asset) return { ...base, ticker: `Jupiter Lend vault ${pos.vaultId}`, why: `Jupiter Lend vault ${pos.vaultId} is not covered by Credence`, sale: null, saleNote: null };
    const why = pos.supplyOnly || pos.tick <= JL_MIN_TICK ? 'no debt: a supply-only Jupiter Lend position has nothing to protect'
      : !asset.enabled ? `${asset.ticker} is not enabled for sale` : null;
    const epoch = weekendEpoch(epochs, asset.ticker, now) ?? null;
    const p: Position = { ...base, ticker: asset.ticker, why, ...sale(epochs, [asset.ticker], now, epoch, 'Jupiter Lend cover sells weekend epochs only') };
    const ctx: Ctx = { kind: 'jupiter', asset, epoch, pos, nftAccount: holder?.account ?? null };
    this.ctx.set(p, ctx);
    if (why || !p.sale || !p.owner) return p;
    await this.freshenJlCache(asset.lenderOracle);
    await this.probe(p, ctx);
    if (p.snap) p.odds = modelPays(await loadScenarioZ(this.conn, asset.ticker), asset.sigmaWad, p.snap.coveredValue, p.snap.debt);
    return p;
  }

  /** C′ and D for multi-collateral and Jupiter: the buy simulated with a 1-unit cap, its Policy read back. */
  private async probe(p: Position, ctx: Ctx) {
    try {
      const pol = await this.simulateBuy(p, ctx, p.owner!, 1n, U64_MAX, true);
      p.snap = { coveredValue: pol!.coveredValue, debt: pol!.debt };
    } catch (e) {
      p.snapNote = e instanceof Refusal ? e.message : 'the purchase could not be simulated';
    }
  }

  async quote(p: Position, maxPayout: bigint) {
    const ctx = this.need(p);
    if (ctx.kind === 'kamino') {
      try {
        const q = await simulateQuote(this.conn, this.prog, p.owner!, ctx.asset, ctx.epoch!, p.snap!.coveredValue, p.snap!.debt, maxPayout);
        return { premium: q.premium, cu: q.cu };
      } catch (e) {
        if (e instanceof TxError) throw new Refusal(e.message);
        throw e;
      }
    }
    const pol = await this.simulateBuy(p, ctx, p.owner!, maxPayout, U64_MAX, true);
    return { premium: pol!.premium, cu: pol!.cu };
  }

  async build(p: Position, account: PublicKey, maxPayout: bigint, maxPremium: bigint) {
    const ctx = this.need(p);
    const ixs = await this.buyIxs(ctx, p, account, maxPayout, maxPremium);
    const sim = await this.simulateBuy(p, ctx, account, maxPayout, maxPremium, false, ixs);
    const { blockhash } = await this.conn.getLatestBlockhash('confirmed');
    const tx = assembleTx(account, blockhash, ixs, cuLimitFor(sim!.cu));
    if (this.local) {
      const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
      const r = await forkOffline(new Request('http://fork.local/', { method: 'POST', body: JSON.stringify({ keys }) }));
      if (!r.ok) throw new Error(`fork preparation failed: ${((await r.json()) as { error: string }).error}`);
    }
    return { transaction: encodeTx(tx), cu: sim!.cu };
  }

  private need(p: Position): Ctx {
    const c = this.ctx.get(p);
    if (!c || !p.owner || !p.snap) throw new Refusal('the position was not loaded for a purchase');
    return c;
  }

  private async buyIxs(ctx: Ctx, p: Position, buyer: PublicKey, maxPayout: bigint, maxPremium: bigint): Promise<TransactionInstruction[]> {
    const v = await this.prog.account.vault.fetch(pdas.vault());
    const args = { buyer, feeAccount: v.feeAccount as PublicKey, maxPayout, maxPremium };
    if (ctx.kind === 'kamino') return (await kaminoBuy(this.prog, { ...args, asset: ctx.asset, epoch: ctx.epoch!, obligation: p.key, o: ctx.o, reserves: ctx.reserves })).ixs;
    if (ctx.kind === 'kamino-multi') {
      const sleeve = (v.pyusdSleeve as PublicKey).equals(PublicKey.default) ? null : (v.pyusdSleeve as PublicKey);
      return (await kaminoMultiBuy(this.prog, { ...args, closureId: ctx.closureId, legs: ctx.legs, obligation: p.key, o: ctx.o, reserves: ctx.reserves, borrowReserve: ctx.borrow, sleeve })).ixs;
    }
    if (!ctx.nftAccount) throw new Refusal('nobody holds this position NFT', 403);
    return (await jupiterBuy(this.prog, { ...args, asset: ctx.asset, epoch: ctx.epoch!, position: p.key, pos: ctx.pos, nftAccount: ctx.nftAccount })).ixs;
  }

  /** Simulates the buy (sigVerify off, the fork's blockhash); a refusal is the decoded CoreError. With `readPolicy`,
   * the Policy account as the simulation leaves it. */
  private async simulateBuy(p: Position, ctx: Ctx, buyer: PublicKey, maxPayout: bigint, maxPremium: bigint, readPolicy: boolean, given?: TransactionInstruction[]) {
    const ixs = given ?? (await this.buyIxs(ctx, p, buyer, maxPayout, maxPremium));
    const { blockhash } = await this.conn.getLatestBlockhash('confirmed');
    const tx = assembleTx(buyer, blockhash, ixs, 1_400_000);
    const policy = policyOf(ctx, p.key);
    const r = await this.conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'confirmed',
      ...(readPolicy ? { accounts: { encoding: 'base64' as const, addresses: [policy.toBase58()] } } : {}) });
    const programs = [ComputeBudgetProgram.programId, ComputeBudgetProgram.programId, ...ixs.map((i) => i.programId)];
    if (r.value.err) throw new Refusal(refusalText(r.value.err, r.value.logs, programs));
    const cu = r.value.unitsConsumed ?? 0;
    if (!readPolicy) return { premium: 0n, coveredValue: 0n, debt: 0n, cu };
    const a = r.value.accounts?.[0];
    if (!a) throw new Refusal('the simulation returned no Policy');
    const pol = this.prog.coder.accounts.decode('policy', Buffer.from(a.data[0], 'base64'));
    return { premium: big(pol.premium), coveredValue: big(pol.coveredValue), debt: big(pol.debt), cu };
  }

  /** FORK ONLY: Kamino's Scope chains for these reserves restamped to the fork clock (the app's /api/fork/scope-fresh). */
  private async freshenScope(reserves: Map<string, ReserveState>) {
    if (!this.local) return;
    const r = await scopeFresh(new Request('http://fork.local/', { method: 'POST', body: JSON.stringify({ pairs: scopeChains([...reserves.values()]) }) }));
    if (!r.ok) throw new Error(`scope upkeep failed: ${((await r.json()) as { error: string }).error}`);
  }

  /** FORK ONLY: Jupiter's oracle cache keeps its price; its refresh time moves to the fork clock (buy_cover_jl refuses
   * a cache older than 10 minutes, and nothing updates it on a fork). As keeper/src/jl-demo.ts `writeCache`. */
  private async freshenJlCache(key: PublicKey) {
    if (!this.local) return;
    const a = await getAccount(key.toBase58());
    if (!a || !a.data.subarray(0, 8).equals(CACHE_DISC)) return;
    const now = BigInt(await chainNow(this.conn));
    const d = Buffer.from(a.data);
    const o = 14 + 34 * d.readUInt32LE(10);
    d.writeBigUInt64LE(now, o + 16);
    d.writeBigUInt64LE(now, o + 24);
    d.writeBigUInt64LE(now * 1000n, o + 32);
    await setAccount(key.toBase58(), { lamports: a.lamports, data: d, owner: a.owner });
  }

  /** The token account holding the position NFT (amount 1) and its owner. */
  private async nftHolder(mint: PublicKey): Promise<{ account: PublicKey; owner: PublicKey } | null> {
    const largest = await this.conn.getTokenLargestAccounts(mint, 'confirmed');
    const top = largest.value.find((x) => x.amount === '1');
    if (!top) return null;
    const a = await this.conn.getAccountInfo(top.address, 'confirmed');
    if (!a || a.data.length < 72) return null;
    return { account: top.address, owner: new PublicKey(a.data.subarray(32, 64)) };
  }
}

function policyOf(ctx: Ctx, position: PublicKey) {
  if (ctx.kind === 'kamino') return pdas.policy(ctx.epoch!.key, position);
  if (ctx.kind === 'kamino-multi') return pdas.policy(ctx.legs[0].epoch, position);
  return pdas.policy(ctx.epoch!.key, position);
}

/** The decoded CoreError; a token-program shortfall in the premium transfer reads as such. */
function refusalText(err: unknown, logs: string[] | null, programs: PublicKey[]): string {
  if ((logs ?? []).some((l) => /insufficient funds/i.test(l))) return 'the wallet does not hold enough USDC for the premium';
  if ((logs ?? []).some((l) => /AccountNotInitialized.*buyer_usdc|buyer_usdc.*AccountNotInitialized/.test(l))) return 'the wallet has no USDC account';
  return decodeError(err, logs, programs);
}

/** The epoch sale fields of a Position, and why there is none when there is none. */
export function sale(epochs: EpochView[], tickers: string[], now: number, epoch: EpochView | null | undefined, onlyWeekend?: string): Pick<Position, 'sale' | 'saleNote'> {
  if (epoch) return { sale: { epoch: epoch.key.toBase58(), closureId: epoch.closureId, closureType: epoch.closureType ?? WEEKEND, bell: epoch.bell }, saleNote: null };
  const open = epochs.filter((e) => tickers.includes(e.ticker) && e.state === EPOCH.OPEN);
  const past = open.filter((e) => now >= e.bell).sort((a, b) => b.bell - a.bell)[0];
  const next = open.filter((e) => now < e.saleOpen).sort((a, b) => a.saleOpen - b.saleOpen)[0];
  const onSale = open.some((e) => now >= e.saleOpen && now < e.bell);
  if (onSale && onlyWeekend) return { sale: null, saleNote: onlyWeekend };
  if (next) return { sale: null, saleNote: `sales open ${et(next.saleOpen)}` };
  if (past) return { sale: null, saleNote: `sales closed at the bell (${et(past.bell)})` };
  return { sale: null, saleNote: 'no epoch is open for this asset on the fork (the keeper opens them)' };
}

const weekendEpoch = (epochs: EpochView[], ticker: string, now: number) =>
  epochs.find((e) => e.ticker === ticker && e.closureType === WEEKEND && e.state === EPOCH.OPEN && now >= e.saleOpen && now < e.bell);

const tickerOf = (o: ObligationState, byReserve: Map<string, Asset>) =>
  deposits(o).map((d) => byReserve.get(d.toBase58())?.ticker).find(Boolean) ?? 'xStock';

/** Legs of a buy_cover_multi in order of first appearance among the deposits (A-45), or null when a deposit is neither
 * a covered xStock nor a stablecoin, there is no xStock, or the borrow is not one USDC / PYUSD borrow. */
export function multiLegs(o: ObligationState, reserves: Map<string, ReserveState>, byReserve: Map<string, Asset>, stables: string[]) {
  const deps = deposits(o), bors = borrows(o);
  if (deps.length < 2 || bors.length !== 1 || XSTOCKS_MARKETS[o.lendingMarket] === undefined) return null;
  const br = reserves.get(bors[0].toBase58());
  if (!br || !stables.includes(br.liquidity.mintPubkey)) return null;
  const legs: { asset: Asset; ticker: string }[] = [];
  for (const d of deps) {
    const a = byReserve.get(d.toBase58());
    if (a) { if (!legs.some((l) => l.asset.key.equals(a.key))) legs.push({ asset: a, ticker: a.ticker }); continue; }
    const r = reserves.get(d.toBase58());
    if (!r || !stables.includes(r.liquidity.mintPubkey)) return null;
  }
  return legs.length && legs.length <= 8 ? { legs } : null;
}

/** Jupiter Lend alias assets (`<T>.J`, lender 1). */
async function jlAssets(prog: CoreProgram): Promise<JlAsset[]> {
  const rows = ((await prog.account.assetConfig.all()) as Row[]).filter(({ account: a }) => Number(big(a.lender ?? 0)) === 1);
  return rows.map(({ publicKey, account: a }) => ({ key: publicKey, ticker: tickerStr(a.ticker), tickerBytes: a.ticker as number[],
    lenderVault: a.lenderVault as PublicKey, lenderOracle: a.lenderOracle as PublicKey, enabled: a.enabled === 1, sigmaWad: big(a.sigmaWad) }));
}

let shared: ForkChain | null = null;
/** One chain per server process (its Connection is reused). */
export const forkChain = () => (shared ??= new ForkChain());
