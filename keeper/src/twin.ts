// W1 twin demo on the surfpool mainnet fork (after scripts/demo.sh has deployed and loaded the program): two identical
// $50k SPYx positions at D/C′ 0.96 in Kamino's real xStocks Market; A buys Gap Cover, B does not.
//
//   1. Positions: two fresh wallets each deposit SPYx (cheatcode, SIMULATED) and borrow USDC through real klend.
//   2. A buys cover (refreshes + buy_cover). Clock → Friday close; Kamino's Scope holds the close; keeper: close.
//   3. Clock → Sunday 20:30 ET. The SPYx push account (Pyth Crypto.SPYX/USD) holds a fair value −8% from the close
//      (SIMULATED price on a genuine recorded update; the real weekend has not happened). Keeper: shields → the
//      Liquidation Shield repays into A.
//   4. Clock → Monday 08:00 ET. Kamino's Scope SPYx price −8% (SIMULATED move; klend sees it, as in pre-market, S7).
//   5. A plain liquidator (keeper/src/liquidator.ts, its own keypair) tries both: B is liquidated, A stays healthy.
//   6. Clock → Monday open + 75 s. Keeper: settlement price, A's policy settles its remainder.
// Before/after health, debt and collateral of both go to data/demo/twin-result.json with what was simulated.
//
//   pnpm -C keeper twin          (DEMO_GAP=-0.08 by default)
import { config } from 'dotenv';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import {
  type Chain, EPOCH, ROOT, SCOPE_PRICES, USDC_MINT, TOKEN, ata, chainNow, connect, decodePriceUpdate, decodeScope, fmtTime, log, pdas,
  pushAccount, send, tickerStr,
} from './chain.js';
import { setAccount, setTokenBalance, timeTravel } from './fork.js';
import { borrowedSf, loadObligation, loadReserve, refreshIxs } from './kamino.js';
import { tick } from './jobs.js';
import { liquidate, liquidatorWalletPath } from './liquidator.js';
import { freshPrices, openPosition } from './create-position.js';
import { recordedScope, writeScope } from './weekend.js';

config({ path: join(ROOT, '.env'), quiet: true });
const GAP = Number(process.env.DEMO_GAP ?? -0.08);
const DEBT = Number(process.env.TWIN_DEBT ?? 50_000);
const RATIO = Number(process.env.TWIN_RATIO ?? 0.96);
const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());
type Kp = InstanceType<typeof web3.Keypair>;
type Pk = InstanceType<typeof web3.PublicKey>;
const simulated: string[] = [];

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
  const sf = (x: { toString(): string }) => Number(BigInt(x.toString()) >> 40n) / 2 ** 20;
  const res = await loadReserve(c, new web3.PublicKey(o.deposits[0].depositReserve));
  const debtUsdc = Number(BigInt(o.borrows[0]?.borrowedAmountSf.toString() ?? '0') >> 60n) / 1e6;
  return {
    debtUsdc,
    collateralUsd: sf(o.depositedValueSf),
    collateralTokens: Number(o.deposits[0].depositedAmount.toString()) / 10 ** Number(res.liquidity.mintDecimals.toString()),
    ratio: sf(o.borrowFactorAdjustedDebtValueSf) / sf(o.unhealthyBorrowValueSf),
  };
}

/** The newest recorded genuine SPYx push update, its price set to `price` and publish time to `t` (fork only). */
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

