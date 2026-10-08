// One simulated weekend on the surfpool mainnet fork (task 3.2; started by scripts/demo.sh, which deploys the program
// and loads the data first). Every step goes through the real program, real klend and the keeper's own jobs; what is
// simulated is said where it happens and summarised in data/demo/demo-result.json.
//
//   1. Two LPs deposit; the keeper opens the next four weekends' epochs.
//   2. A real near-threshold obligation from mainnet is picked: the eligible SPYx positions of the latest task 3.3 scan
//      (data/positions) are refreshed on the fork and the largest one at a fresh D/C′ of 0.94–0.995 wins (or
//      DEMO_OBLIGATION). The scan reads values from each obligation's last refresh, which can be days old. It is given
//      to the demo wallet by rewriting its owner field on the fork (SIMULATED: we cannot sign for the real owner;
//      collateral, debt, reserves and farms stay real). The wallet buys cover after klend refreshes, as the app would.
//   3. One LP queues a withdrawal and a third queues a deposit while the weekend is live.
//   4. Clock → Friday close + 30 s. SCOPE assets (the default): Kamino's Scope entry holds the genuine Scope reading
//      from the real close window when the recorder captured one (data/live/events-*.jsonl), else the mainnet Scope
//      value cloned at the start of the demo with its refresh time moved to the close (SIMULATED time, REAL price).
//      XSTOCK assets: the recorded Pyth push update, restamped the same way when needed. Keeper: close.
//   5. Clock → Monday open + 75 s. Kamino's Scope entry (and any push account) moves by DEMO_GAP (default −8%) from the
//      close, refreshed at open + 70 s (SIMULATED: the real Monday has not happened; Kamino itself sees this price).
//      Keeper: settlement price, every policy settled (repay CPI into the obligation), queues processed.
import { config } from 'dotenv';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import {
  type Chain, EPOCH, ROOT, SCOPE_PRICES, SOURCE, TOKEN, USDC_MINT, decodeScope, ata, chainNow, connect, createAtaIx, decodePriceUpdate,
  fmtTime, log, pdas, pk, pushAccount, send, tickerStr,
} from './chain.js';
import { setAccount, setTokenBalance, timeTravel } from './fork.js';
import { borrowedSf, borrows, deposits, loadObligation, refreshIxs } from './kamino.js';
import { tick } from './jobs.js';
import { recordedScope, writeScope } from './weekend.js';

config({ path: join(ROOT, '.env'), quiet: true });
const GAP = Number(process.env.DEMO_GAP ?? -0.08);
const USDC = (x: number) => BigInt(Math.round(x * 1e6));
const fmt = (base: bigint | number) => (Number(base) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());
type Kp = InstanceType<typeof web3.Keypair>;

const simulated: string[] = [];

async function wallet(c: Chain, usdc: number): Promise<Kp> {
  const k = web3.Keypair.generate();
  await c.conn.confirmTransaction(await c.conn.requestAirdrop(k.publicKey, 10e9), 'confirmed');
  if (usdc > 0) await setTokenBalance(c, k.publicKey.toBase58(), USDC_MINT.toBase58(), USDC(usdc));
  return k;
}

async function deposit(c: Chain, lp: Kp, usdc: number) {
  await send(c, [
    createAtaIx(c.payer.publicKey, lp.publicKey, pdas.shares()),
    await c.program.methods.deposit(new BN(USDC(usdc).toString()))
      .accountsPartial({ depositor: lp.publicKey, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(),
        depositorUsdc: ata(lp.publicKey, USDC_MINT), depositorShares: ata(lp.publicKey, pdas.shares()), shareEscrow: pdas.shareEscrow() })
      .instruction(),
  ], [lp]);
}

async function vaultState(c: Chain) {
  const v = await c.program.account.vault.fetch(pdas.vault());
  const supply = BigInt((await c.conn.getTokenSupply(pdas.shares())).value.amount);
  return { equity: BigInt(v.equity.toString()), supply, premiumsUnearned: BigInt(v.premiumsUnearned.toString()),
    reserved: BigInt(v.reservedTotal.toString()), liveGroups: v.liveGroups as number, v };
}

