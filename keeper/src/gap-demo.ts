// D2 demo on the surfpool mainnet fork (after scripts/demo.sh has loaded the data): GAP TOKENS, RESEARCH PROTOTYPE, NOT OFFERED.
//   1. The keeper opens the weekend's series (init_gap_series, opt-in GAP_TOKENS=1).
//   2. Wallet A mints 1,000 complete sets (1,000 USDC) and sends 1,000 GAP-DOWN to wallet B (a plain Token-2022 transfer).
//   3. The asset closes at Kamino's Scope price and opens −8% on Monday (SIMULATED); the keeper stores the settlement price
//      (post_settlement) and settles the series from the epoch's own stored prices.
//   4. A and B redeem; the payouts add up to the collateral exactly.
// Everything is fork-only. Result: data/demo/gap-result.json.     pnpm -C keeper run gap-demo
import { config } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import { type Chain, CLOSURE, EPOCH, ROOT, SCOPE_PRICES, TOKEN, TOKEN_2022, USDC_MINT, ata, chainNow, connect, createAtaIx, decodeScope, fmtTime, log, pdas, send, tickerStr } from './chain.js';
import { setTokenBalance, timeTravel } from './fork.js';
import { gapPdas } from './gap.js';
import { tick } from './jobs.js';
import { restampScope, writeScope } from './weekend.js';
import { redact } from './redact.js';

config({ path: join(ROOT, '.env'), quiet: true });
process.env.GAP_TOKENS = '1';
process.env.GAP_TICKERS = process.env.GAP_TICKER ?? 'MSTRx'; // only the demo asset's series
const T = process.env.GAP_TICKER ?? 'MSTRx';
const GAP = Number(process.env.DEMO_GAP ?? -0.08);
const SETS = 1_000_000_000n; // 1,000 sets
const DISCLAIMER = 'gap tokens (research prototype, not offered)';
const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());
type Pk = InstanceType<typeof web3.PublicKey>;
const simulated: string[] = [];

async function pass(c: Chain) {
  const spyx = (await c.program.account.assetConfig.fetch(pdas.asset('SPYx'))) as any;
  await restampScope(c, [{ price: n(spyx.scopeChain), twap: null }]);
  return tick(c);
}

const transferIx = (from: Pk, to: Pk, owner: Pk, amount: bigint) => {
  const d = Buffer.alloc(9);
  d[0] = 3;
  d.writeBigUInt64LE(amount, 1);
  return new web3.TransactionInstruction({
    programId: TOKEN_2022, data: d,
    keys: [{ pubkey: from, isSigner: false, isWritable: true }, { pubkey: to, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false }],
  });
};
const bal = async (c: Chain, k: Pk) => BigInt((await c.conn.getTokenAccountBalance(k)).value.amount);

