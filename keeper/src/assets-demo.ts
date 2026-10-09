// W16 (task B4) demo on the surfpool mainnet fork (after scripts/demo.sh has loaded the eight xStocks):
//   A. The program's own quote (quote_cover, simulated, nothing sent) of one reference position on each covered xStock:
//      σ, premium per $1,000 of cover, the scenario sets it prices on (own calibration or pooled).
//   B. A real TSLAx obligation from the mainnet scan (owner field rewritten on the fork, SIMULATED) buys weekend cover on
//      TSLAx; TSLAx closes at Kamino's Scope price and opens −24% (SIMULATED); the keeper settles into the position.
// Result: data/demo/assets-result.json.     pnpm -C keeper run assets-demo
import { config } from 'dotenv';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import { type Chain, CLOSURE, EPOCH, ROOT, SCOPE_PRICES, TOKEN, USDC_MINT, ata, chainNow, connect, decodeScope, fmtTime, log, pdas, send, tickerStr } from './chain.js';
import { setAccount, setTokenBalance, timeTravel } from './fork.js';
import { borrowedSf, borrows, deposits, loadObligation, loadReserve, refreshIxs } from './kamino.js';
import { tick } from './jobs.js';
import { restampScope, writeScope } from './weekend.js';
import { borrowMore } from './create-position.js';
import { redact } from './redact.js';

config({ path: join(ROOT, '.env'), quiet: true });
const T = 'TSLAx';
const OBLIGATION = new web3.PublicKey(process.env.ASSETS_OBLIGATION ?? 'G9sFTAcFicBWWRWwDvu8LHuH1zNrWLiEpwiZr5qUumyj');
const GAP = -0.24;
const USDC_RESERVE = '97zoywd8mPZsGTg8q1wdD2Wgkdrs2tqusp1Qqcxbyj7E';
const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());
type Pk = InstanceType<typeof web3.PublicKey>;
const simulated: string[] = [];

/** Kamino's Scope (price, TWAP) pairs of `reserves`, restamped to the fork clock (prices unchanged). */
async function fresh(c: Chain, reserves: string[]) {
  const pairs: { price: number; twap: number | null }[] = [];
  for (const k of reserves) {
    const s = (await loadReserve(c, new web3.PublicKey(k))).config.tokenInfo.scopeConfiguration;
    pairs.push({ price: s.priceChain[0], twap: s.twapChain[0] !== 65535 ? s.twapChain[0] : null });
  }
  return restampScope(c, pairs);
}

async function main() {
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const t0 = Date.now();
  log(`every listed xStock demo on ${c.url} — chain time ${fmtTime(await chainNow(c))}`);
  await tick(c);
  const now = await chainNow(c);
  const epochs = (await c.program.account.epoch.all()) as { publicKey: Pk; account: any }[];
  const weekend = (t: string) => epochs.filter((e) => tickerStr(e.account.ticker) === t && e.account.closureType === CLOSURE.WEEKEND
    && e.account.state === EPOCH.OPEN && n(e.account.saleOpen) <= now && n(e.account.bell) > now).sort((a, b) => a.account.closureId - b.account.closureId)[0];

  // A. Quotes: one reference position (C′ 104,167 USDC, debt 100,000, cap 25,000) on every covered xStock.
  const assets = JSON.parse(readFileSync(join(ROOT, 'data/onchain/assets.json'), 'utf8')) as { ticker: string; sigmaSource: string }[];
  const quotes: Record<string, unknown>[] = [];
  for (const a of assets) {
    const ep = weekend(a.ticker);
    if (!ep) { quotes.push({ ticker: a.ticker, error: 'no weekend epoch on sale' }); continue; }
    const st = (await c.program.account.assetConfig.fetch(pdas.asset(a.ticker))) as any;
    let q;
    try {
      q = await c.program.methods.quoteCover(new BN(104_166_666_667), new BN(100_000_000_000), new BN(25_000_000_000))
        .accountsPartial({ config: pdas.config(), asset: pdas.asset(a.ticker), scenarios: pdas.scen(a.ticker, CLOSURE.WEEKEND), vault: pdas.vault(),
          loss: pdas.loss(ep.account.closureId), shareMint: pdas.shares(), epoch: ep.publicKey, earnings: pdas.earnings(a.ticker) })
        .preInstructions([web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
        .view();
    } catch (e) {
      const logs = ((e as { simulationResponse?: { logs?: string[] } }).simulationResponse?.logs ?? []).filter((l) => /Error|failed/.test(l));
      quotes.push({ ticker: a.ticker, error: logs.join(' | ') || String(e) });
      log(`${a.ticker.padEnd(7)} quote failed: ${logs.join(' | ') || String(e)}`);
      continue;
    }
    const premium = n(q.premium) / 1e6;
    quotes.push({ ticker: a.ticker, group: ep.account.closureId, sigmaPct: Number(st.sigmaWad.toString()) / 1e16, premiumUsdc: premium,
      per1kUsdc: (premium / 25_000) * 1000, worstLossUsdc: n(q.worstLoss) / 1e6, sigmaSource: a.sigmaSource });
    log(`${a.ticker.padEnd(7)} σ ${(Number(st.sigmaWad.toString()) / 1e16).toFixed(3)}%  premium ${premium.toFixed(2)} USDC for 25,000 of cover (${((premium / 25_000) * 1000).toFixed(2)} per $1,000)`);
  }

  // B. A real TSLAx obligation, weekend cover, −24% open.
  const ep = weekend(T);
  if (!ep) throw new Error(`no ${T} weekend epoch on sale at ${fmtTime(now)}`);
  const group = ep.account.closureId as number;
  const owner = web3.Keypair.generate();
  await c.conn.confirmTransaction(await c.conn.requestAirdrop(owner.publicKey, 10e9), 'confirmed');
  await setTokenBalance(c, owner.publicKey.toBase58(), USDC_MINT.toBase58(), 10_000_000_000n);
  const acc = (await c.conn.getAccountInfo(OBLIGATION))!;
  const realOwner = new web3.PublicKey(acc.data.subarray(64, 96)).toBase58();
  const data = Buffer.from(acc.data);
  owner.publicKey.toBuffer().copy(data, 64);
  await setAccount(c, OBLIGATION.toBase58(), { lamports: acc.lamports, data, owner: acc.owner.toBase58() });
  simulated.push(`TSLAx obligation ${OBLIGATION.toBase58()} is real (mainnet scan), but its owner field (${realOwner}) was rewritten to the demo wallet so it can sign buy_cover.`);
  let ob = (await loadObligation(c, OBLIGATION))!;
  const [dep, bor] = [deposits(ob), borrows(ob)];
  if (dep.length !== 1 || bor.length !== 1) throw new Error('the demo obligation must have one deposit and one borrow');
  {
    const ch = n(((await c.program.account.assetConfig.fetch(pdas.asset(T))) as any).scopeChain);
    const live = decodeScope((await new web3.Connection(process.env.MAINNET_RPC ?? '', 'confirmed').getAccountInfo(SCOPE_PRICES))!.data, ch).price;
    await writeScope(c, [{ chain: ch, price: live, ts: await chainNow(c) }]);
    simulated.push(`Start: Kamino's Scope ${T} set to its mainnet value now (${live.toFixed(4)}), refreshed at the fork clock.`);
  }
  await fresh(c, [dep[0].toBase58(), USDC_RESERVE]);
  await send(c, await refreshIxs(c, OBLIGATION, ob), []);
  ob = (await loadObligation(c, OBLIGATION))!;
  // Borrow up toward its LTV through klend (the real position sits at about 0.78): a −20% open then needs a repayment.
  const bf = Number(BigInt(ob.borrowFactorAdjustedDebtValueSf.toString())) / 2 ** 60;
  const cv = Number(BigInt(ob.unhealthyBorrowValueSf.toString())) / 2 ** 60;
  // klend lets the debt reach the deposit's LTV, below its LT: at most 98% of that limit.
  const rc = (await loadReserve(c, dep[0])).config;
  const target = Math.min(0.95, 0.98 * rc.loanToValuePct / rc.liquidationThresholdPct);
  const more = Math.floor(target * cv - bf);
  if (more > 1) {
    await borrowMore(c, owner, OBLIGATION, more);
    simulated.push(`The demo wallet borrowed ${more} USDC more on it through klend (real borrow) to bring it near its threshold.`);
    await fresh(c, [dep[0].toBase58(), USDC_RESERVE]);
    ob = (await loadObligation(c, OBLIGATION))!;
    await send(c, await refreshIxs(c, OBLIGATION, ob), []);
    ob = (await loadObligation(c, OBLIGATION))!;
  }
  const debt = borrowedSf(ob, bor[0]) >> 60n;
  const dc0 = Number(BigInt(ob.borrowFactorAdjustedDebtValueSf.toString())) / Number(BigInt(ob.unhealthyBorrowValueSf.toString()));
  const v = await c.program.account.vault.fetch(pdas.vault());
  const policy = pdas.policy(ep.publicKey, OBLIGATION);
  const ix = await c.program.methods.buyCover(ep.account.ticker, group, new BN(debt.toString()), new BN('5000000000'))
    .accountsPartial({ buyer: owner.publicKey, asset: pdas.asset(T), scenarios: pdas.scen(T, CLOSURE.WEEKEND), epoch: ep.publicKey, earnings: pdas.earnings(T),
      loss: pdas.loss(group), vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), feeAccount: v.feeAccount, buyerUsdc: ata(owner.publicKey, USDC_MINT),
      obligation: OBLIGATION, depositReserve: dep[0], borrowReserve: bor[0], policy, tokenProgram: TOKEN })
    .instruction();
  const bought = await send(c, [...(await refreshIxs(c, OBLIGATION, ob)), ix], [owner]);
  const p0 = await c.program.account.policy.fetch(policy);
  log(`${T} weekend ${group}: position ${OBLIGATION.toBase58().slice(0, 8)}… debt ${(Number(debt) / 1e6).toFixed(2)} USDC, D/C′ ${dc0.toFixed(4)}; premium ${(n(p0.premium) / 1e6).toFixed(2)} USDC (${bought.cu} CU incl. refreshes)`);

  // Close at Kamino's Scope price as on mainnet now (a rerun on this fork would otherwise start from an earlier run's
  // open), open −24% (inside the reserve's heuristic band, else at its floor).
  const st = (await c.program.account.assetConfig.fetch(pdas.asset(T))) as any;
  const chain = n(st.scopeChain);
  const mainnet = new web3.Connection(process.env.MAINNET_RPC ?? '', 'confirmed');
  const pClose = decodeScope((await mainnet.getAccountInfo(SCOPE_PRICES))!.data, chain).price;
  const h = (await loadReserve(c, dep[0])).config.tokenInfo.heuristic as unknown as { lower: unknown; exp: unknown };
  const floor = Number(String(h.lower)) / 10 ** Number(String(h.exp));
  const pOpen = Math.max(pClose * (1 + GAP), floor * 1.01);
  await timeTravel(c, n(ep.account.close) + 30);
  await writeScope(c, [{ chain, price: pClose, ts: n(ep.account.close) + 20 }]);
  await tick(c);
  await timeTravel(c, n(ep.account.open) + 75);
  await writeScope(c, [{ chain, price: pOpen, ts: n(ep.account.open) + 70 }]);
  await fresh(c, [USDC_RESERVE]);
  simulated.push(`${T} closes at Kamino's Scope price on the fork (${pClose.toFixed(4)}) and opens at ${pOpen.toFixed(4)} (${(((pOpen / pClose) - 1) * 100).toFixed(1)}%), refresh times moved to the close and the open.`);
  const settle = await tick(c);
  const p1 = await c.program.account.policy.fetch(policy);
  const ob1 = (await loadObligation(c, OBLIGATION))!;
  const debt1 = Number(borrowedSf(ob1, bor[0]) >> 60n) / 1e6;
  log(`${T} opens ${(((pOpen / pClose) - 1) * 100).toFixed(1)}%: payout ${(n(p1.payout) / 1e6).toFixed(2)} USDC into the position; debt ${(Number(debt) / 1e6).toFixed(2)} → ${debt1.toFixed(2)}`);

  const result = {
    ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), quotes,
    tsla: { group, obligation: OBLIGATION.toBase58(), debtUsdc: Number(debt) / 1e6, debtToCovered: dc0, premium: n(p0.premium) / 1e6, cap: n(p0.maxPayout) / 1e6,
      close: pClose, open: pOpen, payout: n(p1.payout) / 1e6, debtAfter: debt1, buyCu: bought.cu },
    keeper: { failed: settle.failed },
    real: ['klend and every Kamino account cloned from mainnet (reserves pinned at one slot); the TSLAx obligation, its deposit and debt are mainnet\'s',
      'credence_core built from this repo: quote_cover on each of the eight assets, buy_cover, snapshot_close, post_settlement, settle_policy (repay v2 CPI)'],
    simulated: ['the clock (surfpool time travel)', 'USDC and SOL of the demo wallet (cheatcodes)', ...simulated],
  };
  mkdirSync(join(ROOT, 'data/demo'), { recursive: true });
  writeFileSync(join(ROOT, 'data/demo/assets-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`@@result ${JSON.stringify(result)}`);
}
main().catch((e) => { console.error(redact(String(e?.stack ?? e))); process.exit(1); });
