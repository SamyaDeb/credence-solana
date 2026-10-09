// W11 Cover v2 demo on the surfpool mainnet fork (after scripts/demo.sh has deployed and loaded the program with the
// OVERNIGHT and HOLIDAY_WEEKEND sets): three closures on SPYx, every position opened through real klend.
//
//   A. Weekend, both sides: a long (SPYx deposited, USDC borrowed) buys DOWN cover and a short (USDC deposited, SPYx
//      borrowed) buys UP cover in the same weekend. Their losses sit in opposite scenarios of one loss vector: the group
//      reserves less than the two policies' worst losses added. SPYx opens +8% (SIMULATED): the UP policy pays the
//      short's owner in USDC, the DOWN policy pays nothing.
//   B. Overnight: a long covered for one night (its own OVERNIGHT set, σ and 1 day); SPYx opens −6% the next morning.
//   C. Holiday weekend: the next HOLIDAY_WEEKEND closure in the calendar (Thursday Dec 24, 2026 → Monday Dec 28); a
//      long covered on the HOLIDAY_WEEKEND set and 4 days; SPYx opens −8% after the holiday.
// Positions: SPYx or USDC from cheatcodes (SIMULATED), then klend-sdk deposit + borrow signed by the owner (REAL).
// Prices: Kamino's Scope SPYx at its value on the fork at the start, refresh times moved to each close and open.
// Result: data/demo/cover-v2-result.json.     pnpm -C keeper run cover-v2-demo
import { config } from 'dotenv';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import { type Chain, CLOSURE, EPOCH, ROOT, SCOPE_PRICES, TOKEN, USDC_MINT, ata, chainNow, connect, createAtaIx, decodeScope, fmtTime, log, pdas, send, tickerStr } from './chain.js';
import { setTokenBalance, timeTravel } from './fork.js';
import { borrowedSf, loadObligation, loadReserve, refreshIxs } from './kamino.js';
import { tick } from './jobs.js';
import { freshPrices, openPosition, openShort } from './create-position.js';
import { writeScope } from './weekend.js';

config({ path: join(ROOT, '.env'), quiet: true });
const T = 'SPYx';
const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());
type Pk = InstanceType<typeof web3.PublicKey>;
type Kp = InstanceType<typeof web3.Keypair>;
const simulated: string[] = [];

async function wallet(c: Chain, usdc: number): Promise<Kp> {
  const k = web3.Keypair.generate();
  await c.conn.confirmTransaction(await c.conn.requestAirdrop(k.publicKey, 10e9), 'confirmed');
  if (usdc > 0) await setTokenBalance(c, k.publicKey.toBase58(), USDC_MINT.toBase58(), BigInt(usdc * 1e6));
  return k;
}

/** Epoch of SPYx on sale now for the next closure of `type`. */
async function onSale(c: Chain, type: number) {
  const now = await chainNow(c);
  const es = ((await c.program.account.epoch.all()) as { publicKey: Pk; account: any }[])
    .filter((e) => tickerStr(e.account.ticker) === T && e.account.closureType === type && e.account.state === EPOCH.OPEN && n(e.account.saleOpen) <= now && n(e.account.bell) > now)
    .sort((a, b) => a.account.closureId - b.account.closureId);
  if (!es.length) throw new Error(`no ${T} epoch of closure type ${type} on sale at ${fmtTime(now)}`);
  return es[0];
}

/** buy_cover (DOWN) or buy_cover_up (UP) for `obligation` on `epoch`, refreshes first; the policy. */
async function buy(c: Chain, owner: Kp, obligation: Pk, epoch: { publicKey: Pk; account: any }, up: boolean, capShare = 1) {
  await freshPrices(c);
  const ob = (await loadObligation(c, obligation))!;
  const asset = (await c.program.account.assetConfig.fetch(pdas.asset(T))) as any;
  const v = await c.program.account.vault.fetch(pdas.vault());
  const group = epoch.account.closureId as number;
  const policy = pdas.policy(epoch.publicKey, obligation);
  const common = { buyer: owner.publicKey, asset: pdas.asset(T), scenarios: pdas.scen(T, epoch.account.closureType), epoch: epoch.publicKey,
    earnings: pdas.earnings(T), loss: pdas.loss(group), vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), feeAccount: v.feeAccount,
    buyerUsdc: ata(owner.publicKey, USDC_MINT), obligation, policy, tokenProgram: TOKEN };
  let ix;
  if (up) {
    const d = await c.conn.getAccountInfo(obligation);
    const bfDebt = Number(d!.data.readBigUInt64LE(2208) + (d!.data.readBigUInt64LE(2216) << 64n) >> 0n) / 2 ** 60; // USD
    const cap = BigInt(Math.floor(bfDebt * 1e6 * capShare));
    ix = await c.program.methods.buyCoverUp(asset.ticker, group, new BN(cap.toString()), new BN('50000000000'))
      .accountsPartial({ ...common, borrowReserve: new web3.PublicKey(ob.borrows[0].borrowReserve) })
      .remainingAccounts(ob.deposits.filter((x) => x.depositReserve !== '11111111111111111111111111111111').map((x) => ({ pubkey: new web3.PublicKey(x.depositReserve), isSigner: false, isWritable: false })))
      .instruction();
  } else {
    const debt = borrowedSf(ob, new web3.PublicKey(ob.borrows[0].borrowReserve)) >> 60n; // ≤ the refreshed debt
    ix = await c.program.methods.buyCover(asset.ticker, group, new BN(debt.toString()), new BN('50000000000'))
      .accountsPartial({ ...common, depositReserve: new web3.PublicKey(ob.deposits[0].depositReserve), borrowReserve: new web3.PublicKey(ob.borrows[0].borrowReserve) })
      .instruction();
  }
  const r = await send(c, [...(await refreshIxs(c, obligation, ob)), ix], [owner]);
  const p = await c.program.account.policy.fetch(policy);
  return { policy, p, cu: r.cu };
}