/** D/C′ of an obligation after a klend refresh on the fork (klend's own debt and unhealthy borrow value). */
async function freshRatio(c: Chain, key: InstanceType<typeof web3.PublicKey>): Promise<{ ratio: number; debtUsd: number } | null> {
  const ob = await loadObligation(c, key);
  if (!ob) return null;
  try {
    await send(c, await refreshIxs(c, key, ob));
  } catch {
    return null;
  }
  const o = (await loadObligation(c, key))!;
  const unhealthy = Number(BigInt(o.unhealthyBorrowValueSf.toString()) >> 40n) / 2 ** 20;
  const debtUsd = Number(BigInt(o.borrowFactorAdjustedDebtValueSf.toString()) >> 40n) / 2 ** 20;
  return unhealthy > 0 ? { ratio: debtUsd / unhealthy, debtUsd } : null;
}

/** The demo position: DEMO_OBLIGATION, or the largest eligible SPYx obligation of the latest scan whose D/C′ after a
 * fresh refresh is in [0.94, 0.995] (a −8% gap then pays). */
async function pickObligation(c: Chain) {
  if (process.env.DEMO_OBLIGATION) return pk(process.env.DEMO_OBLIGATION);
  const dir = join(ROOT, 'data/positions');
  const latest = readdirSync(dir).filter((f) => /^positions-\d+\.json$/.test(f)).sort().pop();
  if (!latest) throw new Error('no data/positions scan: run scripts/src/positions.ts (task 3.3) or set DEMO_OBLIGATION');
  const scan = JSON.parse(readFileSync(join(dir, latest), 'utf8')) as {
    positions: { obligation: string; eligible: boolean; deposits: { symbol: string }[]; debtUsd: number; debtToCovered: number }[];
  };
  const cands = scan.positions
    .filter((p) => p.eligible && p.deposits[0].symbol === 'SPYx' && p.debtToCovered >= 0.85 && p.debtToCovered < 1.1 && p.debtUsd >= 50)
    .sort((a, b) => b.debtUsd - a.debtUsd)
    .slice(0, 25);
  for (const p of cands) {
    const r = await freshRatio(c, pk(p.obligation));
    if (r) log(`  candidate ${p.obligation.slice(0, 8)}…: debt ${r.debtUsd.toFixed(2)} USD, D/C′ ${p.debtToCovered.toFixed(4)} in ${latest} → ${r.ratio.toFixed(4)} fresh`);
    if (r && r.ratio >= 0.94 && r.ratio <= 0.995) return pk(p.obligation);
  }
  throw new Error('no eligible SPYx obligation at a fresh D/C′ of 0.94–0.995; set DEMO_OBLIGATION');
}

/** The recorded genuine push account of `sym` to use for a close at `close`: an update from the real close window
 * if one was recorded, else the newest recording with its publish time moved into the window. */
function closeUpdate(sym: string, close: number, window: number) {
  const dir = join(ROOT, 'data/live/pyth');
  const recs = readdirSync(dir).filter((f) => f.startsWith(`${sym}-`)).map((f) => {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    const data = Buffer.from(j.account.data[0], 'base64');
    return { f, j, data, u: decodePriceUpdate(data) };
  }).sort((a, b) => a.u.publishTime - b.u.publishTime);
  if (recs.length === 0) throw new Error(`no recorded push updates for ${sym} in data/live/pyth (run scripts/src/record-prices.ts)`);
  const real = [...recs].reverse().find((r) => r.u.publishTime >= close - window && r.u.publishTime <= close);
  if (real) return { ...real, restamped: false };
  const r = recs[recs.length - 1];
  const data = Buffer.from(r.data);
  const t = close - 828; // the last push before a 16:00 ET close lands 4–14 min early
  data.writeBigInt64LE(BigInt(t), r.u.offsets.publishTime);
  data.writeBigInt64LE(BigInt(t - 1), r.u.offsets.prevPublishTime);
  return { ...r, data, restamped: true };
}

