// D1 demo on the surfpool mainnet fork (after scripts/demo.sh has deployed and loaded the program): the weekend-safe market.
//
//   1. A klend market for SPYx / QQQx / NVDAx against USDC is created on the fork with real klend instructions, priced by
//      Kamino's own Scope, permissioned so only credence_core can borrow in it (wsm-market.ts). An external lender supplies
//      USDC. Limits: SPYx LTV 80 / LT 85 (Kamino's xStocks market: 73 / 75).
//   2. Two wallets hold the same SPYx. B puts it in Kamino's real xStocks Market and borrows to D/C′ 0.96 (what Kamino
//      allows; its borrowers sit at 0.71–0.76 because of the weekend). A puts it in the weekend-safe market and borrows to
//      D/C′ 0.93 of its higher limit: MORE USDC than B for the same collateral.
//   3. Friday, from 4 h before the bell: the keeper's `wsm_auto_cover` borrows the premium onto A's debt and buys its cover.
//      Inside the freeze A cannot borrow more (shown). Friday close from Kamino's Scope.
//   4. Sunday 20:30 ET: the fair value is −8%: the Liquidation Shield repays into A from the vault.
//   5. Monday 08:00 ET: Kamino's Scope price −8% (klend sees it). A plain third-party liquidator tries both: A is healthy,
//      B is liquidated. Open: settlement. A repays and withdraws (exits are always open).
// Every simulated part is listed in data/demo/wsm-result.json and printed at the end.
//
//   pnpm -C keeper wsm-demo          (DEMO_GAP=-0.08 by default)
import { config } from 'dotenv';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import {
  CLOSURE, type Chain, EPOCH, FARMS, INSTRUCTIONS_SYSVAR, KLEND, ROOT, SCOPE_PRICES, TOKEN, TOKEN_2022, USDC_MINT, WSM_MARKET, ata, chainNow, connect, decodePriceUpdate,
  decodeScope, fmtTime, log, pdas, pk, pushAccount, send, tickerStr,
} from './chain.js';
import { setAccount, setTokenBalance, timeTravel } from './fork.js';
import { loadObligation, loadReserve, refreshIxs } from './kamino.js';
import { tick } from './jobs.js';
import { freshPrices, openPosition } from './create-position.js';
import { recordedScope, writeScope } from './weekend.js';
import { liquidate } from './liquidator.js';
import { createWsmMarket, readWsmMarketKeys, wsmMarketExists } from './wsm-market.js';

config({ path: join(ROOT, '.env'), quiet: true });
const GAP = Number(process.env.DEMO_GAP ?? -0.08);
const WSM_DCP = Number(process.env.WSM_RATIO ?? 0.93);
const KAMINO_DCP = Number(process.env.WSM_KAMINO_RATIO ?? 0.96);
const COLLATERAL_USD = Number(process.env.WSM_COLLATERAL ?? 50_000);
const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());
type Kp = InstanceType<typeof web3.Keypair>;
type Pk = InstanceType<typeof web3.PublicKey>;
const simulated: string[] = [];
const sf = (x: { toString(): string }) => Number(BigInt(x.toString()) >> 40n) / 2 ** 20;

async function wallet(c: Chain, usdc: number): Promise<Kp> {
  const k = web3.Keypair.generate();
  await c.conn.confirmTransaction(await c.conn.requestAirdrop(k.publicKey, 10e9), 'confirmed');
  if (usdc > 0) await setTokenBalance(c, k.publicKey.toBase58(), USDC_MINT.toBase58(), BigInt(usdc * 1e6));
  return k;
}