async function main() {
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const t0 = Date.now();
  log(`${DISCLAIMER}: ${T} on ${c.url} — chain time ${fmtTime(await chainNow(c))}`);
  await pass(c); // opens epochs, and with GAP_TOKENS=1 their series
  let now = await chainNow(c);
  const epochs = (await c.program.account.epoch.all()) as { publicKey: Pk; account: any }[];
  const ahead = epochs.filter((e) => tickerStr(e.account.ticker) === T && e.account.closureType === CLOSURE.WEEKEND && e.account.state === EPOCH.OPEN && n(e.account.bell) > now)
    .sort((a, b) => a.account.closureId - b.account.closureId);
  const ep = ahead[0];
  if (!ep) throw new Error(`no ${T} weekend epoch ahead at ${fmtTime(now)}`);
  if (now < n(ep.account.saleOpen)) {
    // Started on a Saturday or Sunday the weekend's sales open on Monday: the clock moves into the sale window.
    await timeTravel(c, n(ep.account.saleOpen) + 3600);
    simulated.push(`The fork's clock moved to ${fmtTime(n(ep.account.saleOpen) + 3600)}, into the sale window of weekend ${ep.account.closureId} (the demo ran on a weekend).`);
    now = await chainNow(c);
  }
  const closureId = ep.account.closureId as number;
  const series = gapPdas.series(T, closureId);
  const s0 = (await c.program.account.gapSeries.fetch(series)) as any;
  const k = Number(BigInt(s0.kWad.toString())) / 1e18;
  log(`series ${series.toBase58().slice(0, 8)}… ${T} ${closureId}: band ±${(k * 100).toFixed(1)}%, DOWN ${s0.downMint.toBase58().slice(0, 8)}…, UP ${s0.upMint.toBase58().slice(0, 8)}…`);

  // 2. A mints 1,000 sets, sends the DOWN side to B.
  const [a, b] = [web3.Keypair.generate(), web3.Keypair.generate()];
  for (const w of [a, b]) await c.conn.confirmTransaction(await c.conn.requestAirdrop(w.publicKey, 5e9), 'confirmed');
  await setTokenBalance(c, a.publicKey.toBase58(), USDC_MINT.toBase58(), SETS);
  simulated.push('Wallet A\'s 1,000 USDC were credited with a cheatcode (no real USDC moves).');
  const acct = (w: Pk) => ({ usdc: ata(w, USDC_MINT), down: ata(w, s0.downMint, TOKEN_2022), up: ata(w, s0.upMint, TOKEN_2022) });
  const [A, B] = [acct(a.publicKey), acct(b.publicKey)];
  const mintIx = await c.program.methods.mintGapSet(new BN(SETS.toString())).accountsPartial({
    user: a.publicKey, config: pdas.config(), series, downMint: s0.downMint, upMint: s0.upMint, collateral: s0.collateral,
    userUsdc: A.usdc, userDown: A.down, userUp: A.up, tokenProgram: TOKEN, token2022Program: TOKEN_2022,
  }).instruction();
  const minted = await send(c, [createAtaIx(c.payer.publicKey, a.publicKey, s0.downMint, TOKEN_2022), createAtaIx(c.payer.publicKey, a.publicKey, s0.upMint, TOKEN_2022), mintIx], [a]);
  log(`A minted 1,000 sets: ${(Number(await bal(c, A.down)) / 1e6).toFixed(0)} GAP-DOWN + ${(Number(await bal(c, A.up)) / 1e6).toFixed(0)} GAP-UP for 1,000 USDC (${minted.cu} CU)`);
  await send(c, [createAtaIx(c.payer.publicKey, b.publicKey, s0.downMint, TOKEN_2022), createAtaIx(c.payer.publicKey, b.publicKey, s0.upMint, TOKEN_2022), createAtaIx(c.payer.publicKey, b.publicKey, USDC_MINT),
    transferIx(A.down, B.down, a.publicKey, SETS)], [a]);
  simulated.push('A sends B the DOWN side as a plain over-the-counter transfer; nothing is listed and there is no price discovery.');
  log(`A sent B 1,000 GAP-DOWN (plain transfer); A holds ${(Number(await bal(c, A.up)) / 1e6).toFixed(0)} UP, B holds ${(Number(await bal(c, B.down)) / 1e6).toFixed(0)} DOWN`);
  const collateral0 = await bal(c, s0.collateral);

  // 3. Close at Kamino's Scope price, Monday open GAP (SIMULATED).
  const st = (await c.program.account.assetConfig.fetch(pdas.asset(T))) as any;
  const chain = n(st.scopeChain);
  const mainnet = new web3.Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
  const pClose = decodeScope((await mainnet.getAccountInfo(SCOPE_PRICES))!.data, chain).price;
  const pOpen = pClose * (1 + GAP);
  await timeTravel(c, n(ep.account.close) + 30);
  await writeScope(c, [{ chain, price: pClose, ts: n(ep.account.close) + 20 }]);
  await pass(c);
  await timeTravel(c, n(ep.account.open) + 75);
  await writeScope(c, [{ chain, price: pOpen, ts: n(ep.account.open) + 70 }]);
  simulated.push(`${T} closes at Kamino's Scope price on the fork (${pClose.toFixed(4)}) and opens at ${pOpen.toFixed(4)} (${(GAP * 100).toFixed(1)}%), refresh times moved to the close and the open.`);
  const settle = await pass(c); // post_settlement, then settle_gap_series (the keeper's gap job)
  const s1 = (await c.program.account.gapSeries.fetch(series)) as any;
  if (s1.state !== 1) throw new Error(`the series did not settle (state ${s1.state}); keeper: ${JSON.stringify(settle)}`);
  const e = (await c.program.account.epoch.fetch(ep.publicKey)) as any;
  log(`settled on the epoch's own prices: close ${(Number(BigInt(e.closePriceWad.toString())) / 1e18).toFixed(4)} → ${(Number(BigInt(e.settlePriceWad.toString())) / 1e18).toFixed(4)}; DOWN pays ${(s1.downMicro / 1e6).toFixed(6)} USDC, UP ${(s1.upMicro / 1e6).toFixed(6)} per token`);

  // 4. Redeem.
  const redeem = async (w: InstanceType<typeof web3.Keypair>, side: number, mint: Pk, gap: Pk, usdc: Pk, amount: bigint) => {
    const ix = await c.program.methods.redeemGap(side, new BN(amount.toString())).accountsPartial({
      user: w.publicKey, series, gapMint: mint, collateral: s1.collateral, userUsdc: usdc, userGap: gap, tokenProgram: TOKEN, token2022Program: TOKEN_2022,
    }).instruction();
    const before = await bal(c, usdc);
    const r = await send(c, [ix], [w]);
    return { paid: (await bal(c, usdc)) - before, cu: r.cu };
  };
  const rb = await redeem(b, 0, s1.downMint, B.down, B.usdc, SETS);
  const ra = await redeem(a, 1, s1.upMint, A.up, A.usdc, SETS);
  const sum = rb.paid + ra.paid;
  const left = await bal(c, s1.collateral);
  log(`B redeems 1,000 DOWN → ${(Number(rb.paid) / 1e6).toFixed(6)} USDC (${rb.cu} CU); A redeems 1,000 UP → ${(Number(ra.paid) / 1e6).toFixed(6)} USDC (${ra.cu} CU)`);
  log(`payouts ${(Number(sum) / 1e6).toFixed(6)} USDC = collateral ${(Number(collateral0) / 1e6).toFixed(6)} USDC; left in the collateral account: ${left}`);
  if (sum !== collateral0 || left !== 0n) throw new Error('the payouts do not add up to the collateral');

  const result = {
    ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), status: DISCLAIMER, ticker: T, closureId,
    bandPct: k * 100, gapPct: GAP * 100, close: pClose, open: pOpen, downMicro: s1.downMicro, upMicro: s1.upMicro,
    sets: Number(SETS) / 1e6, collateralUsdc: Number(collateral0) / 1e6, paidB_down: Number(rb.paid) / 1e6, paidA_up: Number(ra.paid) / 1e6,
    payoutsEqualCollateral: sum === collateral0, collateralLeft: Number(left), cu: { mint: minted.cu, redeem: rb.cu }, keeper: { failed: settle.failed },
    real: ['credence_core built from this repo: init_gap_series, mint_gap_set, settle_gap_series (from the epoch\'s stored prices), redeem_gap', 'Token-2022 mints created by the program, mint authority revoked at settlement'],
    simulated: ['the clock (surfpool time travel)', 'wallet SOL and USDC (cheatcodes)', ...simulated],
  };
  mkdirSync(join(ROOT, 'data/demo'), { recursive: true });
  writeFileSync(join(ROOT, 'data/demo/gap-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`@@result ${JSON.stringify(result)}`);
}
main().catch((e) => { console.error(redact(String(e?.stack ?? e))); process.exit(1); });
