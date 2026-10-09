// C2 curator book demo on the surfpool mainnet fork (after scripts/demo.sh has deployed and loaded the program): a
// curator wallet covers a book of 20+ real positions it does not own, across Kamino (xStocks Market) and Jupiter Lend,
// and the keeper runs the weekend.
//
//   1. Positions: real eligible ones from the Oct 9 scan (data/positions), re-read on the fork: Kamino single-xStock
//      SPYx obligations (the nearest to their threshold and the largest) and Jupiter Lend SPYx (vault 78) and TSLAx
//      (vault 77) positions. Nothing about them is changed, except two owners (below).
//   2. The curator opens a book, adds the legs in batches (Kamino: refreshes + up to BOOK_K legs per v0 transaction with
//      a lookup table of the shared accounts; Jupiter: legs per transaction), and seals it: one premium. The sum of the
//      legs' standalone quotes (`quote_cover`, simulated, the program's own pricing) is printed next to it.
//   3. Before the bell: one leg's owner buys its own cover (release_book_leg + buy_cover in one transaction: owner
//      precedence; that owner is a demo wallet written into the obligation by cheatcode, SIMULATED).
//   4. Friday close (genuine prices restamped); keeper: closes. Sunday: a second demo-owned position is repaid in full
//      through klend (real repay; owner by cheatcode) — "closed before the open"; the push accounts show −8% (SIMULATED
//      price on genuine recorded updates); keeper: the shield advances on the near-threshold legs, into the positions.
//   5. Monday: Kamino's Scope and Jupiter's caches −8% from the close (SIMULATED); keeper: settlement prices, every leg
//      settled into its position (the repaid one pays 0 and its share is refunded: a payout was owed), the group
//      released, the curator's refund claimed.
// Result: a before/after table per leg (stdout) and data/demo/book-result.json.
//
//   pnpm -C keeper run book-demo     (BOOK_GAP=-0.08, BOOK_KAMINO=14, BOOK_JL=8, BOOK_K=4)
import { config } from 'dotenv';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import { getRatioAtTick } from '@jup-ag/lend/borrow';
import {
  BOOK, CLOSURE, type Chain, EPOCH, INSTRUCTIONS_SYSVAR, KLEND, ROOT, TOKEN, USDC_MINT, ata, chainNow, connect, createAtaIx, decodePriceUpdate, fmtTime, log,
  pdas, pk, pushAccount, send, tickerStr, ticker8,
} from './chain.js';
import { setAccount, setTokenBalance, timeTravel } from './fork.js';
import { borrowedSf, loadObligation, loadReserve, refreshIxs, repayAccounts } from './kamino.js';
import { tick } from './jobs.js';
import { JL_VAULTS, readJlCache, sendV0 } from './jupiter.js';
import { recordedScope, writeScope } from './weekend.js';

config({ path: join(ROOT, '.env'), quiet: true });
type Pk = InstanceType<typeof web3.PublicKey>;
type Ix = InstanceType<typeof web3.TransactionInstruction>;
const GAP = Number(process.env.BOOK_GAP ?? -0.08);
const N_KAMINO = Number(process.env.BOOK_KAMINO ?? 14);
const N_JL = Number(process.env.BOOK_JL ?? 8);
const K = Number(process.env.BOOK_K ?? 4);
const MIN_DEBT_USD = 5;
const n = (x: { toString(): string } | number) => (typeof x === 'number' ? x : Number(x.toString()));
const simulated: string[] = [];
const XSTOCKS_MARKET = pk('5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua');
const USDC_RESERVE = pk('97zoywd8mPZsGTg8q1wdD2Wgkdrs2tqusp1Qqcxbyj7E');
const JL = [{ ticker: 'SPYx.J', base: 'SPYx', vault: 78 }, { ticker: 'TSLAx.J', base: 'TSLAx', vault: 77 }];

type Leg = {
  lender: 'kamino' | 'jupiter'; ticker: string; position: Pk; policy?: Pk; role: string;
  before?: { debt: number; dc: number }; atOpen?: { debt: number; dc: number }; after?: { debt: number; dc: number };
  standalone?: number; extra?: number;
};

/** klend's view after a refresh: debt (USDC) and D/C′ = borrow-factor-adjusted debt / unhealthy borrow value. */
async function kaminoState(c: Chain, ob: Pk) {
  const o0 = await loadObligation(c, ob);
  if (!o0) return { debt: 0, dc: 0 };
  await freshFor(c, [ob]);
  await send(c, await refreshIxs(c, ob, o0));
  const o = (await loadObligation(c, ob))!;
  const sf = (x: { toString(): string }) => Number(BigInt(x.toString()) >> 40n) / 2 ** 20;
  const debt = Number(borrowedSf(o, USDC_RESERVE) >> 60n) / 1e6;
  const ubv = sf(o.unhealthyBorrowValueSf);
  return { debt, dc: ubv > 0 ? sf(o.borrowFactorAdjustedDebtValueSf) / ubv : 0 };
}

/** Jupiter's view of a position: debt (USDC) from the tick and D/C′ at the cache price (as jl-demo). */
async function jlState(c: Chain, position: Pk, vaultId: number, cache: Pk, lt: number) {
  const p = (await c.conn.getAccountInfo(position))!.data;
  const [vs] = web3.PublicKey.findProgramAddressSync([Buffer.from('vault_state'), Buffer.from([vaultId & 255, vaultId >> 8])], JL_VAULTS);
  const v = (await c.conn.getAccountInfo(vs))!.data;
  const [supEx, borEx] = [v.readBigUInt64LE(99), v.readBigUInt64LE(107)];
  const colRaw = p.readBigUInt64LE(55);
  const tk = p.readInt32LE(47);
  const col = Number((colRaw * supEx) / 10n ** 12n) / 1e9;
  const debtRaw = tk > -16383 && p[46] === 0 ? ((BigInt(getRatioAtTick(tk).toString()) * (colRaw + 1n)) >> 48n) + 1n : 0n;
  const debt = Number((debtRaw * borEx) / 10n ** 12n) / 1e9;
  const px = (await readJlCache(c, cache))!.price;
  return { debt, dc: col > 0 ? debt / (col * px * lt / 1000) : 0, tick: tk, vaultState: vs };
}