/** klend's view of a position after a refresh: debt, collateral, D/C′ (≥ 1: liquidatable). */
async function state(c: Chain, key: Pk) {
  await freshPrices(c);
  const ob0 = await loadObligation(c, key);
  if (!ob0) return null;
  await send(c, await refreshIxs(c, key, ob0));
  const o = (await loadObligation(c, key))!;
  const res = await loadReserve(c, new web3.PublicKey(o.deposits[0].depositReserve));
  const debtUsdc = Number(BigInt(o.borrows[0]?.borrowedAmountSf.toString() ?? '0') >> 60n) / 1e6;
  return {
    debtUsdc, collateralUsd: sf(o.depositedValueSf),
    collateralTokens: Number(o.deposits[0].depositedAmount.toString()) / 10 ** Number(res.liquidity.mintDecimals.toString()),
    ratio: sf(o.borrowFactorAdjustedDebtValueSf) / sf(o.unhealthyBorrowValueSf),
  };
}

function pushAt(price: number, t: number) {
  const dir = join(ROOT, 'data/live/pyth');
  const f = readdirSync(dir).filter((x) => x.startsWith('SPYx-')).sort().pop();
  if (!f) throw new Error('no recorded SPYx push update in data/live/pyth');
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const d = Buffer.from(j.account.data[0], 'base64');
  const u = decodePriceUpdate(d);
  const ratio = price / u.price;
  for (const [o, signed] of [[u.offsets.price, true], [u.offsets.conf, false], [u.offsets.emaPrice, true], [u.offsets.emaConf, false]] as const) {
    const v = signed ? d.readBigInt64LE(o) : d.readBigUInt64LE(o);
    const x = BigInt(Math.round(Number(v) * ratio));
    if (signed) d.writeBigInt64LE(x, o); else d.writeBigUInt64LE(x, o);
  }
  d.writeBigInt64LE(BigInt(t), u.offsets.publishTime);
  d.writeBigInt64LE(BigInt(t - 1), u.offsets.prevPublishTime);
  return { data: d, lamports: j.account.lamports as number, owner: j.account.owner as string, file: f };
}

const meta = (pubkey: Pk, w = false) => ({ pubkey, isSigner: false, isWritable: w });