/** Kamino's Scope SPYx at `price`, refreshed at `ts` (Credence's chain = the reserve's). */
async function scopeAt(c: Chain, price: number, ts: number) {
  const a = (await c.program.account.assetConfig.fetch(pdas.asset(T))) as any;
  await writeScope(c, [{ chain: n(a.scopeChain), price, ts }]);
}

const usd = (x: number) => (x / 1e6).toFixed(2);

async function main() {
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const t0 = Date.now();
  log(`Cover v2 demo on ${c.url} — chain time ${fmtTime(await chainNow(c))}`);
  const asset = (await c.program.account.assetConfig.fetch(pdas.asset(T))) as any;
  const p0 = decodeScope((await c.conn.getAccountInfo(SCOPE_PRICES))!.data, n(asset.scopeChain)).price;
  simulated.push(`SPYx closes at Kamino's Scope price on the fork at the start (${p0.toFixed(4)}); every close and open below is that price, moved as stated, with refresh times moved to the fork clock.`);
  // LP if the vault is small.
  const v0 = await c.program.account.vault.fetch(pdas.vault());
  if (BigInt(v0.equity.toString()) < 500_000_000_000n) {
    const lp = await wallet(c, 1_000_000);
    await send(c, [createAtaIx(c.payer.publicKey, lp.publicKey, pdas.shares()),
      await c.program.methods.deposit(new BN('1000000000000')).accountsPartial({ depositor: lp.publicKey, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(),
        depositorUsdc: ata(lp.publicKey, USDC_MINT), depositorShares: ata(lp.publicKey, pdas.shares()), shareEscrow: pdas.shareEscrow() }).instruction()], [lp]);
  }
  process.env.OVERNIGHT_AHEAD = '2';
  await tick(c);

  // A. Weekend: DOWN and UP in one group.
  const ew = await onSale(c, CLOSURE.WEEKEND);
  const gw = ew.account.closureId as number;
  const longOwner = await wallet(c, 10_000);
  const long = await openPosition(c, longOwner, 50_000, 0.96);
  const down = await buy(c, longOwner, long.obligation, ew, false);
  const lossAfterDown = (await c.program.account.lossVector.fetch(pdas.loss(gw))).maxLoss;
  const shortOwner = await wallet(c, 10_000);
  // The short opens below the close and SPYx rises into Friday's close; every price stays inside klend's heuristic band
  // for the reserve (a price outside it fails every refresh), the +8% open included.
  const h = (await loadReserve(c, new web3.PublicKey(asset.kaminoReserves[0]))).config.tokenInfo.heuristic as unknown as { lower: unknown; upper: unknown; exp: unknown };
  const band = (x: unknown) => Number(String(x)) / 10 ** Number(String(h.exp));
  const closeTarget = Math.min(p0, band(h.upper) / 1.08 * 0.99);
  const pShort = Math.max(closeTarget / 1.12, band(h.lower) * 1.01);
  await scopeAt(c, pShort, await chainNow(c));
  await freshPrices(c);
  const short = await openShort(c, shortOwner, 60_000, 0.98);
  await setTokenBalance(c, shortOwner.publicKey.toBase58(), USDC_MINT.toBase58(), 10_000_000_000n); // the deposit used the wallet's USDC: premium money
  // A short can borrow only to its LTV, below where a stress scenario hurts it: SPYx rises on Friday until the short
  // is at D/C′ ≈ 0.97 (SIMULATED move), the way shorts near their threshold.
  await send(c, await refreshIxs(c, short.obligation, (await loadObligation(c, short.obligation))!), []);
  const so = await c.conn.getAccountInfo(short.obligation);
  const r0 = (Number(so!.data.readBigUInt64LE(2208) + (so!.data.readBigUInt64LE(2216) << 64n))) / (Number(so!.data.readBigUInt64LE(2256) + (so!.data.readBigUInt64LE(2264) << 64n)));
  const lift = 0.97 / r0;
  const pClose = pShort * lift;
  await scopeAt(c, pClose, await chainNow(c));
  await freshPrices(c); // the TWAP follows a move that took the afternoon (klend refuses a TWAP more than 5% away)
  simulated.push(`Friday: the short opens with SPYx at ${pShort.toFixed(4)}, then SPYx rises ${((lift - 1) * 100).toFixed(2)}% (to ${pClose.toFixed(4)}) before it buys UP cover, taking it from D/C′ ${r0.toFixed(4)} to 0.97 (inside klend's price band ${band(h.lower)}–${band(h.upper)}).`);
  const up = await buy(c, shortOwner, short.obligation, ew, true, 0.5);
  const lw = await c.program.account.lossVector.fetch(pdas.loss(gw));
  const netting = { downWorst: n(down.p.worstLoss) / 1e6, upWorst: n(up.p.worstLoss) / 1e6, groupBefore: n(lossAfterDown) / 1e6, groupAfter: n(lw.maxLoss) / 1e6 };
  simulated.push(`Positions: a long ${long.obligation.toBase58()} (SPYx by cheatcode) and a short ${short.obligation.toBase58()} (USDC by cheatcode, ${short.borrowedSpyx.toFixed(4)} SPYx borrowed through klend).`);
  log(`weekend ${gw}: DOWN worst ${usd(n(down.p.worstLoss))}, UP worst ${usd(n(up.p.worstLoss))}; group reserves ${usd(n(lw.maxLoss))} (sum ${usd(n(down.p.worstLoss) + n(up.p.worstLoss))}); UP premium ${usd(n(up.p.premium))} (${up.cu} CU)`);
  await timeTravel(c, n(ew.account.close) + 30);
  await scopeAt(c, pClose, n(ew.account.close) + 20);
  await tick(c);
  await timeTravel(c, n(ew.account.open) + 75);
  await scopeAt(c, pClose * 1.08, n(ew.account.open) + 70);
  simulated.push(`Weekend ${gw}: SPYx opens +8% from the close.`);
  const w0 = BigInt((await c.conn.getTokenAccountBalance(ata(shortOwner.publicKey, USDC_MINT))).value.amount);
  const ra = await tick(c);
  const upEnd = await c.program.account.policy.fetch(up.policy);
  const downEnd = await c.program.account.policy.fetch(down.policy);
  const w1 = BigInt((await c.conn.getTokenAccountBalance(ata(shortOwner.publicKey, USDC_MINT))).value.amount);
  log(`open +8%: UP paid ${usd(n(upEnd.payout))} USDC to the short's wallet (+${usd(Number(w1 - w0))}); DOWN paid ${usd(n(downEnd.payout))}`);

  // B. Overnight: the next overnight closure. SPYx back at the first close (inside klend's heuristic band for the reserve).
  await scopeAt(c, p0, await chainNow(c));
  await freshPrices(c);
  simulated.push(`After weekend ${gw}: SPYx back at ${p0.toFixed(4)}.`);
  await tick(c);
  const en = await onSale(c, CLOSURE.OVERNIGHT);
  const nightOwner = await wallet(c, 10_000);
  const night = await openPosition(c, nightOwner, 50_000, 0.96);
  const nb = await buy(c, nightOwner, night.obligation, en, false);
  log(`overnight ${en.account.closureId}: premium ${usd(n(nb.p.premium))} USDC (weekend's was ${usd(n(down.p.premium))}), ${nb.cu} CU`);
  await timeTravel(c, n(en.account.close) + 30);
  await scopeAt(c, p0, n(en.account.close) + 20);
  await tick(c);
  await timeTravel(c, n(en.account.open) + 75);
  await scopeAt(c, p0 * 0.94, n(en.account.open) + 70);
  simulated.push(`Overnight ${en.account.closureId}: SPYx opens −6% the next morning.`);
  const rb = await tick(c);
  const nightEnd = await c.program.account.policy.fetch(nb.policy);
  log(`overnight open −6%: payout ${usd(n(nightEnd.payout))} USDC into the position`);

  // C. Holiday weekend: the next HOLIDAY_WEEKEND closure in the calendar.
  const cal = await c.program.account.calendar.fetch(pdas.calendar());
  const sessions = (cal.sessions as { date: number; open: unknown; close: unknown }[]).slice(0, cal.n as number);
  const now = await chainNow(c);
  const days = (d: number) => Date.UTC(Math.floor(d / 10000), Math.floor(d / 100) % 100 - 1, d % 100) / 86_400_000;
  const hi = sessions.findIndex((s, i) => i + 1 < sessions.length && n(s.close as never) > now + 86_400
    && days(sessions[i + 1].date) - days(s.date) > 3 // longer than Friday → Monday
    && new Date(days(s.date) * 86_400_000).getUTCDay() + days(sessions[i + 1].date) - days(s.date) > 7); // and spans a weekend
  const hs = sessions[hi];
  // Monday of that week, an hour after its open (the sale opens with the week's first session).
  let mi = hi;
  while (mi > 0 && days(sessions[mi - 1].date) >= days(hs.date) - (new Date(days(hs.date) * 86_400_000).getUTCDay() - 1)) mi--;
  await timeTravel(c, n(sessions[mi].open as never) + 3_600);
  await freshPrices(c);
  await tick(c);
  const eh = await onSale(c, CLOSURE.HOLIDAY_WEEKEND);
  const holOwner = await wallet(c, 10_000);
  const hol = await openPosition(c, holOwner, 50_000, 0.96);
  const hb = await buy(c, holOwner, hol.obligation, eh, false);
  log(`holiday weekend ${eh.account.closureId} (${fmtTime(n(eh.account.close))} → ${fmtTime(n(eh.account.open))}): premium ${usd(n(hb.p.premium))} USDC`);
  await timeTravel(c, n(eh.account.close) + 30);
  await scopeAt(c, p0, n(eh.account.close) + 20);
  await tick(c);
  await timeTravel(c, n(eh.account.open) + 75);
  await scopeAt(c, p0 * 0.92, n(eh.account.open) + 70);
  simulated.push(`Holiday weekend ${eh.account.closureId}: SPYx opens −8% after the holiday.`);
  const rc = await tick(c);
  const holEnd = await c.program.account.policy.fetch(hb.policy);
  log(`holiday open −8%: payout ${usd(n(holEnd.payout))} USDC into the position`);

  const result = {
    ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
    weekend: { group: gw, netting, up: { policy: up.policy.toBase58(), premium: n(up.p.premium) / 1e6, cap: n(up.p.maxPayout) / 1e6, payout: n(upEnd.payout) / 1e6, toWallet: Number(w1 - w0) / 1e6, buyCu: up.cu },
      down: { policy: down.policy.toBase58(), premium: n(down.p.premium) / 1e6, payout: n(downEnd.payout) / 1e6 }, open: '+8%' },
    overnight: { group: en.account.closureId, premium: n(nb.p.premium) / 1e6, payout: n(nightEnd.payout) / 1e6, open: '-6%', buyCu: nb.cu },
    holiday: { group: eh.account.closureId, close: fmtTime(n(eh.account.close)), open: fmtTime(n(eh.account.open)), premium: n(hb.p.premium) / 1e6, payout: n(holEnd.payout) / 1e6, openMove: '-8%' },
    keeper: { failed: [...ra.failed, ...rb.failed, ...rc.failed] },
    real: ['klend and every Kamino account cloned from mainnet; the long, the short and their deposits and borrows go through real klend',
      'credence_core built from this repo: buy_cover on each closure type, buy_cover_up, settle_policy (UP to the wallet)'],
    simulated: ['the clock (surfpool time travel)', 'USDC, SPYx and SOL of the demo wallets (cheatcodes)', ...simulated],
  };
  mkdirSync(join(ROOT, 'data/demo'), { recursive: true });
  writeFileSync(join(ROOT, 'data/demo/cover-v2-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`\n================ Cover v2 demo ================`);
  console.log(`weekend: group reserves ${netting.groupAfter.toFixed(2)} for DOWN ${netting.downWorst.toFixed(2)} + UP ${netting.upWorst.toFixed(2)}; +8% → UP ${result.weekend.up.payout.toFixed(2)} to the wallet`);
  console.log(`overnight −6% → ${result.overnight.payout.toFixed(2)}; holiday −8% → ${result.holiday.payout.toFixed(2)}`);
  console.log('simulated:'); for (const s of result.simulated) console.log(`  - ${s}`);
  console.log(`@@result ${JSON.stringify(result)}`);
  const ok = result.weekend.up.payout > 0 && result.weekend.up.toWallet === result.weekend.up.payout && netting.groupAfter < netting.downWorst + netting.upWorst
    && result.overnight.payout > 0 && result.holiday.payout > 0 && upEnd.state === 1 && nightEnd.state === 1 && holEnd.state === 1;
  if (!ok) { console.error('COVER V2 DEMO FAILED'); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