/** Every Scope (price, TWAP) chain the obligations' reserves read, refresh time moved to the fork clock (fork only). */
async function freshFor(c: Chain, obligations: Pk[]) {
  const reserves = new Set<string>();
  for (const k of obligations) {
    const o = await loadObligation(c, k);
    if (!o) continue;
    for (const d of [...o.deposits, ...o.borrows] as any[]) {
      const r = d.depositReserve ?? d.borrowReserve;
      if (r && r !== '11111111111111111111111111111111') reserves.add(r);
    }
  }
  const { restampScope } = await import('./weekend.js');
  const pairs = [];
  for (const r of reserves) {
    const s = (await loadReserve(c, pk(r))).config.tokenInfo.scopeConfiguration;
    pairs.push({ price: s.priceChain[0], twap: s.twapChain[0] !== 65535 ? s.twapChain[0] : null });
  }
  if (pairs.length) await restampScope(c, pairs);
}

/** Jupiter's Chainlink cache: price (WAD) and refresh time written (fork only), as jl-demo. */
async function writeCache(c: Chain, key: Pk, priceWad: bigint, ts: number) {
  const a = (await c.conn.getAccountInfo(key))!;
  const d = Buffer.from(a.data);
  const o = 14 + 34 * d.readUInt32LE(10);
  d.writeBigUInt64LE(priceWad & ((1n << 64n) - 1n), o);
  d.writeBigUInt64LE(priceWad >> 64n, o + 8);
  d.writeBigUInt64LE(BigInt(ts), o + 16);
  d.writeBigUInt64LE(BigInt(ts), o + 24);
  d.writeBigUInt64LE(BigInt(ts) * 1000n, o + 32);
  await setAccount(c, key.toBase58(), { lamports: a.lamports, data: d, owner: a.owner.toBase58() });
}

/** The newest recorded genuine push update of `sym` (else the push account as cloned on the fork: the recorder covers
 * three assets), its price set to `price` and publish time to `t` (fork only). */
async function pushAt(c: Chain, sym: string, feed: number[], price: number, t: number) {
  const dir = join(ROOT, 'data/live/pyth');
  const f = readdirSync(dir).filter((x) => x.startsWith(`${sym}-`)).sort().pop();
  let d: Buffer, lamports: number, owner: string, file: string;
  if (f) {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    [d, lamports, owner, file] = [Buffer.from(j.account.data[0], 'base64'), j.account.lamports, j.account.owner, f];
  } else {
    const a = await c.conn.getAccountInfo(pushAccount(feed));
    if (!a) throw new Error(`no ${sym} push update recorded or on the fork`);
    [d, lamports, owner, file] = [Buffer.from(a.data), a.lamports, a.owner.toBase58(), 'the fork\'s clone of the mainnet push account'];
  }
  const u = decodePriceUpdate(d);
  const ratio = price / u.price;
  for (const [o, signed] of [[u.offsets.price, true], [u.offsets.conf, false], [u.offsets.emaPrice, true], [u.offsets.emaConf, false]] as const) {
    const v = signed ? d.readBigInt64LE(o) : d.readBigUInt64LE(o);
    const x = BigInt(Math.round(Number(v) * ratio));
    if (signed) d.writeBigInt64LE(x, o); else d.writeBigUInt64LE(x, o);
  }
  d.writeBigInt64LE(BigInt(t), u.offsets.publishTime);
  d.writeBigInt64LE(BigInt(t - 1), u.offsets.prevPublishTime);
  return { data: d, lamports, owner, file };
}

/** The read-only recorder's latest reading of Jupiter's oracle for `asset` (operate price ×1e15 → WAD), as jl-demo. */
function latestJlRecorded(asset: string): bigint | null {
  try {
    const lines = readFileSync(join(ROOT, 'data/jupiter/oracle-weekend.jsonl'), 'utf8').trim().split('\n').reverse();
    for (const l of lines) {
      const j = JSON.parse(l);
      if (j.asset === asset && j.operate) return BigInt(j.operate) * 1000n;
    }
  } catch { /* no recorder output (a fresh clone): the fork's cache */ }
  return null;
}

/** A lookup table holding `keys` (created and extended by the keeper, active from the next slot). */
async function lookupTable(c: Chain, keys: Pk[]) {
  const slot = await c.conn.getSlot('processed');
  const [create, table] = web3.AddressLookupTableProgram.createLookupTable({ authority: c.payer.publicKey, payer: c.payer.publicKey, recentSlot: Math.max(0, slot - 1) });
  await send(c, [create]);
  for (let i = 0; i < keys.length; i += 20) {
    await send(c, [web3.AddressLookupTableProgram.extendLookupTable({ lookupTable: table, authority: c.payer.publicKey, payer: c.payer.publicKey, addresses: keys.slice(i, i + 20) })]);
  }
  for (let t = 0; t < 40; t++) {
    const a = (await c.conn.getAddressLookupTable(table)).value;
    if (a && a.state.addresses.length === keys.length && (await c.conn.getSlot()) > slot + 1) return a;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('lookup table did not activate');
}

/** klend `repay_obligation_liquidity_v2` signed by the owner from its USDC account (everything it owes: u64::MAX). */
async function ownerRepayIx(c: Chain, owner: Pk, ob: Pk) {
  const k = await repayAccounts(c, ob, XSTOCKS_MARKET, USDC_RESERVE);
  const { createHash } = await import('node:crypto');
  const disc = createHash('sha256').update('global:repay_obligation_liquidity_v2').digest().subarray(0, 8);
  const data = Buffer.concat([disc, Buffer.from(new BN('18446744073709551615').toArray('le', 8))]);
  const m = (pubkey: Pk, w = false, s = false) => ({ pubkey, isSigner: s, isWritable: w });
  const farmW = !k.obligationFarmUserState.equals(KLEND);
  return new web3.TransactionInstruction({
    programId: KLEND, data,
    keys: [m(owner, false, true), m(ob, true), m(XSTOCKS_MARKET), m(USDC_RESERVE, true), m(USDC_MINT), m(k.reserveDestinationLiquidity, true), m(ata(owner, USDC_MINT), true),
      m(TOKEN), m(INSTRUCTIONS_SYSVAR), m(k.obligationFarmUserState, farmW), m(k.reserveFarmState, farmW), m(k.lendingMarketAuthority), m(k.farmsProgram)],
  });
}

/** Gives `ob` a fresh demo owner by cheatcode (owner field at offset 64); returns the keypair. */
async function takeOver(c: Chain, ob: Pk, why: string) {
  const owner = web3.Keypair.generate();
  await c.conn.confirmTransaction(await c.conn.requestAirdrop(owner.publicKey, 10e9), 'confirmed');
  await setTokenBalance(c, owner.publicKey.toBase58(), USDC_MINT.toBase58(), 100_000_000_000n);
  const acc = (await c.conn.getAccountInfo(ob))!;
  const real = new web3.PublicKey(acc.data.subarray(64, 96)).toBase58();
  const data = Buffer.from(acc.data);
  owner.publicKey.toBuffer().copy(data, 64);
  await setAccount(c, ob.toBase58(), { lamports: acc.lamports, data, owner: acc.owner.toBase58() });
  simulated.push(`${why}: the real obligation ${ob.toBase58()} (owner ${real} on mainnet) had its owner field set to the demo wallet ${owner.publicKey.toBase58()} by cheatcode; deposits and debt are mainnet's.`);
  return owner;
}

/** C1's extra credit at D/C′ 0.90 per position (data/unlock), to annualise the book's cost per $ of extra credit. */
function unlockExtra(): Map<string, number> {
  const dir = join(ROOT, 'data/unlock');
  const f = readdirSync(dir).filter((x) => /^unlock-\d+\.json$/.test(x)).sort().pop();
  const m = new Map<string, number>();
  if (!f) return m;
  for (const p of JSON.parse(readFileSync(join(dir, f), 'utf8')).positions ?? []) {
    const t = p.targets?.['0.9'];
    if (t?.extra) m.set(p.id, Number(t.extra) / 1e6);
  }
  return m;
}

async function main() {
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const t0 = Date.now();
  log(`curator book demo on ${c.url} — chain time ${fmtTime(await chainNow(c))}`);

  // LP if small; epochs.
  const v0 = await c.program.account.vault.fetch(pdas.vault());
  if (BigInt(v0.equity.toString()) < 1_500_000_000_000n) {
    const lp = web3.Keypair.generate();
    await c.conn.confirmTransaction(await c.conn.requestAirdrop(lp.publicKey, 10e9), 'confirmed');
    await setTokenBalance(c, lp.publicKey.toBase58(), USDC_MINT.toBase58(), 2_000_000_000_000n);
    await send(c, [createAtaIx(c.payer.publicKey, lp.publicKey, pdas.shares()),
      await c.program.methods.deposit(new BN('2000000000000')).accountsPartial({ depositor: lp.publicKey, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(),
        depositorUsdc: ata(lp.publicKey, USDC_MINT), depositorShares: ata(lp.publicKey, pdas.shares()), shareEscrow: pdas.shareEscrow() }).instruction()], [lp]);
    simulated.push('An LP wallet deposited 2,000,000 USDC (cheatcode USDC).');
  }
  await tick(c);
  // Between a weekend's bell and the next Monday no sale is open: move the fork's clock into the next weekend's sale
  // window (SIMULATED time; e.g. a rerun on a fork an earlier demo left on a Sunday).
  {
    const t0 = await chainNow(c);
    const all = (await c.program.account.epoch.all()) as { publicKey: Pk; account: any }[];
    const spyW = all.filter((e) => tickerStr(e.account.ticker) === 'SPYx' && e.account.closureType === CLOSURE.WEEKEND && e.account.state === EPOCH.OPEN && n(e.account.bell) > t0)
      .sort((a, b) => a.account.closureId - b.account.closureId)[0];
    if (spyW && n(spyW.account.saleOpen) > t0) {
      await timeTravel(c, n(spyW.account.saleOpen) + 3600);
      simulated.push(`The fork's clock moved from ${fmtTime(t0)} to ${fmtTime(n(spyW.account.saleOpen) + 3600)}, into weekend ${spyW.account.closureId}'s sale window.`);
      await tick(c);
    }
  }
  const now0 = await chainNow(c);
  const epochs = (await c.program.account.epoch.all()) as { publicKey: Pk; account: any }[];
  const onSale = (t: string) => epochs.filter((e) => e.account.closureType === CLOSURE.WEEKEND && tickerStr(e.account.ticker) === t && e.account.state === EPOCH.OPEN
    && n(e.account.bell) > now0 && n(e.account.saleOpen) <= now0);
  const group = Math.min(...onSale('SPYx').map((e) => e.account.closureId as number).filter((g) => onSale('SPYx.J').some((e) => e.account.closureId === g)));
  if (!Number.isFinite(group)) throw new Error('no weekend with SPYx and SPYx.J on sale now');
  const ep = (t: string) => epochs.find((e) => tickerStr(e.account.ticker) === t && e.account.closureId === group);
  const [close, open, bell] = [n(ep('SPYx')!.account.close), n(ep('SPYx')!.account.open), n(ep('SPYx')!.account.bell)];
  log(`weekend ${group}: bell ${fmtTime(bell)}, close ${fmtTime(close)}, open ${fmtTime(open)}`);

  // Genuine prices to start from (an earlier demo on this fork may have left a simulated open): Kamino's Scope SPYx and
  // the Jupiter caches at their latest recorded / current genuine values, refreshed now.
  const spy = (await c.program.account.assetConfig.fetch(pdas.asset('SPYx'))) as any;
  const spyChain = n(spy.scopeChain);
  const realSpy = recordedScope('SPYx', 0, Number.MAX_SAFE_INTEGER);
  if (realSpy) {
    await writeScope(c, [{ chain: spyChain, price: realSpy.price, ts: now0 }]);
    simulated.push(`Start: Kamino's Scope SPYx at the latest genuine reading the live recorder captured (${realSpy.price.toFixed(4)}), refreshed now.`);
  }
  const jlAssets: Record<string, { cache: Pk; vaultConfig: Pk; lt: number; feed: number[]; px0: bigint }> = {};
  for (const j of JL) {
    const a = (await c.program.account.assetConfig.fetch(pdas.asset(j.ticker)).catch(() => null)) as any;
    if (!a || a.earnings !== 0 || !ep(j.ticker)) { log(`  skip ${j.ticker}: not loaded, earnings bump, or no epoch`); continue; }
    // Start from a genuine price: the read-only recorder's latest reading of Jupiter's oracle (data/jupiter), else the
    // fork's cache (an earlier demo on this fork leaves it at its simulated open).
    const fork = (await readJlCache(c, a.lenderOracle))!;
    const rec = latestJlRecorded(j.base);
    const q = rec ? { priceWad: rec } : fork;
    if (rec) simulated.push(`Start: Jupiter's ${j.base} cache at the recorder's latest genuine reading, refreshed now.`);
    await writeCache(c, a.lenderOracle, q.priceWad, now0);
    jlAssets[j.ticker] = { cache: a.lenderOracle, vaultConfig: a.lenderVault, lt: (await c.conn.getAccountInfo(a.lenderVault))!.data.readUInt16LE(16), feed: a.feedXstock, px0: q.priceWad };
  }
  simulated.push(`Jupiter's ${Object.keys(jlAssets).join(', ')} Chainlink caches keep their price; their refresh time is moved to the fork clock at each step.`);

  // 1. Candidates from the scan, re-read on the fork.
  const scan = JSON.parse(readFileSync(join(ROOT, 'data/positions/positions-20261009.json'), 'utf8'));
  const kam = (scan.positions as any[]).filter((p) => p.eligible && p.market === 'xStocks' && p.deposits.length === 1 && p.deposits[0].symbol === 'SPYx' && p.debtUsd >= MIN_DEBT_USD);
  const near = [...kam].sort((a, b) => b.debtToCovered - a.debtToCovered);
  const big = [...kam].sort((a, b) => b.debtUsd - a.debtUsd);
  const kamPick = [...new Map([...near.slice(0, Math.ceil(N_KAMINO * 0.6) + 4), ...big.slice(0, N_KAMINO)].map((p) => [p.obligation, p])).values()];
  const jlScan = (scan.jupiterLend.positions as any[]).filter((p) => p.eligibleB2 && p.debtUsd >= MIN_DEBT_USD && JL.some((j) => j.base === p.asset && jlAssets[j.ticker]));
  const jlPick = [...new Map([...[...jlScan].sort((a, b) => b.debtToCovered - a.debtToCovered).slice(0, Math.ceil(N_JL / 2) + 2),
    ...[...jlScan].sort((a, b) => b.debtUsd - a.debtUsd).slice(0, N_JL)].map((p) => [p.position, p])).values()];

  // 2. The curator, its book and a lookup table of the shared accounts.
  const curator = web3.Keypair.generate();
  await c.conn.confirmTransaction(await c.conn.requestAirdrop(curator.publicKey, 20e9), 'confirmed');
  await setTokenBalance(c, curator.publicKey.toBase58(), USDC_MINT.toBase58(), 100_000_000_000n);
  simulated.push(`The curator wallet ${curator.publicKey.toBase58()} was given 100,000 USDC and SOL by cheatcode.`);
  const curatorUsdc = ata(curator.publicKey, USDC_MINT);
  const book = pdas.book(curator.publicKey, group, 1);
  await send(c, [await c.program.methods.openBook(group, 1).accountsPartial({ payer: curator.publicKey, epoch: ep('SPYx')!.publicKey, book, escrow: pdas.bookEscrow(book),
    usdcMint: USDC_MINT, payerUsdc: curatorUsdc, tokenProgram: TOKEN }).instruction()], [curator]);
  const usdcRes = await loadReserve(c, USDC_RESERVE);
  const spyRes = (spy.kaminoReserves as Pk[])[0];
  const shared = [pdas.config(), pdas.vault(), pdas.vaultUsdc(), pdas.shares(), pdas.loss(group), book, pdas.bookEscrow(book), curatorUsdc, TOKEN, web3.SystemProgram.programId,
    pdas.asset('SPYx'), pdas.scen('SPYx'), ep('SPYx')!.publicKey, spyRes, USDC_RESERVE, XSTOCKS_MARKET, KLEND, pk(usdcRes.config.tokenInfo.scopeConfiguration.priceFeed),
    ...Object.entries(jlAssets).flatMap(([t, a]) => [pdas.asset(t), pdas.scen(t), ep(t)!.publicKey, a.vaultConfig, a.cache]), PROGRAM_ID_KEY()];
  const alt = await lookupTable(c, [...new Map(shared.map((k) => [k.toBase58(), k])).values()]);
  log(`book ${book.toBase58()} opened by curator ${curator.publicKey.toBase58().slice(0, 8)}…; lookup table ${alt.key.toBase58().slice(0, 8)}… (${alt.state.addresses.length} shared accounts)`);

  const legs: Leg[] = [];
  const cus: { kamino: number[]; jupiter: number[] } = { kamino: [], jupiter: [] };
  const addKamino = async (obs: Pk[]) => {
    const ixs: Ix[] = [];
    await freshFor(c, obs);
    const o0 = (await loadObligation(c, obs[0]))!;
    const refresh = await refreshIxs(c, obs[0], o0);
    ixs.push(...refresh.slice(0, -1)); // the reserves once
    for (const ob of obs) {
      const o = (await loadObligation(c, ob))!;
      ixs.push((await refreshIxs(c, ob, o)).slice(-1)[0]);
    }
    for (const ob of obs) {
      ixs.push(await c.program.methods.addBookLeg(ticker8('SPYx'), group).accountsPartial({ payer: curator.publicKey, asset: pdas.asset('SPYx'), scenarios: pdas.scen('SPYx'),
        epoch: ep('SPYx')!.publicKey, loss: pdas.loss(group), vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), book, escrow: pdas.bookEscrow(book), payerUsdc: curatorUsdc,
        obligation: ob, depositReserve: spyRes, borrowReserve: USDC_RESERVE, policy: pdas.policy(ep('SPYx')!.publicKey, ob), tokenProgram: TOKEN }).instruction());
    }
    return sendV0(c, ixs, [alt], [curator]);
  };
  // Kamino legs in batches of K; a batch that fails is retried leg by leg (a position may have changed since the scan).
  const kamOk: Pk[] = [];
  for (let i = 0; i < kamPick.length && kamOk.length < N_KAMINO; i += K) {
    const batch = kamPick.slice(i, i + K).map((p) => pk(p.obligation)).slice(0, N_KAMINO - kamOk.length);
    try {
      const r = await addKamino(batch);
      cus.kamino.push(r.cu / batch.length);
      log(`  ok   add_book_leg ×${batch.length} (Kamino SPYx, one v0 transaction): ${r.cu} CU`);
      kamOk.push(...batch);
    } catch {
      for (const ob of batch) {
        try { const r = await addKamino([ob]); cus.kamino.push(r.cu); kamOk.push(ob); log(`  ok   add_book_leg ${ob.toBase58().slice(0, 8)}: ${r.cu} CU`); }
        catch (e) { log(`  skip ${ob.toBase58().slice(0, 8)}: ${(e as Error).message.split('\n')[0]}`); }
      }
    }
  }
  for (const ob of kamOk) legs.push({ lender: 'kamino', ticker: 'SPYx', position: ob, policy: pdas.policy(ep('SPYx')!.publicKey, ob), role: 'leg' });
  // Jupiter legs, each one instruction; up to 3 per transaction.
  const jlIx = async (p: any) => {
    const j = JL.find((x) => x.base === p.asset)!;
    const a = jlAssets[j.ticker];
    const position = pk(p.position);
    const s = await jlState(c, position, j.vault, a.cache, a.lt);
    const [tickAcc] = web3.PublicKey.findProgramAddressSync([Buffer.from('tick'), Buffer.from([j.vault & 255, j.vault >> 8]),
      (() => { const b = Buffer.alloc(4); b.writeUInt32LE(s.tick + 16383); return b; })()], JL_VAULTS);
    const ix = await c.program.methods.addBookLegJl(ticker8(j.ticker), group).accountsPartial({ payer: curator.publicKey, asset: pdas.asset(j.ticker), scenarios: pdas.scen(j.ticker),
      epoch: ep(j.ticker)!.publicKey, loss: pdas.loss(group), vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), book, escrow: pdas.bookEscrow(book), payerUsdc: curatorUsdc,
      position, vaultConfig: a.vaultConfig, vaultState: s.vaultState, positionTick: tickAcc, cache: a.cache, policy: pdas.policy(ep(j.ticker)!.publicKey, position), tokenProgram: TOKEN })
      .instruction();
    return { ix, leg: { lender: 'jupiter' as const, ticker: j.ticker, position, policy: pdas.policy(ep(j.ticker)!.publicKey, position), role: 'leg' } };
  };
  const now1 = await chainNow(c);
  for (const a of Object.values(jlAssets)) await writeCache(c, a.cache, a.px0, now1);
  const jlOk: Leg[] = [];
  for (let i = 0; i < jlPick.length && jlOk.length < N_JL; i += 3) {
    const built = [];
    for (const p of jlPick.slice(i, i + 3)) built.push(await jlIx(p));
    try {
      const r = await sendV0(c, built.map((b) => b.ix), [alt], [curator]);
      cus.jupiter.push(r.cu / built.length);
      log(`  ok   add_book_leg_jl ×${built.length}: ${r.cu} CU`);
      jlOk.push(...built.map((b) => b.leg));
    } catch {
      for (const b of built) {
        try { const r = await sendV0(c, [b.ix], [alt], [curator]); cus.jupiter.push(r.cu); jlOk.push(b.leg); log(`  ok   add_book_leg_jl ${b.leg.position.toBase58().slice(0, 8)}: ${r.cu} CU`); }
        catch (e) { log(`  skip ${b.leg.position.toBase58().slice(0, 8)}: ${(e as Error).message.split('\n')[0]}`); }
      }
    }
  }
  legs.push(...jlOk.slice(0, N_JL));
  if (legs.length < 20) throw new Error(`only ${legs.length} legs added (want 20+)`);

  // Each leg's state when added, and its standalone quote (the program's quote_cover, simulated: the premium an owner
  // would pay alone at the vault's utilisation now, loading included).
  const extra = unlockExtra();
  for (const l of legs) {
    const p = (await c.program.account.policy.fetch(l.policy!)) as any;
    l.before = { debt: n(p.debt) / 1e6, dc: n(p.debt) / n(p.coveredValue) };
    l.extra = extra.get(l.position.toBase58());
    const t = l.ticker;
    // Simulated with a 1.4M compute limit (a near-threshold quote needs more than the default 200k); the premium is
    // the first u64 of the return data (`Quote`).
    const qix = await c.program.methods.quoteCover(p.coveredValue, p.debt, p.maxPayout)
      .accountsPartial({ asset: pdas.asset(t), scenarios: pdas.scen(t), vault: pdas.vault(), loss: pdas.loss(group), shareMint: pdas.shares(),
        epoch: ep(t)!.publicKey, earnings: pdas.earnings(t) }).instruction();
    const { blockhash } = await c.conn.getLatestBlockhash();
    const msg = new web3.TransactionMessage({ payerKey: c.payer.publicKey, recentBlockhash: blockhash,
      instructions: [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), qix] }).compileToV0Message();
    const sim = await c.conn.simulateTransaction(new web3.VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
    const rd = sim.value.returnData?.data?.[0];
    if (sim.value.err || !rd) throw new Error(`quote_cover for ${l.position.toBase58()}: ${JSON.stringify(sim.value.err)}`);
    l.standalone = Number(Buffer.from(rd, 'base64').readBigUInt64LE(0)) / 1e6;
  }
  const bk0 = (await c.program.account.book.fetch(book)) as any;
  await send(c, [await c.program.methods.sealBook(new BN('100000000000')).accountsPartial({ payer: curator.publicKey, book, escrow: pdas.bookEscrow(book), payerUsdc: curatorUsdc,
    loss: pdas.loss(group), vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), feeAccount: (await c.program.account.vault.fetch(pdas.vault())).feeAccount, tokenProgram: TOKEN })
    .instruction()], [curator]);
  const bk1 = (await c.program.account.book.fetch(book)) as any;
  const premium = n(bk1.premium) / 1e6;
  const sumStandalone = legs.reduce((a, l) => a + (l.standalone ?? 0), 0);
  const sumExtra = legs.reduce((a, l) => a + (l.extra ?? 0), 0);
  log(`sealed: ${bk1.legsLive} legs (${kamOk.length} Kamino, ${jlOk.length} Jupiter), premium ${premium.toFixed(2)} USDC vs Σ standalone ${sumStandalone.toFixed(2)} (saving ${((1 - premium / sumStandalone) * 100).toFixed(1)}%); escrow held ${(n(bk0.escrowed) / 1e6).toFixed(2)}`);

  // 3. Owner precedence: a Kamino leg's owner (demo wallet by cheatcode) buys its own cover: release + buy_cover.
  const supersede = legs.find((l) => l.lender === 'kamino' && l.before!.dc < 0.9) ?? legs.find((l) => l.lender === 'kamino')!;
  supersede.role = 'owner bought its own cover (superseded)';
  const owner1 = await takeOver(c, supersede.position, 'Owner precedence');
  await freshFor(c, [supersede.position]);
  const o1 = (await loadObligation(c, supersede.position))!;
  const debt1 = (borrowedSf(o1, USDC_RESERVE) >> 60n) + 1n;
  const p1 = (await c.program.account.policy.fetch(supersede.policy!)) as any;
  const rel = await c.program.methods.releaseBookLeg().accountsPartial({ owner: owner1.publicKey, epoch: ep('SPYx')!.publicKey, policy: supersede.policy!, loss: pdas.loss(group),
    book, asset: pdas.asset('SPYx'), position: supersede.position, positionTokenAccount: null, rentPayer: p1.rentPayer }).instruction();
  const buy = await c.program.methods.buyCover(ticker8('SPYx'), group, new BN(debt1.toString()), new BN('100000000000')).accountsPartial({ buyer: owner1.publicKey,
    asset: pdas.asset('SPYx'), scenarios: pdas.scen('SPYx'), epoch: ep('SPYx')!.publicKey, earnings: pdas.earnings('SPYx'), loss: pdas.loss(group), vaultUsdc: pdas.vaultUsdc(),
    shareMint: pdas.shares(), feeAccount: (await c.program.account.vault.fetch(pdas.vault())).feeAccount, buyerUsdc: ata(owner1.publicKey, USDC_MINT),
    obligation: supersede.position, depositReserve: spyRes, borrowReserve: USDC_RESERVE, policy: supersede.policy!, tokenProgram: TOKEN }).instruction();
  const sup = await send(c, [...(await refreshIxs(c, supersede.position, o1)), rel, buy], [owner1]);
  const bk2 = (await c.program.account.book.fetch(book)) as any;
  const pOwner = (await c.program.account.policy.fetch(supersede.policy!)) as any;
  log(`owner precedence: ${owner1.publicKey.toBase58().slice(0, 8)}… released ${supersede.position.toBase58().slice(0, 8)} from the book and bought its own cover in one transaction (${sup.cu} CU): premium ${(n(pOwner.premium) / 1e6).toFixed(2)} USDC; the curator is owed ${(n(bk2.refundOwed) / 1e6).toFixed(6)} USDC`);

  // The position closed before the open: the nearest-to-threshold Kamino leg left, repaid in full by its owner Sunday.
  const closed = legs.filter((l) => l.lender === 'kamino' && l !== supersede).sort((a, b) => b.before!.dc - a.before!.dc)[0];
  closed.role = 'repaid in full before the open (refund)';
  const owner2 = await takeOver(c, closed.position, 'Closed before the open');

  // 4. Friday close: genuine prices restamped to the close; the caches at their price, refreshed at the close.
  await timeTravel(c, close + 30);
  const closePx = recordedScope('SPYx', close - 60, close + 900) ?? realSpy;
  if (closePx) await writeScope(c, [{ chain: spyChain, price: closePx.price, ts: close + 20 }]);
  for (const a of Object.values(jlAssets)) await writeCache(c, a.cache, a.px0, close + 20);
  simulated.push(`Friday close: Kamino's Scope SPYx ${closePx ? closePx.price.toFixed(4) : '(as on the fork)'} and Jupiter's caches at their genuine price, refresh time moved to the close.`);
  await tick(c);

  // Sunday 20:30 ET: the repaid position; fair values GAP below the close; the keeper shields.
  const sunday = open - 13 * 3600;
  await timeTravel(c, sunday);
  await freshFor(c, [closed.position]);
  const o2 = (await loadObligation(c, closed.position))!;
  const rep = await send(c, [...(await refreshIxs(c, closed.position, o2)), await ownerRepayIx(c, owner2.publicKey, closed.position)], [owner2]);
  log(`Sunday: ${closed.position.toBase58().slice(0, 8)} repaid in full by its owner through klend (${rep.cu} CU)`);
  // The xStocks the book holds legs on (a Jupiter alias shares its xStock's push account).
  for (const t of [...new Set(legs.map((l) => l.ticker.replace('.J', '')))]) {
    const a = (await c.program.account.assetConfig.fetch(pdas.asset(t))) as any;
    const e = await c.program.account.epoch.fetch((ep(t) ?? ep(`${t}.J`))!.publicKey);
    const cw = Number(BigInt(e.closePriceWad.toString()) / 10n ** 10n) / 1e8;
    const push = await pushAt(c, t, a.feedXstock, cw * (1 + GAP), sunday - 120);
    await setAccount(c, pushAccount(a.feedXstock).toBase58(), { lamports: push.lamports, data: push.data, owner: push.owner });
    simulated.push(`Sunday ${fmtTime(sunday)}: the ${t} push account holds the genuine recorded update ${push.file} with its price ${(GAP * 100).toFixed(1)}% from the close.`);
  }
  await freshFor(c, legs.filter((l) => l.lender === 'kamino').map((l) => l.position));
  for (const a of Object.values(jlAssets)) await writeCache(c, a.cache, a.px0, sunday);
  const rShield = await tick(c);

  // 5. Monday open: Scope and the caches GAP below the close; positions read at the open, then the keeper settles.
  await timeTravel(c, open + 75);
  if (closePx) await writeScope(c, [{ chain: spyChain, price: closePx.price * (1 + GAP), ts: open + 70 }]);
  for (const a of Object.values(jlAssets)) await writeCache(c, a.cache, (a.px0 * BigInt(Math.round((1 + GAP) * 1e6))) / 1_000_000n, open + 70);
  simulated.push(`Monday ${fmtTime(open + 70)}: Kamino's Scope SPYx and Jupiter's caches ${(GAP * 100).toFixed(1)}% from the close.`);
  for (const l of legs) {
    l.atOpen = l.lender === 'kamino' ? await kaminoState(c, l.position)
      : await (async () => { const j = JL.find((x) => x.ticker === l.ticker)!; const a = jlAssets[l.ticker]; const s = await jlState(c, l.position, j.vault, a.cache, a.lt); return { debt: s.debt, dc: s.dc }; })();
  }
  await freshFor(c, legs.filter((l) => l.lender === 'kamino').map((l) => l.position));
  const rSettle = await tick(c);
  await freshFor(c, legs.filter((l) => l.lender === 'kamino').map((l) => l.position));
  const rSettle2 = await tick(c); // refunds claimed after the settlements (and anything left)

  // The table.
  const bkEnd = (await c.program.account.book.fetch(book)) as any;
  // Refunds from the program's own totals: the superseded leg's share was owed right after the release; the rest is the
  // repaid position's (the only other leg that can be unpaid with a payout owed here).
  const superRefund = n(bk2.refundOwed) / 1e6;
  const closedRefund = +((n(bkEnd.refunded) + n(bkEnd.refundOwed)) / 1e6 - superRefund).toFixed(6);
  const rows = [];
  for (const l of legs) {
    l.after = l.lender === 'kamino' ? await kaminoState(c, l.position)
      : await (async () => { const j = JL.find((x) => x.ticker === l.ticker)!; const a = jlAssets[l.ticker]; const s = await jlState(c, l.position, j.vault, a.cache, a.lt); return { debt: s.debt, dc: s.dc }; })();
    const p = (await c.program.account.policy.fetch(l.policy!).catch(() => null)) as any;
    const isLeg = p && p.book.toBase58() === book.toBase58();
    const refund = l === supersede ? superRefund : l === closed ? closedRefund : 0;
    rows.push({
      lender: l.lender, asset: l.ticker, position: l.position.toBase58(), role: l.role,
      debtUsdc: +l.before!.debt.toFixed(2), dcBefore: +l.before!.dc.toFixed(4), dcAtOpen: +(l.atOpen?.dc ?? 0).toFixed(4), dcAfter: +(l.after?.dc ?? 0).toFixed(4),
      advancedUsdc: p ? n(p.advanced) / 1e6 : 0, payoutUsdc: p ? n(p.payout) / 1e6 : 0, refundUsdc: refund,
      state: !p ? 'closed' : p.state === 1 ? 'SETTLED' : p.state === 2 ? 'REFUNDED' : 'ACTIVE', owner: isLeg ? 'book' : 'owner policy',
      standaloneQuoteUsdc: +(l.standalone ?? 0).toFixed(6), extraCreditUsd: l.extra ?? null,
    });
  }
  const l = await c.program.account.lossVector.fetch(pdas.loss(group));
  const result = {
    ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), group, gap: GAP, book: book.toBase58(), curator: curator.publicKey.toBase58(),
    chainTime: { bell: fmtTime(bell), close: fmtTime(close), shield: fmtTime(sunday), open: fmtTime(open) },
    legs: { total: legs.length, kamino: kamOk.length, jupiter: jlOk.length },
    pricing: {
      premiumUsdc: premium, feeUsdc: n(bk1.fee) / 1e6, utilisation: n(bk1.utilWad) / 1e18, shieldLoadingUsdc: n(bk1.sumLoading) / 1e6, expectedLossUsdc: n(bk1.sumE) / 1e6,
      sumStandaloneUsdc: +sumStandalone.toFixed(6), savingPct: +((1 - premium / sumStandalone) * 100).toFixed(2),
      extraCreditUsd: +sumExtra.toFixed(2), legsWithC1Extra: legs.filter((x) => x.extra).length,
      annualisedCostPerExtraCredit: sumExtra > 0 ? +((premium * 52) / sumExtra * 100).toFixed(2) : null,
      annualisedStandaloneCostPerExtraCredit: sumExtra > 0 ? +((sumStandalone * 52) / sumExtra * 100).toFixed(2) : null,
    },
    cuPerLeg: {
      kamino: cus.kamino.length ? Math.round(cus.kamino.reduce((a, b) => a + b, 0) / cus.kamino.length) : null,
      jupiter: cus.jupiter.length ? Math.round(cus.jupiter.reduce((a, b) => a + b, 0) / cus.jupiter.length) : null,
    },
    bookState: { state: bkEnd.state, legsDone: bkEnd.legsDone, legsAdded: bkEnd.legsAdded, advancedUsdc: n(bkEnd.advanced) / 1e6, paidOutUsdc: n(bkEnd.paidOut) / 1e6,
      refundedUsdc: n(bkEnd.refunded) / 1e6, refundOwedUsdc: n(bkEnd.refundOwed) / 1e6 },
    groupReleased: l.settled === 1,
    rows,
    keeper: { shield: { sent: rShield.sent, failed: rShield.failed }, settle: { sent: [...rSettle.sent, ...rSettle2.sent], failed: [...rSettle.failed, ...rSettle2.failed] } },
    real: [
      'klend, Jupiter Lend and every Kamino / Jupiter account cloned from mainnet; every leg is a real position (Oct 9 scan), its deposits and debt are mainnet\'s',
      'the owner\'s buy_cover and the full repayment are real klend transactions signed by the demo owners',
      'credence_core built from this repo: open_book, add_book_leg ×k per v0 transaction (lookup table), add_book_leg_jl, seal_book, release_book_leg + buy_cover, shield_book_leg / _jl, settle_book_leg / _jl, claim_book_refund',
    ],
    simulated: ['the clock (surfpool time travel)', 'USDC and SOL of the demo wallets (cheatcodes)', ...simulated],
  };
  mkdirSync(join(ROOT, 'data/demo'), { recursive: true });
  writeFileSync(join(ROOT, 'data/demo/book-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`\n================ curator book demo, weekend ${group}, gap ${(GAP * 100).toFixed(1)}% ================`);
  console.log(`book ${book.toBase58()}: ${legs.length} legs (${kamOk.length} Kamino, ${jlOk.length} Jupiter Lend)`);
  console.log(`premium ${premium.toFixed(2)} USDC vs Σ standalone ${sumStandalone.toFixed(2)} (saving ${result.pricing.savingPct}%); annualised per $ of extra credit (C1, 0.90): ${result.pricing.annualisedCostPerExtraCredit}% vs ${result.pricing.annualisedStandaloneCostPerExtraCredit}%`);
  console.log('lender   asset    position  D/C′ add → open → after   advanced    payout   refund  state     role');
  for (const r of rows) {
    console.log(`${r.lender.padEnd(8)} ${r.asset.padEnd(8)} ${r.position.slice(0, 8)}  ${r.dcBefore.toFixed(3)} → ${r.dcAtOpen.toFixed(3)} → ${r.dcAfter.toFixed(3)}  ${r.advancedUsdc.toFixed(2).padStart(9)} ${r.payoutUsdc.toFixed(2).padStart(9)} ${r.refundUsdc.toFixed(2).padStart(8)}  ${r.state.padEnd(9)} ${r.role}`);
  }
  console.log(`book: advanced ${result.bookState.advancedUsdc.toFixed(2)}, paid out ${result.bookState.paidOutUsdc.toFixed(2)}, refunded ${result.bookState.refundedUsdc.toFixed(6)} USDC; group released: ${result.groupReleased}`);
  console.log('simulated:'); for (const s of result.simulated) console.log(`  - ${s}`);
  console.log('result: data/demo/book-result.json');
  const failed = [...rShield.failed, ...rSettle.failed, ...rSettle2.failed];
  const ok = legs.length >= 20 && failed.length === 0 && result.groupReleased && bkEnd.state === BOOK.SEALED && n(bkEnd.refunded) > 0 && n(bkEnd.advanced) > 0;
  if (!ok) { console.error(`BOOK DEMO FAILED (${failed.join('; ')})`); process.exit(1); }
}

function PROGRAM_ID_KEY() {
  return pk(JSON.parse(readFileSync(join(ROOT, 'target/idl/credence_core.json'), 'utf8')).address);
}

main().catch((e) => { console.error(e); process.exit(1); });