/** A push update at `t` with the price `ratio` × the given update's (conf and EMA scaled alike). */
function gapped(base: Buffer, ratio: number, t: number): Buffer {
  const d = Buffer.from(base);
  const u = decodePriceUpdate(d);
  const scale = (o: number, signed: boolean) => {
    const v = signed ? d.readBigInt64LE(o) : d.readBigUInt64LE(o);
    const x = BigInt(Math.round(Number(v) * ratio));
    if (signed) d.writeBigInt64LE(x, o); else d.writeBigUInt64LE(x, o);
  };
  scale(u.offsets.price, true);
  scale(u.offsets.conf, false);
  scale(u.offsets.emaPrice, true);
  scale(u.offsets.emaConf, false);
  d.writeBigInt64LE(BigInt(t), u.offsets.publishTime);
  d.writeBigInt64LE(BigInt(t - 1), u.offsets.prevPublishTime);
  return d;
}

async function main() {
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const t0 = Date.now();
  const startNow = await chainNow(c);
  log(`demo on ${c.url} — chain time ${fmtTime(startNow)}`);

  // 1. LPs and epochs.
  const [lpA, lpB, lpC] = [await wallet(c, 1_000_000), await wallet(c, 500_000), await wallet(c, 250_000)];
  await deposit(c, lpA, 1_000_000);
  await deposit(c, lpB, 500_000);
  log('LP A deposited 1,000,000 USDC, LP B 500,000 USDC');
  await tick(c);
  const assets = (await c.program.account.assetConfig.all()) as { publicKey: InstanceType<typeof web3.PublicKey>; account: any }[];
  const spy = assets.find((a) => tickerStr(a.account.ticker) === 'SPYx')!;
  const epochs = (await c.program.account.epoch.all()) as { publicKey: InstanceType<typeof web3.PublicKey>; account: any }[];
  const group = Math.min(...epochs.filter((e) => e.account.state === EPOCH.OPEN).map((e) => e.account.closureId as number));
  const ep = epochs.find((e) => e.account.closureId === group && tickerStr(e.account.ticker) === 'SPYx')!.account;
  const [close, open] = [n(ep.close), n(ep.open)];
  log(`weekend ${group}: close ${fmtTime(close)}, open ${fmtTime(open)}`);

  // 2. The demo wallet takes over a real near-threshold obligation (owner field) and buys cover.
  const OBLIGATION = await pickObligation(c);
  const owner = await wallet(c, 10_000);
  const acc = await c.conn.getAccountInfo(OBLIGATION);
  if (!acc) throw new Error(`obligation ${OBLIGATION} not found on mainnet`);
  const realOwner = new web3.PublicKey(acc.data.subarray(64, 96)).toBase58();
  const data = Buffer.from(acc.data);
  owner.publicKey.toBuffer().copy(data, 64);
  await setAccount(c, OBLIGATION.toBase58(), { lamports: acc.lamports, data, owner: acc.owner.toBase58() });
  simulated.push(`Obligation ${OBLIGATION.toBase58()} is real (mainnet), but its owner field (${realOwner}) was rewritten to the demo wallet so the demo can sign buy_cover.`);
  let ob = (await loadObligation(c, OBLIGATION))!;
  const [depRes, borRes] = [deposits(ob), borrows(ob)];
  if (depRes.length !== 1 || borRes.length !== 1) throw new Error('demo obligation must have one deposit and one borrow');
  await send(c, await refreshIxs(c, OBLIGATION, ob), []);
  ob = (await loadObligation(c, OBLIGATION))!;
  const debt = borrowedSf(ob, borRes[0]);
  const debtBase = (debt + (1n << 60n) - 1n) >> 60n;
  const unhealthy = Number(BigInt(ob.unhealthyBorrowValueSf.toString()) >> 40n) / 2 ** 20;
  const debtUsd = Number(BigInt(ob.borrowFactorAdjustedDebtValueSf.toString()) >> 40n) / 2 ** 20;
  log(`position ${OBLIGATION.toBase58().slice(0, 8)}…: debt ${fmt(debtBase)} USDC, D/C′ ${(debtUsd / unhealthy).toFixed(4)}`);

  const epochKey = pdas.epoch('SPYx', group);
  const policy = pdas.policy(epochKey, OBLIGATION);
  const vault0 = await vaultState(c);
  const buy = await c.program.methods
    .buyCover(spy.account.ticker, group, new BN(debtBase.toString()), new BN(USDC(1_000).toString()))
    .accountsPartial({
      buyer: owner.publicKey, asset: spy.publicKey, scenarios: pdas.scen('SPYx'), epoch: epochKey, loss: pdas.loss(group),
      vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), feeAccount: vault0.v.feeAccount,
      buyerUsdc: ata(owner.publicKey, USDC_MINT), obligation: OBLIGATION, depositReserve: depRes[0], borrowReserve: borRes[0],
      policy, tokenProgram: TOKEN,
    })
    .instruction();
  const bought = await send(c, [...(await refreshIxs(c, OBLIGATION, ob)), buy], [owner]);
  const pol0 = await c.program.account.policy.fetch(policy);
  log(`cover bought: cap ${fmt(BigInt(pol0.maxPayout.toString()))} USDC, premium ${fmt(BigInt(pol0.premium.toString()))} USDC, C′ ${fmt(BigInt(pol0.coveredValue.toString()))} (${bought.cu} CU incl. refreshes)`);

  // 3. Queue requests while the weekend is live.
  const lpBShares = BigInt((await c.conn.getTokenAccountBalance(ata(lpB.publicKey, pdas.shares()))).value.amount);
  await send(c, [await c.program.methods.requestWithdraw(new BN((lpBShares / 2n).toString()))
    .accountsPartial({ owner: lpB.publicKey, shareMint: pdas.shares(), shareEscrow: pdas.shareEscrow(),
      ownerShares: ata(lpB.publicKey, pdas.shares()), ticket: pdas.withdrawTicket(lpB.publicKey, group) })
    .instruction()], [lpB]);
  await send(c, [await c.program.methods.requestDeposit(new BN(USDC(250_000).toString()))
    .accountsPartial({ depositor: lpC.publicKey, vaultUsdc: pdas.vaultUsdc(), depositorUsdc: ata(lpC.publicKey, USDC_MINT),
      ticket: pdas.depositTicket(lpC.publicKey, group) })
    .instruction()], [lpC]);
  log(`LP B queued a withdrawal of ${fmt(lpBShares / 2n)} shares; LP C queued a deposit of 250,000 USDC (both wait for ${group})`);

  // 4. Friday close.
  const cfg = await c.program.account.config.fetch(pdas.config());
  const enabled = assets.filter((x) => x.account.enabled === 1);
  const scopeAssets = enabled.filter((x) => n(x.account.settleSource) === SOURCE.SCOPE);
  const pushAssets = enabled.filter((x) => n(x.account.settleSource) === SOURCE.XSTOCK);
  // Kamino's Scope values as cloned from mainnet now (before any time travel).
  const scopeNow = (await c.conn.getAccountInfo(SCOPE_PRICES))!.data;
  await timeTravel(c, close + 30);
  log(`clock → ${fmtTime(await chainNow(c))} (Friday close + 30 s)`);
  const closeScope: Record<string, { chain: number; price: number }> = {};
  const scopeWrites: { chain: number; price: number; ts: number }[] = [];
  for (const a of scopeAssets) {
    const sym = tickerStr(a.account.ticker);
    const chain = n(a.account.scopeChain);
    const real = recordedScope(sym, close - (cfg.closeWindowSecs as number), close + 900);
    if (real) {
      scopeWrites.push({ chain, price: real.price, ts: real.ts });
      log(`  ${sym}: REAL Kamino Scope close ${real.price.toFixed(4)} recorded at ${fmtTime(real.ts)}`);
    } else {
      const v = decodeScope(scopeNow, chain);
      scopeWrites.push({ chain, price: v.price, ts: close + 20 });
      simulated.push(`${sym} close: Kamino's real Scope price ${v.price.toFixed(4)} (cloned from mainnet at ${fmtTime(v.unixTimestamp)}), refresh time moved to ${fmtTime(close + 20)} because the real Friday close has not been recorded yet.`);
    }
    closeScope[sym] = { chain, price: scopeWrites.at(-1)!.price };
  }
  if (scopeWrites.length) await writeScope(c, scopeWrites);
  const closes: Record<string, { price: number; publishTime: number; restamped: boolean; data: Buffer }> = {};
  for (const a of pushAssets) {
    const sym = tickerStr(a.account.ticker);
    const u = closeUpdate(sym, close, cfg.xstockSettleWindowSecs);
    await setAccount(c, pushAccount(a.account.feedXstock).toBase58(), { lamports: u.j.account.lamports, data: u.data, owner: u.j.account.owner });
    const d = decodePriceUpdate(u.data);
    closes[sym] = { price: d.price, publishTime: d.publishTime, restamped: u.restamped, data: u.data };
    if (u.restamped) simulated.push(`${sym} close: genuine recorded Pyth update ${u.f} (price ${d.price.toFixed(4)}), publish time moved to ${fmtTime(d.publishTime)} because no update from the real close was recorded yet.`);
  }
  await tick(c);

  // 5. Monday open.
  await timeTravel(c, open + 75);
  log(`clock → ${fmtTime(await chainNow(c))} (Monday open + 75 s)`);
  if (scopeAssets.length) {
    await writeScope(c, Object.values(closeScope).map((x) => ({ chain: x.chain, price: x.price * (1 + GAP), ts: open + 70 })));
    simulated.push(`Monday open: Kamino's Scope price of every asset set ${(GAP * 100).toFixed(1)}% from its close, refreshed at ${fmtTime(open + 70)} (the real Monday has not happened; klend sees the same price).`);
  }
  for (const a of pushAssets) {
    const sym = tickerStr(a.account.ticker);
    await setAccount(c, pushAccount(a.account.feedXstock).toBase58(), {
      lamports: 1_000_000_000, data: gapped(closes[sym].data, 1 + GAP, open + 12), owner: 'rec2HHDDnjLfj4kE7VyEtFA1HPGQLK33259532cRyHp',
    });
  }
  if (pushAssets.length) simulated.push(`Monday open: the push accounts hold an update at ${fmtTime(open + 12)} priced ${(GAP * 100).toFixed(1)}% from the close.`);
  const debtBefore = borrowedSf((await loadObligation(c, OBLIGATION))!, borRes[0]);
  const vault1 = await vaultState(c);
  const r = await tick(c);

  // Summary.
  const pol = await c.program.account.policy.fetch(policy);
  const e = await c.program.account.epoch.fetch(epochKey);
  const debtAfter = borrowedSf((await loadObligation(c, OBLIGATION))!, borRes[0]);
  const vault2 = await vaultState(c);
  const lpBUsdc = BigInt((await c.conn.getTokenAccountBalance(ata(lpB.publicKey, USDC_MINT))).value.amount);
  const lpCShares = BigInt((await c.conn.getTokenAccountBalance(ata(lpC.publicKey, pdas.shares()))).value.amount);
  const nav = (v: { equity: bigint; supply: bigint }) => Number(v.equity) / Number(v.supply);
  const result = {
    ranAt: new Date().toISOString(),
    seconds: Math.round((Date.now() - t0) / 1000),
    rpc: c.url,
    group,
    chainTime: { start: fmtTime(startNow), close: fmtTime(close), open: fmtTime(open) },
    obligation: OBLIGATION.toBase58(),
    policy: {
      address: policy.toBase58(), state: pol.state, coveredValue: n(pol.coveredValue) / 1e6, debtAtPurchase: n(pol.debt) / 1e6,
      maxPayout: n(pol.maxPayout) / 1e6, premium: n(pol.premium) / 1e6, payout: n(pol.payout) / 1e6,
    },
    epoch: { state: e.state, closePrice: Number(BigInt(e.closePriceWad.toString()) / 10n ** 12n) / 1e6,
      settlePrice: Number(BigInt(e.settlePriceWad.toString()) / 10n ** 12n) / 1e6, gap: GAP },
    obligationDebtUsdc: { beforeSettlement: Number(debtBefore >> 60n) / 1e6, after: Number(debtAfter >> 60n) / 1e6 },
    vault: {
      beforeCover: { equity: Number(vault0.equity) / 1e6, nav: nav(vault0) },
      beforeSettlement: { equity: Number(vault1.equity) / 1e6, premiumsUnearned: Number(vault1.premiumsUnearned) / 1e6, liveGroups: vault1.liveGroups },
      after: { equity: Number(vault2.equity) / 1e6, nav: nav(vault2), premiumsUnearned: Number(vault2.premiumsUnearned) / 1e6, liveGroups: vault2.liveGroups },
    },
    queues: { lpBWithdrawnUsdc: Number(lpBUsdc) / 1e6, lpCSharesMinted: Number(lpCShares) / 1e6 },
    keeper: { sent: r.sent.length, failed: r.failed },
    real: [
      'klend program and every Kamino account (market, reserves, Scope, farms, the obligation\'s collateral and debt) cloned from mainnet on first use',
      'credence_core built from this repo; the repay is a real CPI into klend signed by the vault PDA',
      'settlement prices from Kamino\'s own Scope oracle (Chainlink Data Streams + Pyth Pro), the price klend liquidates on',
      'the XNYS calendar (real session times)',
    ],
    simulated: [
      'the clock: surfpool time travel to the Friday close and the Monday open',
      'USDC balances of the demo wallets (surfpool cheatcode)',
      ...simulated,
    ],
  };
  mkdirSync(join(ROOT, 'data/demo'), { recursive: true });
  writeFileSync(join(ROOT, 'data/demo/demo-result.json'), JSON.stringify(result, null, 2) + '\n');

  console.log('\n================ simulated weekend ' + group + ' ================');
  console.log(`SPYx close ${result.epoch.closePrice.toFixed(4)} → open ${result.epoch.settlePrice.toFixed(4)} (${(GAP * 100).toFixed(1)}%)`);
  console.log(`policy: premium ${fmt(BigInt(pol.premium.toString()))} USDC, cap ${fmt(BigInt(pol.maxPayout.toString()))}, payout ${fmt(BigInt(pol.payout.toString()))} USDC`);
  console.log(`obligation ${OBLIGATION.toBase58().slice(0, 8)}… debt ${fmt(debtBefore >> 60n)} → ${fmt(debtAfter >> 60n)} USDC (payout repaid into the position; interest accrues over the weekend)`);
  console.log(`vault equity ${fmt(vault0.equity)} → ${fmt(vault2.equity)} USDC, NAV/share ${nav(vault0).toFixed(6)} → ${nav(vault2).toFixed(6)}`);
  console.log(`queues: LP B received ${fmt(lpBUsdc)} USDC; LP C minted ${fmt(lpCShares)} shares`);
  console.log(`keeper: ${r.sent.length} transactions, ${r.failed.length} failed; ${result.seconds} s`);
  console.log('simulated:'); for (const s of result.simulated) console.log(`  - ${s}`);
  console.log('result: data/demo/demo-result.json');
  const ok = pol.state === 1 && e.state === EPOCH.SETTLED && r.failed.length === 0 && lpBUsdc > 0n && lpCShares > 0n;
  if (!ok) { console.error('DEMO FAILED'); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });

