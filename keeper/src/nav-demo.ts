// D4 demo on the surfpool mainnet fork (after scripts/demo.sh has loaded the data): A NAV-PRICED ASSET, RESEARCH PROTOTYPE.
//   1. The admin registers ONyc (OnRe's tokenized reinsurance, a classic SPL mint) with a daily strike schedule, its joint column and its
//      NAV_STRIKE scenario set (σ = an ASSUMED 0.5% floor: no down strike exists in the data).
//   2. The keeper's nav job opens the next closures. The demo wallet takes over a REAL ONyc/USDC obligation of Kamino's OnRe Market (owner
//      field rewritten, SIMULATED) and buys cover on it: priced on the NAV_STRIKE set.
//   3. The strike: the lender's own oracle (Kamino's Scope) is read as the close. The next strike: the NAV is marked down by DEMO_NAV_GAP
//      (default −20%, SIMULATED: no NAV has fallen in the sample) and the keeper settles; the payout is repaid into the obligation through klend.
// Everything is fork-only. Result: data/demo/nav-result.json.     pnpm -C keeper run nav-demo
import { config } from 'dotenv';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import { type Chain, EPOCH, ROOT, SCOPE_PRICES, TOKEN, USDC_MINT, ata, chainNow, connect, createAtaIx, decodeScope, fmtTime, log, pdas, pk, send, ticker8 } from './chain.js';
import { setAccount, setTokenBalance, timeTravel } from './fork.js';
import { borrowedSf, borrows, deposits, loadObligation, refreshIxs } from './kamino.js';
import { tick } from './jobs.js';
import { navPda, nextStrikes } from './nav.js';
import { restampScope, writeScope } from './weekend.js';
import { redact } from './redact.js';

