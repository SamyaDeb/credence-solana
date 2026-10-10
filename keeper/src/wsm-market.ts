// FORK ONLY (D1): creates the weekend-safe klend market on the surfpool fork, with real klend instructions, so that a
// user can run `wsm_open … wsm_borrow` against it. What is simulated, and said so in the demo's result:
//   - the market's account address is the program's `WSM_MARKET` constant, which has no secret key: the zeroed account is
//     written with a cheatcode and klend's own `init_lending_market` initialises it;
//   - klend's global config is overwritten so the keeper wallet is the global admin (on mainnet that key is Kamino's: the
//     reserve-config modes this uses are not all available to a market owner);
//   - the seed deposits and the external LP's USDC come from cheatcodes.
// The reserves use Kamino's own xStocks-market values (read from the live reserves on the fork) with the proposed limits.
import { createHash } from 'node:crypto';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import { type Chain, FARMS, chainNow, fmtTime, INSTRUCTIONS_SYSVAR, KLEND, SCOPE_PRICES, TOKEN, TOKEN_2022, USDC_MINT, WSM_MARKET, ata, createAtaIx, log, pdas, pk, send, ticker8 } from './chain.js';
import { setAccount, setTokenBalance, timeTravel } from './fork.js';
import { loadReserve } from './kamino.js';

type Pk = InstanceType<typeof web3.PublicKey>;
const RENT = pk('SysvarRent111111111111111111111111111111111');
const GLOBAL_CONFIG = pk('BEe6HXZf6cByeb8iCxukjB8k74kJN3cVbBAGi49Hfi6W');
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const klendPda = (seeds: Buffer[]) => web3.PublicKey.findProgramAddressSync(seeds, KLEND)[0];
const u64 = (v: bigint | number) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b; };
const u16 = (v: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const m = (pubkey: Pk, o: { w?: boolean; s?: boolean } = {}) => ({ pubkey, isWritable: !!o.w, isSigner: !!o.s });

/** Kamino's xStocks-market reserves on mainnet (the values the new market starts from) and the proposed limits (plan/09 D1.0). */
export const WSM_ASSETS = [
  { ticker: 'SPYx', reserve: 'UvXjBuC7YZYaGB9Rn1PpBD1GySmjzunXgE8Zev9ua8d', ltv: 80, lt: 85, normalLtv: 0.73 },
  { ticker: 'QQQx', reserve: '2jerdAXR8r2B6z3P7P6VgSiePQX7wqcpbEqdDbm8mgeB', ltv: 77, lt: 82, normalLtv: 0.70 },
  { ticker: 'NVDAx', reserve: '7B66Az3tJhAo4bLkX8PzTixQ9ZGyHkkjxfVLhF26sP5q', ltv: 60, lt: 70, normalLtv: 0.55 },
] as const;
const USDC_SRC = '97zoywd8mPZsGTg8q1wdD2Wgkdrs2tqusp1Qqcxbyj7E';

export type WsmReserveKeys = { key: Pk; mint: Pk; liqSupply: Pk; feeVault: Pk; collMint: Pk; collSupply: Pk; tokenProgram: Pk };
export const reserveKeys = (key: Pk, mint: Pk, tokenProgram: Pk): WsmReserveKeys => ({
  key, mint, tokenProgram,
  liqSupply: klendPda([Buffer.from('reserve_liq_supply'), key.toBuffer()]),
  feeVault: klendPda([Buffer.from('fee_receiver'), key.toBuffer()]),
  collMint: klendPda([Buffer.from('reserve_coll_mint'), key.toBuffer()]),
  collSupply: klendPda([Buffer.from('reserve_coll_supply'), key.toBuffer()]),
});

/** Reserve keypairs are random, so the market is recorded in data/demo (a fork keeps it until it is torn down). */
export type WsmMarketKeys = { lma: Pk; reserves: Record<string, WsmReserveKeys>; usdc: WsmReserveKeys };

function updateReserve(c: Chain, reserve: Pk, mode: number, value: Buffer, validate = false) {
  // UpdateConfigMode borsh-encodes its variant index (discriminant − 1), then the value (Vec<u8>) and the skip flag.
  const len = Buffer.alloc(4); len.writeUInt32LE(value.length);
  return new web3.TransactionInstruction({
    programId: KLEND, data: Buffer.concat([disc('update_reserve_config'), Buffer.from([mode - 1]), len, value, Buffer.from([validate ? 0 : 1])]),
    keys: [m(c.payer.publicKey, { s: true }), m(GLOBAL_CONFIG), m(WSM_MARKET), m(reserve, { w: true }), m(INSTRUCTIONS_SYSVAR)],
  });
}
function updateMarket(c: Chain, mode: number, value: Buffer) {
  const v = Buffer.alloc(72); value.copy(v);
  return new web3.TransactionInstruction({
    programId: KLEND, data: Buffer.concat([disc('update_lending_market'), u64(mode), v]),
    keys: [m(c.payer.publicKey, { s: true }), m(WSM_MARKET, { w: true }), m(INSTRUCTIONS_SYSVAR)],
  });
}

/** One reserve: Kamino's live values for the asset, with the proposed LTV / LT. Returns its keys. */
async function addReserve(c: Chain, lma: Pk, src: string, mint: Pk, tokenProgram: Pk, ltv: number | null, lt: number | null): Promise<WsmReserveKeys> {
  const live = await loadReserve(c, pk(src)); // Kamino's reserve on the fork, cloned from mainnet
  const reserve = web3.Keypair.generate().publicKey;
  const k = reserveKeys(reserve, mint, tokenProgram);
  await setAccount(c, reserve.toBase58(), { lamports: 70_000_000, data: Buffer.alloc(8 + 8616), owner: KLEND.toBase58() });
  await setTokenBalance(c, c.payer.publicKey.toBase58(), mint.toBase58(), 1_000_000n, tokenProgram.equals(TOKEN_2022) ? TOKEN_2022.toBase58() : undefined);
  const srcAta = ata(c.payer.publicKey, mint, tokenProgram);
  await send(c, [new web3.TransactionInstruction({
    programId: KLEND, data: disc('init_reserve'),
    keys: [m(c.payer.publicKey, { w: true, s: true }), m(WSM_MARKET), m(lma), m(reserve, { w: true }), m(mint), m(k.liqSupply, { w: true }), m(k.feeVault, { w: true }),
      m(k.collMint, { w: true }), m(k.collSupply, { w: true }), m(srcAta, { w: true }), m(RENT), m(tokenProgram), m(TOKEN), m(web3.SystemProgram.programId), m(INSTRUCTIONS_SYSVAR)],
  })]);
  const cfg = live.config;
  const ti = cfg.tokenInfo;
  const name = Buffer.alloc(32); Buffer.from(ti.name as number[]).copy(name);
  const chainBuf = (a: number[]) => Buffer.concat(a.map(u16));
  const curve = Buffer.concat(cfg.borrowRateCurve.points.map((p) => { const b = Buffer.alloc(8); b.writeUInt32LE(p.utilizationRateBps); b.writeUInt32LE(p.borrowRateBps, 4); return b; }));
  const cap = (limit: bigint) => Buffer.concat([u64(limit), u64(86_400)]);
  const steps: [number, Buffer][] = [
    [1, Buffer.from([ltv ?? cfg.loanToValuePct])], [3, Buffer.from([lt ?? cfg.liquidationThresholdPct])],
    [2, u16(cfg.maxLiquidationBonusBps)], [31, u16(cfg.minLiquidationBonusBps)], [30, u16(cfg.badDebtLiquidationBonusBps)],
    [4, Buffer.from([cfg.protocolLiquidationFeePct])], [5, Buffer.from([cfg.protocolTakeRatePct])],
    [11, u64(BigInt(ti.heuristic.lower.toString()))], [12, u64(BigInt(ti.heuristic.upper.toString()))], [13, u64(BigInt(ti.heuristic.exp.toString()))],
    [14, u64(BigInt(ti.maxTwapDivergenceBps.toString()))], [20, new web3.PublicKey(ti.scopeConfiguration.priceFeed).toBuffer()],
    [16, chainBuf(ti.scopeConfiguration.priceChain)], [15, chainBuf(ti.scopeConfiguration.twapChain)], [17, name],
    [18, u64(BigInt(ti.maxAgePriceSeconds.toString()))], [19, u64(BigInt(ti.maxAgeTwapSeconds.toString()))], [24, curve],
    [33, u64(BigInt(cfg.borrowFactorPct.toString()))], [36, u64(7200)], [32, u64(604_800)], [39, Buffer.from([0])],
    [26, cap(BigInt(cfg.borrowLimit.toString()))], [27, cap(BigInt(cfg.depositLimit.toString()))],
    // The default is 0 and blocks every borrow: unlimited, as Kamino's reserves are.
    [45, u64(0xffffffffffffffffn)],
    [9, u64(BigInt(cfg.depositLimit.toString()))], [10, u64(BigInt(cfg.borrowLimit.toString()))],
  ];
  for (const [mode, value] of steps) {
    // The two limits come last and run klend's full integrity check; the rest are set with it skipped while the reserve is blocked.
    await send(c, [updateReserve(c, reserve, mode, value, mode === 9 || mode === 10)]);
  }
  return k;
}

export async function wsmMarketExists(c: Chain): Promise<boolean> {
  const a = await c.conn.getAccountInfo(pdas.wsmMarket());
  return !!a && a.data.length > 0;
}

/** Creates the market, its four reserves, permissions it for BORROW to `["wsm_auth"]`, seeds an external LP and registers it with
 * `init_wsm_market`. Returns the keys. The caller must be the keeper wallet (it becomes the market owner). */
export async function createWsmMarket(c: Chain, lpUsdc: number, simulated: string[]): Promise<WsmMarketKeys> {
  const lma = klendPda([Buffer.from('lma'), WSM_MARKET.toBuffer()]);
  await setAccount(c, WSM_MARKET.toBase58(), { lamports: 34_000_000, data: Buffer.alloc(8 + 4656), owner: KLEND.toBase58() });
  // surfpool clones mainnet accounts lazily and a fetch can fail transiently: retry.
  let gc = null as Awaited<ReturnType<typeof c.conn.getAccountInfo>>;
  for (let i = 0; i < 6 && !gc; i++) {
    try { gc = await c.conn.getAccountInfo(GLOBAL_CONFIG); } catch (e) { log(`  retry global config fetch: ${(e as Error).message.slice(0, 60)}`); await new Promise((r) => setTimeout(r, 2000)); }
  }
  if (!gc) throw new Error('klend global config not readable on the fork');
  const g = Buffer.from(gc.data);
  c.payer.publicKey.toBuffer().copy(g, 8);
  await setAccount(c, GLOBAL_CONFIG.toBase58(), { lamports: gc.lamports, data: g, owner: KLEND.toBase58() });
  simulated.push(`The weekend-safe market's address ${WSM_MARKET.toBase58()} is a program constant with no secret key: the zeroed account was written with a cheatcode and klend's own init_lending_market initialised it.`);
  simulated.push('klend\'s global config was overwritten so the keeper wallet is its global admin (on mainnet that is Kamino\'s key).');
  const quote = Buffer.alloc(32); Buffer.from('USD').copy(quote);
  await send(c, [new web3.TransactionInstruction({
    programId: KLEND, data: Buffer.concat([disc('init_lending_market'), quote]),
    keys: [m(c.payer.publicKey, { w: true, s: true }), m(WSM_MARKET, { w: true }), m(lma), m(web3.SystemProgram.programId), m(RENT), m(INSTRUCTIONS_SYSVAR)],
  })]);
  const reserves: Record<string, WsmReserveKeys> = {};
  for (const a of WSM_ASSETS) {
    const live = await loadReserve(c, pk(a.reserve));
    reserves[a.ticker] = await addReserve(c, lma, a.reserve, pk(live.liquidity.mintPubkey), TOKEN_2022, a.ltv, a.lt);
    log(`  reserve ${a.ticker} ${reserves[a.ticker].key.toBase58().slice(0, 8)}: LTV ${a.ltv} / LT ${a.lt} (Kamino ${live.config.loanToValuePct} / ${live.config.liquidationThresholdPct})`);
  }
  const usdc = await addReserve(c, lma, USDC_SRC, USDC_MINT, TOKEN, null, null);
  // Only the program's PDA can borrow: permissioning authority = wsm_auth, BORROW (bit 1) permissioned.
  await send(c, [updateMarket(c, 42, pdas.wsmAuth().toBuffer()), updateMarket(c, 43, u64(2))]);
  // init_wsm_market
  const WAD = 10n ** 18n;
  const params = { maxDcpWad: new BN((WAD * 945n / 1000n).toString()), freezeSecs: 4 * 3600, marketDebtCap: new BN(5_000_000 * 1e6), worstLossRatioWad: new BN((WAD * 15n / 100n).toString()) };
  const assets = WSM_ASSETS.map((a) => ({ ticker: ticker8(a.ticker), normalLtvWad: new BN((BigInt(Math.round(a.normalLtv * 100)) * WAD / 100n).toString()) }));
  const rem: { pubkey: Pk; isSigner: boolean; isWritable: boolean }[] = [];
  for (const a of WSM_ASSETS) rem.push(m(pdas.asset(a.ticker)), m(reserves[a.ticker].key));
  await send(c, [await c.program.methods.initWsmMarket(params, assets).accountsPartial({ admin: c.payer.publicKey, usdcReserve: usdc.key }).remainingAccounts(rem).instruction()]);
  // The external LP (not the Credence vault, so the vault never lends into the market it covers).
  const lp = web3.Keypair.generate();
  await c.conn.confirmTransaction(await c.conn.requestAirdrop(lp.publicKey, 5e9), 'confirmed');
  await setTokenBalance(c, lp.publicKey.toBase58(), USDC_MINT.toBase58(), BigInt(lpUsdc) * 1_000_000n);
  const refreshUsdc = new web3.TransactionInstruction({
    programId: KLEND, data: disc('refresh_reserve'),
    keys: [m(usdc.key, { w: true }), m(WSM_MARKET), m(KLEND), m(KLEND), m(KLEND), m(SCOPE_PRICES)],
  });
  const lpColl = ata(lp.publicKey, usdc.collMint, TOKEN);
  await send(c, [createAtaIx(c.payer.publicKey, lp.publicKey, usdc.collMint, TOKEN), refreshUsdc, new web3.TransactionInstruction({
    programId: KLEND, data: Buffer.concat([disc('deposit_reserve_liquidity'), u64(BigInt(lpUsdc) * 1_000_000n)]),
    keys: [m(lp.publicKey, { s: true }), m(usdc.key, { w: true }), m(WSM_MARKET), m(lma), m(USDC_MINT), m(usdc.liqSupply, { w: true }), m(usdc.collMint, { w: true }),
      m(ata(lp.publicKey, USDC_MINT), { w: true }), m(lpColl, { w: true }), m(TOKEN), m(TOKEN), m(INSTRUCTIONS_SYSVAR)],
  })], [lp]);
  simulated.push(`An external lender (${lp.publicKey.toBase58().slice(0, 8)}…) supplied ${lpUsdc.toLocaleString()} USDC to the market (USDC from a cheatcode); it is not the Credence vault.`);
  void FARMS;
  return { lma, reserves, usdc };
}

/** The keys of an existing weekend-safe market, read back from its `WsmMarket` account and the reserves it lists. */
export async function readWsmMarketKeys(c: Chain): Promise<WsmMarketKeys> {
  const mk = await c.program.account.wsmMarket.fetch(pdas.wsmMarket());
  const lma = klendPda([Buffer.from('lma'), WSM_MARKET.toBuffer()]);
  const keysOf = async (key: Pk, tokenProgram: Pk) => {
    const r = await loadReserve(c, key);
    return {
      key, mint: pk(r.liquidity.mintPubkey), tokenProgram, liqSupply: pk(r.liquidity.supplyVault), feeVault: pk(r.liquidity.feeVault),
      collMint: pk(r.collateral.mintPubkey), collSupply: pk(r.collateral.supplyVault),
    } as WsmReserveKeys;
  };
  const reserves: Record<string, WsmReserveKeys> = {};
  for (const a of mk.assets.slice(0, mk.nAssets)) reserves[String.fromCharCode(...a.ticker).replace(/\0+$/, '')] = await keysOf(a.reserve, TOKEN_2022);
  return { lma, reserves, usdc: await keysOf(mk.usdcReserve, TOKEN) };
}

/** Starts the fork on a trading day: from the previous weekend's freeze until its settlement window ends nothing can borrow
 * (that is the product), so a fork parked on a weekend first moves to the next session's open + 1 h (SIMULATED clock). */
export async function tradingDay(c: Chain, simulated: string[]) {
  const cal = await c.program.account.calendar.fetch(pdas.calendar());
  const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());
  const sessions = (cal.sessions as { open: unknown; close: unknown }[]).slice(0, cal.n as number);
  const t = await chainNow(c);
  const next = sessions.find((x) => n(x.open as never) > t);
  const prev = [...sessions].reverse().find((x) => n(x.close as never) <= t);
  if (next && prev && n(next.open as never) - n(prev.close as never) > 2 * 86_400 && t > n(prev.close as never)) {
    await timeTravel(c, n(next.open as never) + 3_600);
    simulated.push(`The fork's clock was moved from ${fmtTime(t)} (a weekend, in the previous closure's freeze) to ${fmtTime(n(next.open as never) + 3_600)} so the demo starts on a trading day.`);
  }
}