async function main() {
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const t0 = Date.now();
  log(`weekend-safe market demo on ${c.url} — chain time ${fmtTime(await chainNow(c))}`);

  // Start on a trading day: from the previous weekend's freeze until its settlement window ends nothing can borrow (that is
  // the product), so a fork parked on a Saturday first moves to Monday's open + 1 h (SIMULATED clock).
  {
    const cal = await c.program.account.calendar.fetch(pdas.calendar());
    const sessions = (cal.sessions as { open: unknown; close: unknown }[]).slice(0, cal.n as number);
    const t = await chainNow(c);
    const next = sessions.find((x) => n(x.open as never) > t);
    const prev = [...sessions].reverse().find((x) => n(x.close as never) <= t);
    if (next && prev && n(next.open as never) - n(prev.close as never) > 2 * 86_400 && t > n(prev.close as never)) {
      await timeTravel(c, n(next.open as never) + 3_600);
      simulated.push(`The fork's clock was moved from ${fmtTime(t)} (a weekend, in the previous closure's freeze) to ${fmtTime(n(next.open as never) + 3_600)} so the demo starts on a trading day.`);
    }
  }
  // Vault and epochs, as the twin demo.
  const v0 = await c.program.account.vault.fetch(pdas.vault());
  if (BigInt(v0.equity.toString()) < 500_000_000_000n) {
    const lp = await wallet(c, 1_000_000);
    const { createAtaIx } = await import('./chain.js');
    await send(c, [createAtaIx(c.payer.publicKey, lp.publicKey, pdas.shares()),
      await c.program.methods.deposit(new BN('1000000000000'))
        .accountsPartial({ depositor: lp.publicKey, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), depositorUsdc: ata(lp.publicKey, USDC_MINT),
          depositorShares: ata(lp.publicKey, pdas.shares()), shareEscrow: pdas.shareEscrow() }).instruction()], [lp]);
    log('LP deposited 1,000,000 USDC into the Credence vault');
  }
  await tick(c);
  const now0 = await chainNow(c);
  const epochs = (await c.program.account.epoch.all()) as { publicKey: Pk; account: any }[];
  const spyEpochs = epochs.filter((e) => e.account.closureType === CLOSURE.WEEKEND && tickerStr(e.account.ticker) === 'SPYx' && e.account.state === EPOCH.OPEN && n(e.account.bell) > now0);
  if (!spyEpochs.length) throw new Error('no SPYx weekend epoch ahead');
  const ep = spyEpochs.sort((a, b) => a.account.closureId - b.account.closureId)[0];
  const group = ep.account.closureId as number;
  const [close, open, bell] = [n(ep.account.close), n(ep.account.open), n(ep.account.bell)];
  log(`weekend ${group}: bell ${fmtTime(bell)}, close ${fmtTime(close)}, open ${fmtTime(open)}`);

  // 0. Start from the genuine SPYx price (an earlier demo leaves Scope at its simulated open).
  const assets = (await c.program.account.assetConfig.all()) as { publicKey: Pk; account: any }[];
  const spy = assets.find((a) => tickerStr(a.account.ticker) === 'SPYx')!;
  const chain = n(spy.account.scopeChain);
  const real = recordedScope('SPYx', 0, Number.MAX_SAFE_INTEGER);
  if (real) {
    await writeScope(c, [{ chain, price: real.price, ts: await chainNow(c) }]);
    simulated.push(`Start: Kamino's Scope SPYx set to the recorder's latest genuine reading ${real.price.toFixed(4)} (${fmtTime(real.ts)}), refreshed now.`);
  }
  await freshPrices(c);

  // 1. The market.
  if (!(await wsmMarketExists(c))) {
    await createWsmMarket(c, 2_000_000, simulated);
  } else simulated.push('The weekend-safe market already existed on this fork and was reused.');
  const mk = await readWsmMarketKeys(c);
  const wm = await c.program.account.wsmMarket.fetch(pdas.wsmMarket());
  const spyReserve = mk.reserves.SPYx;
  const kSpy = await loadReserve(c, pk('UvXjBuC7YZYaGB9Rn1PpBD1GySmjzunXgE8Zev9ua8d'));
  const wSpy = await loadReserve(c, spyReserve.key);
  const limits = {
    kamino: { ltv: kSpy.config.loanToValuePct, lt: kSpy.config.liquidationThresholdPct },
    wsm: { ltv: wSpy.config.loanToValuePct, lt: wSpy.config.liquidationThresholdPct },
  };
  log(`SPYx limits: Kamino's xStocks market LTV ${limits.kamino.ltv} / LT ${limits.kamino.lt}; weekend-safe market LTV ${limits.wsm.ltv} / LT ${limits.wsm.lt}`);

  // 2. The twin positions: the same SPYx.
  const price = decodeScope((await c.conn.getAccountInfo(SCOPE_PRICES))!.data, chain).price;
  const debtB = COLLATERAL_USD * (limits.kamino.lt / 100) * KAMINO_DCP;
  const ownerB = await wallet(c, 0);
  const B = await openPosition(c, ownerB, debtB, KAMINO_DCP);
  simulated.push(`B ${B.obligation.toBase58()} was opened on the fork in Kamino's real xStocks Market through klend; its SPYx (${B.depositTokens}) came from a surfpool cheatcode.`);
  const tokens = BigInt(Math.round(B.depositTokens * 1e8));
  const user = await wallet(c, 0);
  await setTokenBalance(c, user.publicKey.toBase58(), spyReserve.mint.toBase58(), tokens, TOKEN_2022.toBase58());
  simulated.push(`A's SPYx (${B.depositTokens}, the same amount as B's) came from a surfpool cheatcode.`);
  const account = pdas.wsm(user.publicKey);
  const klendKeys = { klendMarket: WSM_MARKET, klendLma: mk.lma, klendProgram: KLEND, farmsProgram: FARMS, instructionSysvar: INSTRUCTIONS_SYSVAR };
  const obligationA = web3.PublicKey.findProgramAddressSync(
    [Buffer.from([0]), Buffer.from([0]), account.toBuffer(), WSM_MARKET.toBuffer(), web3.PublicKey.default.toBuffer(), web3.PublicKey.default.toBuffer()], KLEND)[0];
  const userMeta = web3.PublicKey.findProgramAddressSync([Buffer.from('user_meta'), account.toBuffer()], KLEND)[0];
  await send(c, [await c.program.methods.wsmOpen(spy.account.ticker).accountsPartial({
    user: user.publicKey, asset: spy.publicKey, wsmAccount: account, wsmUsdc: pdas.wsmUsdc(user.publicKey), wsmColl: pdas.wsmColl(user.publicKey), usdcMint: USDC_MINT,
    collMint: spyReserve.mint, klendMarket: WSM_MARKET, klendLma: mk.lma, userMetadata: userMeta, obligation: obligationA, klendProgram: KLEND, farmsProgram: FARMS,
    instructionSysvar: INSTRUCTIONS_SYSVAR, rent: pk('SysvarRent111111111111111111111111111111111'), tokenProgram: TOKEN, token2022Program: TOKEN_2022,
    systemProgram: web3.SystemProgram.programId,
  }).instruction()], [user]);
  await freshPrices(c);
  const sA = (r: typeof spyReserve) => ({ reserve: r.key, reserveLiquiditySupply: r.liqSupply, reserveCollateralMint: r.collMint, reserveCollateralSupply: r.collSupply });
  {
    const refreshReserveIx = (r: typeof spyReserve) => new web3.TransactionInstruction({ programId: KLEND, data: refreshDisc('refresh_reserve'),
      keys: [meta(r.key, true), meta(WSM_MARKET), meta(KLEND), meta(KLEND), meta(KLEND), meta(SCOPE_PRICES)] });
    // klend wants the obligation refreshed even while it is empty.
    const refreshEmptyObligation = new web3.TransactionInstruction({ programId: KLEND, data: refreshDisc('refresh_obligation'), keys: [meta(WSM_MARKET), meta(obligationA, true)] });
    await send(c, [refreshReserveIx(spyReserve), refreshEmptyObligation, await c.program.methods.wsmDeposit(new BN(tokens.toString())).accountsPartial({
      user: user.publicKey, wsmAccount: account, wsmColl: pdas.wsmColl(user.publicKey), userColl: ata(user.publicKey, spyReserve.mint, TOKEN_2022),
      collMint: spyReserve.mint, obligation: obligationA, ...sA(spyReserve), klend: klendKeys, collateralTokenProgram: TOKEN, token2022Program: TOKEN_2022,
    } as never).instruction()], [user]);
  }
  const obA0 = (await loadObligation(c, obligationA))!;
  await freshPrices(c);
  await send(c, await refreshIxs(c, obligationA, obA0));
  const obA1 = (await loadObligation(c, obligationA))!;
  const cprime = sf(obA1.unhealthyBorrowValueSf);
  const usdcRes = await loadReserve(c, mk.usdc.key);
  const usdcPrice = Number(BigInt(usdcRes.liquidity.marketPriceSf.toString()) >> 40n) / 2 ** 20;
  const borrowA = BigInt(Math.floor((WSM_DCP * cprime) / usdcPrice * 1e6));
  const borrowIx = async (amount: bigint) => c.program.methods.wsmBorrow(new BN(amount.toString())).accountsPartial({
    user: user.publicKey, wsmAccount: account, wsmUsdc: pdas.wsmUsdc(user.publicKey), userUsdc: ata(user.publicKey, USDC_MINT), usdcMint: USDC_MINT, obligation: obligationA,
    usdcReserve: mk.usdc.key, reserveLiquiditySupply: mk.usdc.liqSupply, reserveFeeVault: mk.usdc.feeVault, wsmAuth: pdas.wsmAuth(), vault: pdas.vault(), shareMint: pdas.shares(),
    klend: klendKeys, tokenProgram: TOKEN,
  } as never).instruction();
  const { createAtaIx } = await import('./chain.js');
  await freshPrices(c);
  // The USDC reserve is refreshed too: a first borrow is priced against it (the obligation holds no borrow yet).
  const refreshUsdc = new web3.TransactionInstruction({ programId: KLEND, data: refreshDisc('refresh_reserve'), keys: [meta(mk.usdc.key, true), meta(WSM_MARKET), meta(KLEND), meta(KLEND), meta(KLEND), meta(SCOPE_PRICES)] });
  const bor = await send(c, [createAtaIx(c.payer.publicKey, user.publicKey, USDC_MINT), refreshUsdc, ...(await refreshIxs(c, obligationA, obA1)), await borrowIx(borrowA)], [user]);
  log(`A borrowed ${(Number(borrowA) / 1e6).toFixed(2)} USDC through wsm_borrow (${bor.cu} CU)`);
  const s0 = { A: await state(c, obligationA), B: await state(c, B.obligation) };
  log(`A (weekend-safe market): debt ${s0.A!.debtUsdc.toFixed(2)}, D/C′ ${s0.A!.ratio.toFixed(4)}; B (Kamino): debt ${s0.B!.debtUsdc.toFixed(2)}, D/C′ ${s0.B!.ratio.toFixed(4)} — same ${B.depositTokens} SPYx`);

  // 3. Friday, inside the freeze: the keeper covers A. A cannot borrow more.
  await timeTravel(c, bell - 3_600);
  await freshPrices(c);
  const obF = (await loadObligation(c, obligationA))!;
  let freezeRefusal = '';
  try { await send(c, [...(await refreshIxs(c, obligationA, obF)), await borrowIx(1_000_000n)], [user]); } catch (e) { freezeRefusal = (e as Error).message.split('\n').find((l) => /WeekendFreeze|freeze/i.test(l)) ?? (e as Error).message.split('\n')[0]; }
  log(`inside the freeze, A tries to borrow 1 USDC: ${freezeRefusal ? 'refused (' + freezeRefusal.trim().slice(0, 90) + ')' : 'NOT REFUSED'}`);
  await freshPrices(c);
  const rCover = await tick(c);
  const wsmAcct = await c.program.account.wsmAccount.fetch(account);
  const policy = pdas.policy(ep.publicKey, obligationA);
  const p0 = await c.program.account.policy.fetch(policy);
  const debtCovered = n(p0.maxPayout) / 1e6;
  const apr = (n(p0.premium) * 52) / n(p0.debt);
  log(`Friday: wsm_auto_cover → premium ${(n(p0.premium) / 1e6).toFixed(4)} USDC borrowed onto A's debt and paid to the vault, cover ${debtCovered.toFixed(2)} USDC; add-on ${(apr * 100).toFixed(2)}% a year of the debt; covered closure ${wsmAcct.coveredClosure}`);

  // 4. Friday close (Kamino's Scope), then Sunday: the Shield.
  const scopeNow = (await c.conn.getAccountInfo(SCOPE_PRICES))!.data;
  await timeTravel(c, close + 30);
  let closePx = 0;
  const writes: { chain: number; price: number; ts: number }[] = [];
  for (const a of assets.filter((x) => x.account.enabled === 1 && n(x.account.settleSource) === 2)) {
    const sym = tickerStr(a.account.ticker);
    const ch = n(a.account.scopeChain);
    const rec = recordedScope(sym, close - 60, close + 900);
    const latest = rec ?? recordedScope(sym, 0, Number.MAX_SAFE_INTEGER);
    const px = latest?.price ?? decodeScope(scopeNow, ch).price;
    writes.push({ chain: ch, price: px, ts: rec?.ts ?? close + 20 });
    if (!rec) simulated.push(`${sym} close: Kamino's genuine Scope price ${px.toFixed(4)} (${latest ? `recorded ${fmtTime(latest.ts)}` : 'as on the fork'}), refresh time moved to the close.`);
    if (ch === chain) closePx = px;
  }
  await writeScope(c, writes);
  await tick(c);
  const e1 = await c.program.account.epoch.fetch(ep.publicKey);
  if (e1.state !== EPOCH.CLOSED) throw new Error('the close was not stored');
  const closeWad = Number(BigInt(e1.closePriceWad.toString()) / 10n ** 10n) / 1e8;
  const sunday = open - 13 * 3600;
  await timeTravel(c, sunday);
  const fair = closeWad * (1 + GAP);
  const push = pushAt(fair, sunday - 120);
  await setAccount(c, pushAccount(spy.account.feedXstock).toBase58(), { lamports: push.lamports, data: push.data, owner: push.owner });
  simulated.push(`Sunday ${fmtTime(sunday)}: the SPYx push account holds the genuine recorded update ${push.file} with its price set to ${fair.toFixed(4)} (${(GAP * 100).toFixed(1)}% from the close).`);
  await freshPrices(c);
  const rShield = await tick(c);
  const p1 = await c.program.account.policy.fetch(policy);
  const advanced = n(p1.advanced) / 1e6;
  const s1 = { A: await state(c, obligationA), B: await state(c, B.obligation) };
  log(`Sunday: the Shield advanced ${advanced.toFixed(2)} USDC into A; A debt ${s1.A!.debtUsdc.toFixed(2)}`);

  // 5. Monday 08:00 ET: Kamino's price moves; a plain liquidator tries both.
  const premarket = open - 90 * 60;
  await timeTravel(c, premarket);
  await writeScope(c, [{ chain, price: closePx * (1 + GAP), ts: premarket }]);
  simulated.push(`Monday ${fmtTime(premarket)} (08:00 ET): Kamino's Scope SPYx price set to ${(closePx * (1 + GAP)).toFixed(4)} (${(GAP * 100).toFixed(1)}%); klend sees it for both markets.`);
  const s2 = { A: await state(c, obligationA), B: await state(c, B.obligation) };
  log(`Monday 08:00 ET at ${(GAP * 100).toFixed(0)}%: D/C′ A ${s2.A!.ratio.toFixed(4)}, B ${s2.B!.ratio.toFixed(4)}`);
  await setTokenBalance(c, c.payer.publicKey.toBase58(), USDC_MINT.toBase58(), 500_000n * 1_000_000n);
  simulated.push('The liquidator (the keeper wallet) was given 500,000 USDC by a cheatcode to repay with.');
  const tryLiq = async (key: Pk) => {
    await freshPrices(c);
    try {
      const l = await liquidate(c, key);
      return { liquidated: true as const, repaidUsdc: Number(l.repaidUsdc) / 1e6, receivedSpyx: Number(l.receivedXstockRaw) / 1e8, cu: l.cu };
    } catch (e) { return { liquidated: false as const, refused: (e as Error).message.split('\n').slice(0, 3).join(' | ') }; }
  };
  const liqA = await tryLiq(obligationA);
  const liqB = await tryLiq(B.obligation);
  log(`liquidator: A ${liqA.liquidated ? 'LIQUIDATED' : 'refused by klend (healthy)'}; B ${liqB.liquidated ? `liquidated: repaid ${liqB.repaidUsdc.toFixed(2)} USDC, took ${liqB.receivedSpyx.toFixed(6)} SPYx` : 'not liquidated'}`);
  const s3 = { A: await state(c, obligationA), B: await state(c, B.obligation) };

  // 6. The open: settlement.
  await timeTravel(c, open + 75);
  await writeScope(c, [{ chain, price: closePx * (1 + GAP), ts: open + 70 }]);
  const rSettle = await tick(c);
  const p2 = await c.program.account.policy.fetch(policy);
  const s4 = { A: await state(c, obligationA), B: await state(c, B.obligation) };
  const payout = n(p2.payout) / 1e6;
  log(`open: A's policy ${p2.state === 1 ? 'settled' : 'NOT settled'}; payout ${payout.toFixed(2)} USDC in total (advance ${advanced.toFixed(2)} + remainder ${(payout - advanced).toFixed(2)})`);

  // 7. A's exits: repay everything and withdraw, from the wallet, while the freeze is over.
  await setTokenBalance(c, user.publicKey.toBase58(), USDC_MINT.toBase58(), BigInt(Math.ceil((s4.A!.debtUsdc + 50) * 1e6)));
  await freshPrices(c);
  const obX = (await loadObligation(c, obligationA))!;
  await send(c, [...(await refreshIxs(c, obligationA, obX)), await c.program.methods.wsmRepay(new BN('18446744073709551615')).accountsPartial({
    user: user.publicKey, wsmAccount: account, wsmUsdc: pdas.wsmUsdc(user.publicKey), userUsdc: ata(user.publicKey, USDC_MINT), usdcMint: USDC_MINT, obligation: obligationA,
    usdcReserve: mk.usdc.key, reserveLiquiditySupply: mk.usdc.liqSupply, klend: klendKeys, tokenProgram: TOKEN,
  } as never).instruction()], [user]);
  await freshPrices(c);
  const obY = (await loadObligation(c, obligationA))!;
  await send(c, [...(await refreshIxs(c, obligationA, obY)), await c.program.methods.wsmWithdraw(new BN('18446744073709551615')).accountsPartial({
    user: user.publicKey, wsmAccount: account, wsmColl: pdas.wsmColl(user.publicKey), userColl: ata(user.publicKey, spyReserve.mint, TOKEN_2022), collMint: spyReserve.mint,
    obligation: obligationA, ...sA(spyReserve), klend: klendKeys, collateralTokenProgram: TOKEN, token2022Program: TOKEN_2022, calendar: pdas.calendar(),
  } as never).instruction()], [user]);
  const back = Number((await c.conn.getTokenAccountBalance(ata(user.publicKey, spyReserve.mint, TOKEN_2022))).value.amount) / 1e8;
  log(`A repaid and withdrew: ${back.toFixed(6)} SPYx back in the wallet (deposited ${B.depositTokens})`);

  const stage = (s: Awaited<ReturnType<typeof state>>) => s && { debtUsdc: +s.debtUsdc.toFixed(6), collateralTokens: +s.collateralTokens.toFixed(8), collateralUsd: +s.collateralUsd.toFixed(2), health: +(1 / s.ratio).toFixed(4), debtToCovered: +s.ratio.toFixed(4) };
  const result = {
    ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), group, gap: GAP,
    chainTime: { freeze: fmtTime(bell - 3_600), close: fmtTime(close), shield: fmtTime(sunday), premarket: fmtTime(premarket), open: fmtTime(open) },
    limits, positions: { A: obligationA.toBase58(), B: B.obligation.toBase58(), collateralSpyx: B.depositTokens, collateralUsd: COLLATERAL_USD },
    borrowMoreThanKamino: { aDebtUsdc: s0.A!.debtUsdc, bDebtUsdc: s0.B!.debtUsdc, extraUsdc: +(s0.A!.debtUsdc - s0.B!.debtUsdc).toFixed(2), extraPct: +(((s0.A!.debtUsdc / s0.B!.debtUsdc) - 1) * 100).toFixed(1) },
    addon: { premiumUsdc: n(p0.premium) / 1e6, feeUsdc: n(p0.fee) / 1e6, shieldLoadingUsdc: n(p0.shieldLoading) / 1e6, coverUsdc: debtCovered, aprOfDebt: +apr.toFixed(6), aprPct: +(apr * 100).toFixed(3) },
    freeze: { refusedBorrow: !!freezeRefusal, message: freezeRefusal.trim() },
    policyA: { advanced, payout, remainder: +(payout - advanced).toFixed(6), state: p2.state },
    stages: {
      opened: { A: stage(s0.A), B: stage(s0.B) }, afterShield: { A: stage(s1.A), B: stage(s1.B) }, atPremarketMove: { A: stage(s2.A), B: stage(s2.B) },
      afterLiquidator: { A: stage(s3.A), B: stage(s3.B) }, afterSettlement: { A: stage(s4.A), B: stage(s4.B) },
    },
    liquidator: { A: liqA, B: liqB },
    exit: { spyxBack: back, deposited: B.depositTokens },
    keeper: { coverPass: { sent: rCover.sent, failed: rCover.failed }, shieldPass: { sent: rShield.sent, failed: rShield.failed }, settlePass: { sent: rSettle.sent, failed: rSettle.failed } },
    real: [
      'klend and farms from mainnet; the weekend-safe market is a real klend market created with klend\'s own instructions on the fork, priced by Kamino\'s real Scope',
      'every klend call of A is a v2 CPI signed by credence_core\'s PDAs; the borrow is permissioned to the program\'s wsm_auth PDA',
      'B is a real obligation in Kamino\'s real xStocks Market',
      'credence_core built from this repo: wsm_*, shield_advance, settle_policy; the liquidator is a plain third-party klend v2 liquidation',
    ],
    simulated: ['the clock (surfpool time travel)', 'USDC, SOL and SPYx of the demo wallets (cheatcodes)', ...simulated],
  };
  mkdirSync(join(ROOT, 'data/demo'), { recursive: true });
  writeFileSync(join(ROOT, 'data/demo/wsm-result.json'), JSON.stringify(result, null, 2) + '\n');

  console.log(`\n================ weekend-safe market, weekend ${group} ================`);
  console.log(`same ${B.depositTokens} SPYx (~$${COLLATERAL_USD.toLocaleString()}):   A: weekend-safe market (covered)        B: Kamino xStocks market`);
  const row = (label: string, a: any, b: any) => console.log(`${label.padEnd(18)}debt ${a.debtUsdc.toFixed(2).padStart(10)}  health ${a.health.toFixed(4)}        debt ${b.debtUsdc.toFixed(2).padStart(10)}  health ${b.health.toFixed(4)}`);
  for (const [k, v] of Object.entries(result.stages)) row(k, v.A, v.B);
  console.log(`A borrowed ${result.borrowMoreThanKamino.extraUsdc} USDC (${result.borrowMoreThanKamino.extraPct}%) more than B for the same collateral.`);
  console.log(`weekend add-on: ${result.addon.premiumUsdc.toFixed(4)} USDC (${result.addon.aprPct}% a year of the debt) borrowed onto A's debt; Shield advance ${advanced.toFixed(2)}; total payout ${payout.toFixed(2)}`);
  console.log(`klend: A ${liqA.liquidated ? 'LIQUIDATED' : 'healthy'}, B ${liqB.liquidated ? 'LIQUIDATED' : 'healthy'}`);
  console.log('simulated:'); for (const s of result.simulated) console.log(`  - ${s}`);
  console.log('result: data/demo/wsm-result.json');
  console.log(`@@result ${JSON.stringify(result)}`);
  const ok = !!freezeRefusal && advanced > 0 && !liqA.liquidated && liqB.liquidated && p2.state === 1 && rCover.failed.length === 0 && rSettle.failed.length === 0 && rShield.failed.length === 0 && back > 0 && s4.A!.ratio < 1;
  if (!ok) { console.error('WEEKEND-SAFE MARKET DEMO FAILED'); process.exit(1); }
}

import { createHash } from 'node:crypto';
function refreshDisc(name: string) { return createHash('sha256').update(`global:${name}`).digest().subarray(0, 8); }

main().catch((e) => { console.error(e); process.exit(1); });