async function main() {
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const t0 = Date.now();
  log(`twin demo on ${c.url} — chain time ${fmtTime(await chainNow(c))}`);

  // Vault and epochs: an LP if the vault is empty, then the keeper opens the coming weekends.
  const v0 = await c.program.account.vault.fetch(pdas.vault());
  if (BigInt(v0.equity.toString()) < 500_000_000_000n) {
    const lp = await wallet(c, 1_000_000);
    const { createAtaIx } = await import('./chain.js');
    await send(c, [createAtaIx(c.payer.publicKey, lp.publicKey, pdas.shares()),
      await c.program.methods.deposit(new BN('1000000000000'))
        .accountsPartial({ depositor: lp.publicKey, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), depositorUsdc: ata(lp.publicKey, USDC_MINT),
          depositorShares: ata(lp.publicKey, pdas.shares()), shareEscrow: pdas.shareEscrow() }).instruction()], [lp]);
    log('LP deposited 1,000,000 USDC');
  }
  await tick(c);
  const now0 = await chainNow(c);
  const epochs = (await c.program.account.epoch.all()) as { publicKey: Pk; account: any }[];
  const spyEpochs = epochs.filter((e) => tickerStr(e.account.ticker) === 'SPYx' && e.account.state === EPOCH.OPEN && n(e.account.bell) > now0 && n(e.account.saleOpen) <= now0);
  if (!spyEpochs.length) throw new Error('no SPYx epoch on sale now');
  const ep = spyEpochs.sort((a, b) => a.account.closureId - b.account.closureId)[0];
  const group = ep.account.closureId as number;
  const [close, open] = [n(ep.account.close), n(ep.account.open)];
  const cfg = await c.program.account.config.fetch(pdas.config());
  log(`weekend ${group}: close ${fmtTime(close)}, open ${fmtTime(open)}; shield α ${Number(cfg.shieldAlphaWad.toString()) / 1e18}, b ${Number(cfg.shieldBufferWad.toString()) / 1e18}`);

  // 1. Twin positions.
  const [ownerA, ownerB] = [await wallet(c, 10_000), await wallet(c, 0)];
  const A = await openPosition(c, ownerA, DEBT, RATIO);
  const B = await openPosition(c, ownerB, DEBT, RATIO);
  simulated.push(`Positions A ${A.obligation.toBase58()} and B ${B.obligation.toBase58()} were opened on the fork through real klend; their SPYx (${A.depositTokens} each) came from a surfpool cheatcode.`);
  const s0 = { A: await state(c, A.obligation), B: await state(c, B.obligation) };
  log(`A ${A.obligation.toBase58().slice(0, 8)}… and B ${B.obligation.toBase58().slice(0, 8)}…: debt ${s0.A!.debtUsdc.toFixed(2)} / ${s0.B!.debtUsdc.toFixed(2)} USDC, D/C′ ${s0.A!.ratio.toFixed(4)} / ${s0.B!.ratio.toFixed(4)}`);

  // 2. A buys cover (cap = debt).
  const assets = (await c.program.account.assetConfig.all()) as { publicKey: Pk; account: any }[];
  const spy = assets.find((a) => tickerStr(a.account.ticker) === 'SPYx')!;
  const obA = (await loadObligation(c, A.obligation))!;
  const policy = pdas.policy(ep.publicKey, A.obligation);
  const debtBase = (borrowedSf(obA, new web3.PublicKey(obA.borrows[0].borrowReserve)) >> 60n) + 1n;
  await freshPrices(c);
  const bought = await send(c, [...(await refreshIxs(c, A.obligation, obA)),
    await c.program.methods.buyCover(spy.account.ticker, group, new BN(debtBase.toString()), new BN('5000000000'))
      .accountsPartial({ buyer: ownerA.publicKey, asset: spy.publicKey, scenarios: pdas.scen('SPYx'), epoch: ep.publicKey, loss: pdas.loss(group),
        vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), feeAccount: v0.feeAccount, buyerUsdc: ata(ownerA.publicKey, USDC_MINT),
        obligation: A.obligation, depositReserve: new web3.PublicKey(obA.deposits[0].depositReserve), borrowReserve: new web3.PublicKey(obA.borrows[0].borrowReserve),
        policy, tokenProgram: TOKEN }).instruction()], [ownerA]);
  const p0 = await c.program.account.policy.fetch(policy);
  log(`A bought cover: cap ${(n(p0.maxPayout) / 1e6).toFixed(2)}, premium ${(n(p0.premium) / 1e6).toFixed(2)} USDC (shield loading ${(n(p0.shieldLoading) / 1e6).toFixed(2)}), ${bought.cu} CU`);

  // 3. Friday close for every Scope asset: the genuine recorded reading from this close window if there is one, else
  // the recorder's latest genuine reading (not the fork's current value, which an earlier simulated gap may have moved).
  const chain = n(spy.account.scopeChain);
  const scopeNow = (await c.conn.getAccountInfo(SCOPE_PRICES))!.data;
  await timeTravel(c, close + 30);
  let closePx = 0;
  const writes: { chain: number; price: number; ts: number }[] = [];
  for (const a of assets.filter((x) => x.account.enabled === 1 && n(x.account.settleSource) === 2)) {
    const sym = tickerStr(a.account.ticker);
    const ch = n(a.account.scopeChain);
    const real = recordedScope(sym, close - 60, close + 900);
    const latest = real ?? recordedScope(sym, 0, Number.MAX_SAFE_INTEGER);
    const px = latest?.price ?? decodeScope(scopeNow, ch).price;
    writes.push({ chain: ch, price: px, ts: real?.ts ?? close + 20 });
    if (!real) simulated.push(`${sym} close: Kamino's genuine Scope price ${px.toFixed(4)} (${latest ? `recorded ${fmtTime(latest.ts)}` : 'as on the fork'}), refresh time moved to the close (the real close is not recorded yet).`);
    if (ch === chain) closePx = px;
  }
  await writeScope(c, writes);
  await tick(c);
  const e1 = await c.program.account.epoch.fetch(ep.publicKey);
  if (e1.state !== EPOCH.CLOSED) throw new Error('the close was not stored');
  const closeWad = Number(BigInt(e1.closePriceWad.toString()) / 10n ** 10n) / 1e8;

  // 4. Sunday 20:30 ET: fair value −8% on the push account; keeper shields.
  const sunday = open - 13 * 3600;
  await timeTravel(c, sunday);
  const fair = closeWad * (1 + GAP);
  const push = pushAt(fair, sunday - 120);
  await setAccount(c, pushAccount(spy.account.feedXstock).toBase58(), { lamports: push.lamports, data: push.data, owner: push.owner });
  simulated.push(`Sunday ${fmtTime(sunday)}: the SPYx push account holds the genuine recorded update ${push.file} with its price set to ${fair.toFixed(4)} (${(GAP * 100).toFixed(1)}% from the close) and its publish time to ${fmtTime(sunday - 120)}.`);
  await freshPrices(c);
  const rShield = await tick(c);
  const p1 = await c.program.account.policy.fetch(policy);
  const advanced = n(p1.advanced) / 1e6;
  const s1 = { A: await state(c, A.obligation), B: await state(c, B.obligation) };
  log(`Sunday: shield advanced ${advanced.toFixed(2)} USDC into A; A debt ${s1.A!.debtUsdc.toFixed(2)}, B debt ${s1.B!.debtUsdc.toFixed(2)}`);

  // 5. Monday 08:00 ET: Kamino's price moves; the liquidator tries both.
  const premarket = open - 90 * 60;
  await timeTravel(c, premarket);
  await writeScope(c, [{ chain, price: closePx * (1 + GAP), ts: premarket }]);
  simulated.push(`Monday ${fmtTime(premarket)} (08:00 ET): Kamino's Scope SPYx price set to ${(closePx * (1 + GAP)).toFixed(4)} (${(GAP * 100).toFixed(1)}%); klend sees it, as in pre-market (S7).`);
  const s2 = { A: await state(c, A.obligation), B: await state(c, B.obligation) };
  log(`Monday 08:00 ET at −8%: D/C′ A ${s2.A!.ratio.toFixed(4)}, B ${s2.B!.ratio.toFixed(4)}`);
  const liq = connect(c.url, liquidatorWalletPath());
  await c.conn.confirmTransaction(await c.conn.requestAirdrop(liq.payer.publicKey, 10e9), 'confirmed');
  await setTokenBalance(c, liq.payer.publicKey.toBase58(), USDC_MINT.toBase58(), 1_000_000_000_000n);
  simulated.push('The liquidator keypair\'s SOL and USDC come from surfpool cheatcodes.');
  const tryLiq = async (key: Pk) => {
    await freshPrices(c);
    try { const l = await liquidate(liq, key); return { liquidated: true, repaidUsdc: Number(l.repaidUsdc) / 1e6, receivedSpyx: Number(l.receivedXstockRaw) / 1e8, cu: l.cu }; }
    catch (e) { return { liquidated: false, refused: (e as Error).message.split('\n').slice(0, 3).join(' | ') }; }
  };
  const liqA = await tryLiq(A.obligation);
  const liqB = await tryLiq(B.obligation);
  log(`liquidator: A ${liqA.liquidated ? 'LIQUIDATED' : 'refused by klend (healthy)'}; B ${liqB.liquidated ? `liquidated: repaid ${(liqB as any).repaidUsdc.toFixed(2)} USDC, took ${(liqB as any).receivedSpyx.toFixed(6)} SPYx` : 'not liquidated'}`);
  const s3 = { A: await state(c, A.obligation), B: await state(c, B.obligation) };

  // 6. Monday open: settlement.
  await timeTravel(c, open + 75);
  await writeScope(c, [{ chain, price: closePx * (1 + GAP), ts: open + 70 }]);
  const rSettle = await tick(c);
  const p2 = await c.program.account.policy.fetch(policy);
  const s4 = { A: await state(c, A.obligation), B: await state(c, B.obligation) };
  const payout = n(p2.payout) / 1e6;
  log(`open: A settled; payout ${payout.toFixed(2)} USDC in total (advance ${advanced.toFixed(2)} + remainder ${(payout - advanced).toFixed(2)})`);

  const stage = (s: Awaited<ReturnType<typeof state>>) => s && { debtUsdc: +s.debtUsdc.toFixed(6), collateralTokens: +s.collateralTokens.toFixed(8), collateralUsd: +s.collateralUsd.toFixed(2), health: +(1 / s.ratio).toFixed(4), debtToCovered: +s.ratio.toFixed(4) };
  const result = {
    ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), group, gap: GAP,
    chainTime: { close: fmtTime(close), shield: fmtTime(sunday), premarket: fmtTime(premarket), open: fmtTime(open) },
    positions: { A: A.obligation.toBase58(), B: B.obligation.toBase58(), debtUsdc: DEBT, debtToCovered: RATIO },
    policyA: { premium: n(p0.premium) / 1e6, shieldLoading: n(p0.shieldLoading) / 1e6, cap: n(p0.maxPayout) / 1e6, advanced, payout, remainder: +(payout - advanced).toFixed(6), state: p2.state },
    stages: {
      bought: { A: stage(s0.A), B: stage(s0.B) },
      afterShield: { A: stage(s1.A), B: stage(s1.B) },
      atPremarketMove: { A: stage(s2.A), B: stage(s2.B) },
      afterLiquidator: { A: stage(s3.A), B: stage(s3.B) },
      afterSettlement: { A: stage(s4.A), B: stage(s4.B) },
    },
    liquidator: { A: liqA, B: liqB },
    keeper: { shieldPass: { sent: rShield.sent, failed: rShield.failed }, settlePass: { sent: rSettle.sent, failed: rSettle.failed } },
    real: [
      'klend and every Kamino account (xStocks Market, reserves, Scope, farms) cloned from mainnet; both positions are real klend obligations on the fork',
      'credence_core built from this repo: buy_cover, shield_advance (vault-PDA repay v2 CPI), settle_policy',
      'the liquidation is a real klend liquidate_obligation_and_redeem_reserve_collateral_v2 from a third-party keypair; klend decides who is liquidatable',
    ],
    simulated: ['the clock (surfpool time travel)', 'USDC and SOL of the demo wallets (cheatcodes)', ...simulated],
  };
  mkdirSync(join(ROOT, 'data/demo'), { recursive: true });
  writeFileSync(join(ROOT, 'data/demo/twin-result.json'), JSON.stringify(result, null, 2) + '\n');

  console.log(`\n================ twin demo, weekend ${group} ================`);
  console.log(`                      A (covered)                 B (not covered)`);
  const row = (label: string, a: any, b: any) => console.log(`${label.padEnd(22)}debt ${a.debtUsdc.toFixed(2).padStart(10)} health ${a.health.toFixed(4)}   debt ${b.debtUsdc.toFixed(2).padStart(10)} health ${b.health.toFixed(4)}`);
  for (const [k, v] of Object.entries(result.stages)) row(k, v.A, v.B);
  console.log(`shield advance into A: ${advanced.toFixed(2)} USDC (Sunday 20:30 ET); settlement remainder ${(payout - advanced).toFixed(2)}; total payout ${payout.toFixed(2)}`);
  console.log(`liquidator: A ${liqA.liquidated ? 'LIQUIDATED' : 'healthy'}, B ${liqB.liquidated ? 'LIQUIDATED' : 'healthy'}`);
  console.log('simulated:'); for (const s of result.simulated) console.log(`  - ${s}`);
  console.log('result: data/demo/twin-result.json');
  const ok = advanced > 0 && !liqA.liquidated && liqB.liquidated && p2.state === 1 && rSettle.failed.length === 0 && rShield.failed.length === 0;
  if (!ok) { console.error('TWIN DEMO FAILED'); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