config({ path: join(ROOT, '.env'), quiet: true });
const T = 'ONyc';
const GAP = Number(process.env.DEMO_NAV_GAP ?? -0.2);
const CAP = BigInt(Math.round(Number(process.env.DEMO_NAV_CAP ?? 25_000) * 1e6)); // USDC base units
const DISCLAIMER = 'NAV-priced asset (research prototype)';
const ONYC_MINT = pk('5Y8NV33Vv7WbnLfq3zBcKSdYPrk7g2KoiQoe7M2tcxp5');
const ONYC_RESERVE = pk('6ZxkBSJEqsXA3Kdm2PDAzHLUdPTPUK93Lf4bAezec1UQ');
const CHAIN = 350, TWAP = 478, USDC_CHAIN = 13;
const DAY = 86_400;
const simulated: string[] = [];
const data = (f: string) => JSON.parse(readFileSync(join(ROOT, 'data/nav', f), 'utf8'));
const hex32 = (s: string) => [...Buffer.from(s, 'hex')];
const fmt = (x: bigint | number) => (Number(x) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bal = async (c: Chain, k: InstanceType<typeof web3.PublicKey>) => BigInt((await c.conn.getTokenAccountBalance(k)).value.amount);

/** The fork fetches mainnet accounts lazily; a provider hiccup on that fetch is retried (the transaction itself is idempotent here). */
async function retry<T>(f: () => Promise<T>, tries = 4): Promise<T> {
  for (let i = 1; ; i++) {
    try {
      return await f();
    } catch (e) {
      if (i >= tries || !/Failed to fetch accounts from remote/.test(String((e as Error).message))) throw e;
      log(`  mainnet fetch failed (try ${i}), retrying`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
}

async function register(c: Chain) {
  const admin = c.payer.publicKey, m = c.program.methods, acct = c.program.account;
  const zero = Array(32).fill(0);
  if (!(await c.conn.getAccountInfo(pdas.asset(T)))) {
    const anchorTs = Math.floor(Date.UTC(2026, 9, 1) / 1000);
    await retry(() => m.addNavAsset(ticker8(T), {
      feedEquity: zero, feedXstock: zero, feedRedemption: zero, kaminoReserves: [ONYC_RESERVE, web3.PublicKey.default], sigmaWad: new BN('5000000000000000'),
      dividendWad: new BN(0), jointColumn: 0, enabled: true, settleSource: 2, scopeChain: CHAIN, basisSigmaWad: new BN(0),
    }, new BN(anchorTs), DAY).accountsPartial({ admin, config: pdas.config(), asset: pdas.asset(T), schedule: navPda(c.program.programId, T), mint: ONYC_MINT, tokenProgram: TOKEN }).rpc());
    log('ONyc registered: Scope chain 350, daily strikes from 2026-10-01 00:00 UTC, σ floor 0.5%');
  }
  const joint = data('joint-v3.json');
  const jset = pdas.joint(joint.version);
  const jex = await acct.jointSet.fetchNullable(jset);
  if (!jex) await m.initJointSet(joint.version, joint.tickers.map(ticker8)).accountsPartial({ admin, config: pdas.config(), set: jset }).rpc();
  if (!jex || jex.finalized === 0) {
    await m.writeJoint(0, 0, joint.columns[0]).accountsPartial({ admin, config: pdas.config(), set: jset }).rpc();
    await m.finalizeJointSet(hex32(joint.sha256)).accountsPartial({ admin, config: pdas.config(), set: jset }).rpc();
  }
  const st = await acct.assetConfig.fetch(pdas.asset(T));
  if (st.gfCount !== 256) {
    for (let start = 0; start < 256; start += 128) {
      await m.computeGapFactors(start, 128).accountsPartial({ admin, config: pdas.config(), asset: pdas.asset(T), joint: jset }).preInstructions([web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })]).rpc();
    }
  }
  const f = data('ONyc-NAV_STRIKE.json');
  const sset = pdas.scen(T, 4);
  const ex = await acct.scenarioSet.fetchNullable(sset);
  if (!ex) await m.initScenarioSet(ticker8(T), 4, f.n).accountsPartial({ admin, config: pdas.config(), set: sset }).rpc();
  if (!ex || ex.finalized === 0) {
    for (let off = 0; off < f.n; off += 400) await m.writeScenarios(off, f.z.slice(off, off + 400)).accountsPartial({ admin, config: pdas.config(), set: sset }).rpc();
    await m.finalizeScenarioSet(hex32(f.sha256)).accountsPartial({ admin, config: pdas.config(), set: sset, asset: pdas.asset(T) }).rpc();
  }
  if (!ex || ex.sigmaWad.toString() !== f.sigmaWad) await m.setScenarioSigma(new BN(f.sigmaWad)).accountsPartial({ admin, config: pdas.config(), set: sset }).rpc();
  if (createHash('sha256').update(Buffer.from(Int16Array.from(f.z).buffer)).digest('hex') !== f.sha256) throw new Error('scenario file does not match its hash');
}

/** Scope entries of the NAV asset and USDC moved to the fork clock (price kept; the TWAP follows a simulated move). */
/** Every Scope entry moved to the fork clock (price kept). Stamping only the NAV chains is enough near real time but not once the fork's clock
 * has travelled weeks (klend then flags the NAV reserve's TWAP as stale): measured, the whole account must move. */
async function restampAll(c: Chain) {
  const acc = (await c.conn.getAccountInfo(SCOPE_PRICES))!;
  const d = Buffer.from(acc.data);
  const [slot, now] = [BigInt(await c.conn.getSlot()), BigInt(await chainNow(c))];
  for (let i = 0; i < 512; i++) {
    const o = 8 + 32 + i * 56;
    if (d.readBigUInt64LE(o + 24) === 0n) continue;
    d.writeBigUInt64LE(slot, o + 16);
    d.writeBigUInt64LE(now, o + 24);
  }
  await setAccount(c, SCOPE_PRICES.toBase58(), { lamports: acc.lamports, data: d, owner: acc.owner.toBase58() });
}
const fresh = async (c: Chain) => {
  const r = await restampScope(c, [{ price: CHAIN, twap: TWAP }, { price: USDC_CHAIN, twap: null }]);
  await restampAll(c);
  if (process.env.NAV_DEBUG) {
    const [now, sc, slot] = [await chainNow(c), (await c.conn.getAccountInfo(SCOPE_PRICES))!.data, await c.conn.getSlot()];
    for (const ch of [CHAIN, TWAP, USDC_CHAIN]) { const d = decodeScope(sc, ch); log(`  scope ${ch}: ${d.price} age ${now - d.unixTimestamp}s, chain time ${fmtTime(now)}, slot ${slot}`); }
  }
  return r;
};

async function main() {
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const t0 = Date.now();
  log(`${DISCLAIMER}: ${T} on ${c.url} — chain time ${fmtTime(await chainNow(c))}`);
  await register(c);
  const v = await c.program.account.vault.fetch(pdas.vault());
  if (BigInt(v.equity.toString()) < 100_000n * 1_000_000n) {
    // A fresh fork (ONLY_NAV=1): an LP funds the vault, as the weekend demo's LPs do.
    const lp = web3.Keypair.generate();
    await c.conn.confirmTransaction(await c.conn.requestAirdrop(lp.publicKey, 5e9), 'confirmed');
    await setTokenBalance(c, lp.publicKey.toBase58(), USDC_MINT.toBase58(), 1_000_000n * 1_000_000n);
    await send(c, [createAtaIx(c.payer.publicKey, lp.publicKey, pdas.shares()), await c.program.methods.deposit(new BN((1_000_000n * 1_000_000n).toString()))
      .accountsPartial({ depositor: lp.publicKey, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), depositorUsdc: ata(lp.publicKey, USDC_MINT), depositorShares: ata(lp.publicKey, pdas.shares()), shareEscrow: pdas.shareEscrow() })
      .instruction()], [lp]);
    simulated.push("An LP's 1,000,000 USDC were credited with a cheatcode and deposited (the vault was empty).");
  }

  // 1. The next strike with a bell ahead; the nav job opens it (and the one after).
  if (process.env.DEMO_NAV_AT) await timeTravel(c, Number(process.env.DEMO_NAV_AT)); // test hook: start the demo later on the fork's clock
  let now = await chainNow(c);
  const sched = await c.program.account.navSchedule.fetch(navPda(c.program.programId, T));
  const [strike] = nextStrikes(Number(sched.anchorTs.toString()), sched.intervalSecs as number, now, 1);
  const closureId = strike.id, close = strike.close, open = close + DAY;
  if (now < close - DAY) { await timeTravel(c, close - 3 * 3600); simulated.push(`The fork's clock moved to ${fmtTime(close - 3 * 3600)}, into the sale window of the strike on ${closureId}.`); now = await chainNow(c); }
  await fresh(c);
  const { navJob } = await import('./nav.js');
  const opened = await navJob(c);
  if (opened.failed.length) throw new Error(`nav job failed: ${opened.failed.join('; ')}`);
  const epochKey = pdas.epoch(T, closureId);
  const ep0 = (await c.program.account.epoch.fetch(epochKey)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  log(`closure ${closureId}: strike ${fmtTime(close)} → ${fmtTime(open)}, type NAV_STRIKE (${ep0.closureType}), bell ${fmtTime(Number(ep0.bell.toString()))}`);

  // 2. The demo wallet takes over a real ONyc/USDC obligation and buys cover.
  const snap = JSON.parse(readFileSync(join(ROOT, 'programs/credence-core/tests/fixtures/onre/snapshot.json'), 'utf8'));
  const OBLIGATION = pk(process.env.DEMO_NAV_OBLIGATION ?? snap.accounts.obligation.address);
  const owner = web3.Keypair.generate();
  await c.conn.confirmTransaction(await c.conn.requestAirdrop(owner.publicKey, 10e9), 'confirmed');
  await setTokenBalance(c, owner.publicKey.toBase58(), USDC_MINT.toBase58(), 10_000n * 1_000_000n);
  simulated.push("The demo wallet's SOL and 10,000 USDC were credited with cheatcodes (no real USDC moves).");
  const acc = await c.conn.getAccountInfo(OBLIGATION);
  if (!acc) throw new Error(`obligation ${OBLIGATION} not found on mainnet`);
  const realOwner = new web3.PublicKey(acc.data.subarray(64, 96)).toBase58();
  const buf = Buffer.from(acc.data);
  owner.publicKey.toBuffer().copy(buf, 64);
  await setAccount(c, OBLIGATION.toBase58(), { lamports: acc.lamports, data: buf, owner: acc.owner.toBase58() });
  simulated.push(`Obligation ${OBLIGATION.toBase58()} is real (OnRe Market, mainnet), but its owner field (${realOwner}) was rewritten to the demo wallet so the demo can sign buy_cover.`);
  let ob = (await loadObligation(c, OBLIGATION))!;
  const [dep, bor] = [deposits(ob), borrows(ob)];
  if (dep.length !== 1 || bor.length !== 1 || !dep[0].equals(ONYC_RESERVE)) throw new Error('the demo obligation must have one ONyc deposit and one borrow; set DEMO_NAV_OBLIGATION');
  await fresh(c);
  await send(c, await refreshIxs(c, OBLIGATION, ob), []);
  ob = (await loadObligation(c, OBLIGATION))!;
  log(`obligation refreshed: stale ${ob.lastUpdate.stale}, price status 0b${ob.lastUpdate.priceStatus.toString(2).padStart(6, '0')} (all checks = 0b111111)`);
  const debt = (borrowedSf(ob, bor[0]) + (1n << 60n) - 1n) >> 60n;
  const unhealthy = Number(BigInt(ob.unhealthyBorrowValueSf.toString()) >> 40n) / 2 ** 20;
  const debtUsd = Number(BigInt(ob.borrowFactorAdjustedDebtValueSf.toString()) >> 40n) / 2 ** 20;
  log(`position ${OBLIGATION.toBase58().slice(0, 8)}…: debt ${fmt(debt)} USDC, D/C′ ${(debtUsd / unhealthy).toFixed(4)}`);
  const cap = CAP < debt ? CAP : debt;
  const vault0 = await c.program.account.vault.fetch(pdas.vault());
  const policy = pdas.policy(epochKey, OBLIGATION);
  const buy = await c.program.methods.buyCover(ep0.ticker, closureId, new BN(cap.toString()), new BN((100n * 1_000_000n).toString()))
    .accountsPartial({
      buyer: owner.publicKey, asset: pdas.asset(T), scenarios: pdas.scen(T, 4), epoch: epochKey, earnings: pdas.earnings(T), loss: pdas.loss(closureId),
      vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), feeAccount: vault0.feeAccount, buyerUsdc: ata(owner.publicKey, USDC_MINT),
      obligation: OBLIGATION, depositReserve: dep[0], borrowReserve: bor[0], policy, tokenProgram: TOKEN,
    }).instruction();
  const bought = await send(c, [...(await refreshIxs(c, OBLIGATION, ob)), buy], [owner]);
  const pol0 = (await c.program.account.policy.fetch(policy)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  log(`cover bought: cap ${fmt(BigInt(pol0.maxPayout.toString()))} USDC, premium ${fmt(BigInt(pol0.premium.toString()))} USDC, C′ ${fmt(BigInt(pol0.coveredValue.toString()))} (${bought.cu} CU incl. refreshes)`);

  // 3. The strike: Kamino's Scope price is the close; the next strike marks the NAV down by GAP (SIMULATED).
  const mainnet = new web3.Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
  const pClose = decodeScope((await mainnet.getAccountInfo(SCOPE_PRICES))!.data, CHAIN).price;
  const pOpen = pClose * (1 + GAP);
  await timeTravel(c, close + 30);
  await writeScope(c, [{ chain: CHAIN, price: pClose, ts: close + 20 }]);
  await fresh(c);
  const r1 = await tick(c);
  const e1 = (await c.program.account.epoch.fetch(epochKey)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (e1.state !== EPOCH.CLOSED) throw new Error(`the close was not stored (state ${e1.state}); keeper: ${JSON.stringify(r1)}`);
  await timeTravel(c, open + 75);
  await writeScope(c, [{ chain: CHAIN, price: pOpen, ts: open + 70 }]);
  await fresh(c);
  simulated.push(`ONyc closes at Kamino's Scope price on the fork (${pClose.toFixed(6)}); the next strike is SIMULATED at ${pOpen.toFixed(6)} (${(GAP * 100).toFixed(1)}%): no NAV has fallen in the 90-day sample. Refresh times moved to the strikes.`);
  const debt0 = (borrowedSf((await loadObligation(c, OBLIGATION))!, bor[0]) + (1n << 60n) - 1n) >> 60n;
  const r2 = await tick(c); // post_settlement, then settle_policy (repay into the obligation through klend)
  const e2 = (await c.program.account.epoch.fetch(epochKey)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  const pol1 = (await c.program.account.policy.fetch(policy)) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (e2.state !== EPOCH.SETTLED || pol1.state !== 1) throw new Error(`not settled (epoch ${e2.state}, policy ${pol1.state}); keeper: ${JSON.stringify(r2)}`);
  const debt1 = (borrowedSf((await loadObligation(c, OBLIGATION))!, bor[0]) + (1n << 60n) - 1n) >> 60n;
  const payout = BigInt(pol1.payout.toString());
  log(`settled on the lender's oracle: close ${(Number(BigInt(e2.closePriceWad.toString())) / 1e18).toFixed(6)} → ${(Number(BigInt(e2.settlePriceWad.toString())) / 1e18).toFixed(6)}; payout ${fmt(payout)} USDC repaid into the obligation (debt ${fmt(debt0)} → ${fmt(debt1)})`);
  if (payout === 0n || debt1 + payout / 2n >= debt0) throw new Error('the payout did not reach the obligation');

  const result = {
    ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), status: DISCLAIMER, ticker: T, closureId, strike: close, nextStrike: open,
    obligation: OBLIGATION.toBase58(), debtUsdc: Number(debt) / 1e6, debtToCovered: debtUsd / unhealthy, capUsdc: Number(cap) / 1e6,
    premiumUsdc: Number(pol0.premium.toString()) / 1e6, close: pClose, settle: pOpen, gapPct: GAP * 100, payoutUsdc: Number(payout) / 1e6,
    debtBefore: Number(debt0) / 1e6, debtAfter: Number(debt1) / 1e6, cu: { buyWithRefreshes: bought.cu }, keeper: { closeFailed: r1.failed, settleFailed: r2.failed },
    real: ['credence_core built from this repo: add_nav_asset, open_nav_epoch (the keeper nav job), buy_cover on a real OnRe Market obligation, snapshot_close and post_settlement from Kamino\'s Scope, settle_policy', 'klend repay_obligation_liquidity_v2 signed by the vault PDA'],
    simulated: ['the clock (surfpool time travel)', 'wallet SOL and USDC (cheatcodes)', 'the obligation owner field', ...simulated],
    assumptions: ['σ per strike is an assumed 0.5% floor and the 3,000 gaps are Student-t(3) quantiles (data/nav/ONyc-NAV_STRIKE.json): the data has no down strike', 'the daily strike is a schedule this program chose, not the issuer\'s'],
  };
  mkdirSync(join(ROOT, 'data/demo'), { recursive: true });
  writeFileSync(join(ROOT, 'data/demo/nav-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`@@result ${JSON.stringify(result)}`);
}
main().catch((e) => { console.error(redact(String(e?.stack ?? e))); process.exit(1); });
