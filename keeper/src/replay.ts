// W6 real-weekend replay on the surfpool mainnet fork (after scripts/demo.sh's fork steps: deploy, load-onchain, pin-klend).
// "Fork replay of the real Oct 9–12 weekend." What is real and what is not is written into every output file.
//
//   Positions   real Kamino (xStocks market) obligations the shadow tracked: the N largest by debt at the bell plus every
//               position the shadow flagged liquidatable, read from the shadow folder (data/shadow/<closure>). A demo
//               curator wallet covers them through one book (open_book, add_book_leg, seal_book), so no obligation's owner
//               is rewritten (the book needs no owner); their deposits and debt are mainnet's at the fork's slot.
//   Epoch       The fork's clock follows the wall clock and cannot go back (surfnet_timeTravel refuses a past time, and a
//               Clock write is overwritten on the next slot), and open_epoch needs now < bell: the epoch of closure
//               20261009 cannot be opened. The replay runs on the next weekend's epoch and shifts every real time by the
//               exact difference between the two closes (a whole number of days), so each price keeps its place in the
//               weekend relative to the close, the Shield window and the open.
//   Close       the genuine captured Scope reading the shadow used as the close (data/live/scope), stamped into the fork's
//               Scope account as the demo does.
//   Shield      the genuine recorded Pyth push accounts (data/live/pyth) published in the weekend, placed with only their
//               publish time shifted; the keeper decides (36 h age, confidence, Full verification).
//   Open        the genuine captured Monday open (first reading in [open + 60 s, open + 6 min], data/live/scope), else the
//               latest Scope reading, labelled PLACEHOLDER (a pre-Monday run); then the keeper settles.
//
//   pnpm -C keeper run replay        (REPLAY_N=20, REPLAY_OUT=<dir>, REPLAY_SCOPE_DIR / REPLAY_PYTH_DIR to read the live
//                                     recorders' folders from another checkout; they are only read)
import { config } from 'dotenv';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import {
  BOOK, CLOSURE, type Chain, EPOCH, ROOT, USDC_MINT, TOKEN, ata, chainNow, connect, createAtaIx, decodePriceUpdate, fmtTime, log,
  pdas, pk, pushAccount, send, tickerStr, ticker8,
} from './chain.js';
import { setAccount, setTokenBalance, timeTravel } from './fork.js';
import { loadObligation, loadReserve, borrowedSf, refreshIxs } from './kamino.js';
import { tick } from './jobs.js';
import { sendV0 } from './jupiter.js';
import { writeScope } from './weekend.js';

config({ path: join(ROOT, '.env'), quiet: true });
type Pk = InstanceType<typeof web3.PublicKey>;
type Ix = InstanceType<typeof web3.TransactionInstruction>;
const CLOSURE_ID = Number(process.env.REPLAY_CLOSURE ?? 20261009);
const N_LARGEST = Number(process.env.REPLAY_N ?? 20);
const K = Number(process.env.REPLAY_K ?? 4);
/** A SYNTHETIC Monday open (a fraction from the close) to exercise the payout path before the real one; never a result. */
const SYNTH_GAP = process.env.REPLAY_OPEN_GAP === undefined ? null : Number(process.env.REPLAY_OPEN_GAP);
const SCOPE_DIR = process.env.REPLAY_SCOPE_DIR ?? join(ROOT, 'data/live/scope');
const PYTH_DIR = process.env.REPLAY_PYTH_DIR ?? join(ROOT, 'data/live/pyth');
const LIVE_DIR = process.env.REPLAY_LIVE_DIR ?? join(ROOT, 'data/live');
const SHADOW_DIR = process.env.REPLAY_SHADOW_DIR ?? join(ROOT, 'data/shadow', String(CLOSURE_ID));
const SYMS = ['SPYx', 'QQQx', 'NVDAx'] as const;
type Sym = (typeof SYMS)[number];
const XSTOCKS_MARKET = '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua';
const USDC_RESERVE = pk('97zoywd8mPZsGTg8q1wdD2Wgkdrs2tqusp1Qqcxbyj7E');
const LABEL = 'fork replay of the real Oct 9–12 weekend; positions are real mainnet obligations covered by a demo curator wallet (owners not rewritten)';
const n = (x: { toString(): string } | number) => (typeof x === 'number' ? x : Number(x.toString()));
const notes: string[] = [];
const ERRORS: { code: number; name: string }[] = JSON.parse(readFileSync(join(ROOT, 'target/idl/credence_core.json'), 'utf8')).errors ?? [];
/** `{"InstructionError":[5,{"Custom":6015}]} | …` → `UnsupportedObligation (6015) | …`. */
const named = (m: string) => m.replace(/\{"InstructionError":\[\d+,\{"Custom":(\d+)\}\]\}/, (_, c) => `${ERRORS.find((e) => e.code === Number(c))?.name ?? 'Custom'} (${c})`);
const jsonl = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

type Capture = { observedAt: string; entries: Record<Sym, { chain: number; price: number; ts: number }> };
function captures(): Capture[] {
  return readdirSync(SCOPE_DIR).filter((f) => /^scope-\d+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(SCOPE_DIR, f), 'utf8')) as Capture)
    .sort((a, b) => a.entries.SPYx.ts - b.entries.SPYx.ts);
}

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

/** A genuine recorded push update of `sym`, its publish time shifted by `shift` seconds and nothing else changed. */
function shiftedPush(file: string, shift: number) {
  const j = JSON.parse(readFileSync(join(PYTH_DIR, file), 'utf8'));
  const d = Buffer.from(j.account.data[0], 'base64');
  const u = decodePriceUpdate(d);
  d.writeBigInt64LE(d.readBigInt64LE(u.offsets.publishTime) + BigInt(shift), u.offsets.publishTime);
  d.writeBigInt64LE(d.readBigInt64LE(u.offsets.prevPublishTime) + BigInt(shift), u.offsets.prevPublishTime);
  return { data: d, lamports: j.account.lamports as number, owner: j.account.owner as string, price: u.price, publish: Number(d.readBigInt64LE(u.offsets.publishTime)) - shift };
}
/** Recorded pushes of `sym` published in [from, to] (real unix seconds), from the file names, oldest first. */
function recordedPushes(sym: string, from: number, to: number) {
  return readdirSync(PYTH_DIR).filter((f) => f.startsWith(`${sym}-`) && f.endsWith('.json'))
    .map((f) => ({ file: f, t: Number(f.slice(sym.length + 1, -5)) })).filter((x) => x.t >= from && x.t <= to).sort((a, b) => a.t - b.t);
}

async function main() {
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const t0 = Date.now();
  log(`${LABEL}\nfork ${c.url} — chain time ${fmtTime(await chainNow(c))}`);

  // The real weekend: calendar times and the shadow's own readings.
  const sessions = JSON.parse(readFileSync(join(ROOT, 'data/onchain/calendar-XNYS.json'), 'utf8')).sessions as { date: number; open: number; close: number }[];
  const si = sessions.findIndex((s) => s.date === CLOSURE_ID);
  const real = { bell: sessions[si].close - 15 * 60, close: sessions[si].close, open: sessions[si + 1].open };
  const summary = JSON.parse(readFileSync(join(SHADOW_DIR, 'summary.json'), 'utf8'));
  const state = JSON.parse(readFileSync(join(SHADOW_DIR, 'state.json'), 'utf8'));
  const shadowEvents = jsonl(join(SHADOW_DIR, 'events.jsonl'));
  const caps = captures();

  // LP and epochs on the fork.
  const v0 = await c.program.account.vault.fetch(pdas.vault());
  if (BigInt(v0.equity.toString()) < 1_500_000_000_000n) {
    const lp = web3.Keypair.generate();
    await c.conn.confirmTransaction(await c.conn.requestAirdrop(lp.publicKey, 10e9), 'confirmed');
    await setTokenBalance(c, lp.publicKey.toBase58(), USDC_MINT.toBase58(), 2_000_000_000_000n);
    await send(c, [createAtaIx(c.payer.publicKey, lp.publicKey, pdas.shares()),
      await c.program.methods.deposit(new BN('2000000000000')).accountsPartial({ depositor: lp.publicKey, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(),
        depositorUsdc: ata(lp.publicKey, USDC_MINT), depositorShares: ata(lp.publicKey, pdas.shares()), shareEscrow: pdas.shareEscrow() }).instruction()], [lp]);
    notes.push('An LP wallet deposited 2,000,000 USDC (cheatcode USDC); the shadow\'s premium model assumes the same $2M vault.');
  }
  await tick(c);
  const now0 = await chainNow(c);
  const epochs = (await c.program.account.epoch.all()) as { publicKey: Pk; account: any }[];
  const onSale = (t: string) => epochs.filter((e) => e.account.closureType === CLOSURE.WEEKEND && tickerStr(e.account.ticker) === t && e.account.state === EPOCH.OPEN && n(e.account.bell) > now0);
  const group = Math.min(...onSale('SPYx').map((e) => e.account.closureId as number).filter((g) => SYMS.every((s) => onSale(s).some((e) => e.account.closureId === g))));
  if (!Number.isFinite(group)) throw new Error('no weekend epoch with SPYx, QQQx and NVDAx open');
  const ep = (t: string) => epochs.find((e) => tickerStr(e.account.ticker) === t && e.account.closureId === group)!;
  const [saleOpen, bell, close, open] = [n(ep('SPYx').account.saleOpen), n(ep('SPYx').account.bell), n(ep('SPYx').account.close), n(ep('SPYx').account.open)];
  if (saleOpen > now0) {
    await timeTravel(c, saleOpen + 3600);
    notes.push(`The fork's clock moved from ${fmtTime(now0)} to ${fmtTime(saleOpen + 3600)}, into epoch ${group}'s sale window (SIMULATED time).`);
  }
  const shift = close - real.close; // seconds, a whole number of days
  if (shift % 86_400 !== 0) throw new Error(`the epochs' close is not a whole number of days after the real close (${shift} s)`);
  notes.push(`Epoch: closure ${group} (the fork's clock is past closure ${CLOSURE_ID}'s bell and cannot go back); every real time below is shifted by +${shift / 86_400} days.`);
  log(`epoch ${group}: bell ${fmtTime(bell)}, close ${fmtTime(close)}, open ${fmtTime(open)} (real closure ${CLOSURE_ID} + ${shift / 86_400} d)`);

  // Real readings: the close the shadow used, and the Monday open (genuine capture, else PLACEHOLDER).
  const closeReading = Object.fromEntries(SYMS.map((s) => {
    const sc = summary.close?.[s];
    if (!sc) throw new Error(`the shadow has no ${s} close`);
    const cap = caps.find((x) => x.entries[s].ts === sc.ts);
    if (!cap) throw new Error(`no Scope capture with the shadow's ${s} close reading (ts ${sc.ts})`);
    if (Math.abs(cap.entries[s].price / sc.price - 1) > 1e-9) throw new Error(`${s}: capture ${cap.entries[s].price} differs from the shadow's close ${sc.price}`);
    return [s, { ...cap.entries[s], source: 'data/live/scope capture = the shadow\'s close reading' }];
  })) as Record<Sym, { chain: number; price: number; ts: number; source: string }>;
  const openReading = Object.fromEntries(SYMS.map((s) => {
    const cap = caps.find((x) => x.entries[s].ts >= real.open + 60 && x.entries[s].ts <= real.open + 6 * 60);
    if (cap) return [s, { ...cap.entries[s], genuine: true, source: 'data/live/scope capture in [open + 60 s, open + 6 min]' }];
    const latest = [...caps].reverse()[0].entries[s];
    // The recorder's newest Scope reading (events-*.jsonl) is newer than the checkpoint captures.
    let best = { price: latest.price, ts: latest.ts };
    for (const f of readdirSync(LIVE_DIR).filter((x) => /^events-\d+\.jsonl$/.test(x))) {
      for (const l of readFileSync(join(LIVE_DIR, f), 'utf8').split('\n')) {
        if (!l.includes('"kind":"scope"') || !l.includes(`"sym":"${s}"`)) continue;
        const e = JSON.parse(l) as { price: number; ts: number };
        if (e.ts > best.ts) best = e;
      }
    }
    return [s, { chain: latest.chain, ...best, genuine: false, source: 'PLACEHOLDER: the latest Scope reading (no Monday-open capture yet)' }];
  })) as Record<Sym, { chain: number; price: number; ts: number; genuine: boolean; source: string }>;
  if (SYNTH_GAP !== null) for (const s of SYMS) openReading[s] = { ...openReading[s], price: closeReading[s].price * (1 + SYNTH_GAP), genuine: false, source: `SYNTHETIC: the close ${(SYNTH_GAP * 100).toFixed(1)}% (REPLAY_OPEN_GAP), not a result` };
  const genuineOpen = SYMS.every((s) => openReading[s].genuine);
  if (!genuineOpen) notes.push(SYNTH_GAP !== null ? 'Monday open is SYNTHETIC (a test of the payout path), not a result.' : 'Monday open is a PLACEHOLDER (the latest Scope reading); re-run once data/live/scope holds the open capture.');

  // Positions: the N largest by debt at the bell plus every position the shadow flagged, xStocks market, covered by the shadow.
  const rows = Object.values(state.positions as Record<string, any>).filter((p) => p.market === XSTOCKS_MARKET && p.cover?.premium);
  const flagged = new Set(shadowEvents.filter((e) => e.kind === 'liquidatable' || e.kind === 'liquidatable-despite-shield').map((e) => e.ob as string));
  const largest = [...rows].sort((a, b) => Number(b.cover.debt) - Number(a.cover.debt)).slice(0, N_LARGEST);
  const pick = [...new Map([...largest, ...rows.filter((p) => flagged.has(p.ob))].map((p) => [p.ob as string, p])).values()];
  log(`${pick.length} positions: ${largest.length} largest by debt + ${pick.length - largest.length} flagged by the shadow`);

  // Curator, book, lookup table.
  const curator = web3.Keypair.generate();
  await c.conn.confirmTransaction(await c.conn.requestAirdrop(curator.publicKey, 20e9), 'confirmed');
  await setTokenBalance(c, curator.publicKey.toBase58(), USDC_MINT.toBase58(), 100_000_000_000n);
  notes.push(`The curator wallet ${curator.publicKey.toBase58()} was given 100,000 USDC and SOL by cheatcode.`);
  const curatorUsdc = ata(curator.publicKey, USDC_MINT);
  const book = pdas.book(curator.publicKey, group, 1);
  await send(c, [await c.program.methods.openBook(group, 1).accountsPartial({ payer: curator.publicKey, epoch: ep('SPYx').publicKey, book, escrow: pdas.bookEscrow(book),
    usdcMint: USDC_MINT, payerUsdc: curatorUsdc, tokenProgram: TOKEN }).instruction()], [curator]);
  const assets = Object.fromEntries(await Promise.all(SYMS.map(async (s) => [s, (await c.program.account.assetConfig.fetch(pdas.asset(s))) as any]))) as Record<Sym, any>;
  const reserveOf = (s: Sym) => (assets[s].kaminoReserves as Pk[])[0];
  const usdcRes = await loadReserve(c, USDC_RESERVE);
  const idl = JSON.parse(readFileSync(join(ROOT, 'target/idl/credence_core.json'), 'utf8')).address;
  const shared = [pdas.config(), pdas.vault(), pdas.vaultUsdc(), pdas.shares(), pdas.loss(group), book, pdas.bookEscrow(book), curatorUsdc, TOKEN, web3.SystemProgram.programId,
    ...SYMS.flatMap((s) => [pdas.asset(s), pdas.scen(s), ep(s).publicKey, reserveOf(s)]), USDC_RESERVE, pk(XSTOCKS_MARKET), pk('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD'),
    pk(usdcRes.config.tokenInfo.scopeConfiguration.priceFeed), pk(idl)];
  const alt = await lookupTable(c, [...new Map(shared.map((k) => [k.toBase58(), k])).values()]);

  // Legs, per asset in batches of K; a batch that fails is retried leg by leg and a refused position is reported.
  const addLegs = async (s: Sym, obs: Pk[]) => {
    const ixs: Ix[] = [];
    await freshFor(c, obs);
    const o0 = (await loadObligation(c, obs[0]))!;
    ixs.push(...(await refreshIxs(c, obs[0], o0)).slice(0, -1));
    for (const ob of obs) ixs.push((await refreshIxs(c, ob, (await loadObligation(c, ob))!)).slice(-1)[0]);
    for (const ob of obs) {
      ixs.push(await c.program.methods.addBookLeg(ticker8(s), group).accountsPartial({ payer: curator.publicKey, asset: pdas.asset(s), scenarios: pdas.scen(s),
        epoch: ep(s).publicKey, loss: pdas.loss(group), vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), book, escrow: pdas.bookEscrow(book), payerUsdc: curatorUsdc,
        obligation: ob, depositReserve: reserveOf(s), borrowReserve: USDC_RESERVE, policy: pdas.policy(ep(s).publicKey, ob), tokenProgram: TOKEN }).instruction());
    }
    return sendV0(c, ixs, [alt], [curator]);
  };
  type Leg = { sym: Sym; position: Pk; policy: Pk; flagged: boolean; shadowDebtUsd: number; before?: { debt: number; dc: number }; atClose?: { debt: number; dc: number };
    atOpen?: { debt: number; dc: number }; after?: { debt: number; dc: number } };
  const legs: Leg[] = [];
  const refused: { position: string; sym: string; why: string }[] = [];
  for (const s of SYMS) {
    const mine = pick.filter((p) => p.sym === s);
    for (let i = 0; i < mine.length; i += K) {
      const batch = mine.slice(i, i + K);
      const add = (ps: any[]) => ps.map((p) => ({ sym: s, position: pk(p.ob), policy: pdas.policy(ep(s).publicKey, pk(p.ob)), flagged: flagged.has(p.ob), shadowDebtUsd: Number(p.cover.debt) / 1e6 }));
      try {
        const r = await addLegs(s, batch.map((p) => pk(p.ob)));
        log(`  ok   add_book_leg ×${batch.length} (${s}): ${r.cu} CU`);
        legs.push(...add(batch));
      } catch {
        for (const p of batch) {
          try { const r = await addLegs(s, [pk(p.ob)]); log(`  ok   add_book_leg ${p.ob.slice(0, 8)} (${s}): ${r.cu} CU`); legs.push(...add([p])); }
          catch (e) { const why = named((e as Error).message.split('\n').slice(0, 1).join(' | ')); refused.push({ position: p.ob, sym: s, why }); log(`  skip ${p.ob.slice(0, 8)} (${s}): ${why}`); }
        }
      }
    }
  }
  if (legs.length === 0) throw new Error('no leg was added');
  for (const l of legs) {
    const p = (await c.program.account.policy.fetch(l.policy)) as any;
    l.before = { debt: n(p.debt) / 1e6, dc: n(p.debt) / n(p.coveredValue) };
  }
  const bk0 = (await c.program.account.book.fetch(book)) as any;
  await send(c, [await c.program.methods.sealBook(new BN('100000000000')).accountsPartial({ payer: curator.publicKey, book, escrow: pdas.bookEscrow(book), payerUsdc: curatorUsdc,
    loss: pdas.loss(group), vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), feeAccount: (await c.program.account.vault.fetch(pdas.vault())).feeAccount, tokenProgram: TOKEN })
    .instruction()], [curator]);
  const bk1 = (await c.program.account.book.fetch(book)) as any;
  log(`sealed: ${bk1.legsLive} legs, premium ${(n(bk1.premium) / 1e6).toFixed(2)} USDC (escrow held ${(n(bk0.escrowed) / 1e6).toFixed(2)})`);

  // Friday close: the genuine captured Scope reading (shifted), then the keeper closes the epochs.
  await timeTravel(c, close + 30);
  await writeScope(c, SYMS.map((s) => ({ chain: n(assets[s].scopeChain), price: closeReading[s].price, ts: closeReading[s].ts + shift })));
  notes.push(`Friday close: Kamino's Scope SPYx/QQQx/NVDAx set to the genuine captured readings ${SYMS.map((s) => `${s} ${closeReading[s].price.toFixed(4)} (ts ${new Date(closeReading[s].ts * 1000).toISOString()})`).join(', ')}.`);
  const rClose = await tick(c);
  for (const l of legs) l.atClose = await kaminoState(c, l.position);

  // Shield: the genuine recorded pushes of the weekend at two points of the window (Sunday 20:30 ET and Monday 06:00 ET).
  const shieldRuns: { at: string; realAt: string; pushes: Record<string, unknown>; sent: string[]; failed: string[] }[] = [];
  for (const [label, before] of [['Sunday 20:30 ET', 13 * 3600], ['Monday 06:00 ET', 3.5 * 3600]] as const) {
    const at = open - before;
    await timeTravel(c, at);
    const pushes: Record<string, unknown> = {};
    for (const s of SYMS) {
      const cand = recordedPushes(s, real.close, at - shift).pop();
      if (!cand) { pushes[s] = 'no genuine push recorded in the weekend yet: the push account is left as the fork cloned it'; continue; }
      const p = shiftedPush(cand.file, shift);
      await setAccount(c, pushAccount(assets[s].feedXstock).toBase58(), { lamports: p.lamports, data: p.data, owner: p.owner });
      pushes[s] = { file: cand.file, price: p.price, publishedAt: new Date(p.publish * 1000).toISOString(), vsClose: p.price / closeReading[s].price - 1 };
    }
    await freshFor(c, legs.map((l) => l.position));
    const r = await tick(c);
    shieldRuns.push({ at: fmtTime(at), realAt: new Date((at - shift) * 1000).toISOString(), pushes, sent: r.sent, failed: r.failed });
  }
  notes.push('Shield: the genuine recorded Pyth push accounts of the weekend with only their publish time shifted; the keeper applied its 36 h age, confidence and Full-verification checks.');

  // Monday open: the genuine capture (or PLACEHOLDER), then settlement.
  await timeTravel(c, open + 75);
  await writeScope(c, SYMS.map((s) => ({ chain: n(assets[s].scopeChain), price: openReading[s].price, ts: genuineOpen ? openReading[s].ts + shift : open + 70 })));
  notes.push(`Monday ${fmtTime(open + 70)}: Kamino's Scope ${genuineOpen ? 'at the genuine captured open' : SYNTH_GAP !== null ? 'at the SYNTHETIC open' : 'at the PLACEHOLDER (latest Scope reading, not the open)'}: ${SYMS.map((s) => `${s} ${openReading[s].price.toFixed(4)}`).join(', ')}.`);
  for (const l of legs) l.atOpen = await kaminoState(c, l.position);
  await freshFor(c, legs.map((l) => l.position));
  const rSettle = await tick(c);
  await freshFor(c, legs.map((l) => l.position));
  const rSettle2 = await tick(c);

  const bkEnd = (await c.program.account.book.fetch(book)) as any;
  const out: any[] = [];
  for (const l of legs) {
    l.after = await kaminoState(c, l.position);
    const p = (await c.program.account.policy.fetch(l.policy).catch(() => null)) as any;
    out.push({
      asset: l.sym, position: l.position.toBase58(), flaggedByShadow: l.flagged, debtUsdcAtAdd: +l.before!.debt.toFixed(2),
      dcAtAdd: +l.before!.dc.toFixed(4), dcAtClose: +l.atClose!.dc.toFixed(4), dcAtOpen: +l.atOpen!.dc.toFixed(4), dcAfter: +l.after.dc.toFixed(4),
      advancedUsdc: p ? n(p.advanced) / 1e6 : 0, payoutUsdc: p ? n(p.payout) / 1e6 : 0,
      state: !p ? 'closed' : p.state === 1 ? 'SETTLED' : p.state === 2 ? 'REFUNDED' : 'ACTIVE',
    });
  }
  const lossVec = await c.program.account.lossVector.fetch(pdas.loss(group));

  // Transactions of the book (every leg, seal, shield, settlement and refund touches the book account).
  const sigs = await c.conn.getSignaturesForAddress(book, { limit: 1000 });
  const txs: { signature: string; slot: number; err: unknown; instructions: string[] }[] = [];
  for (const s of sigs.reverse()) {
    const t = await c.conn.getTransaction(s.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 }).catch(() => null);
    const names = [...new Set((t?.meta?.logMessages ?? []).map((m) => /Instruction: (\w+)/.exec(m)?.[1]).filter(Boolean) as string[])].filter((x) => !/^(Transfer|Burn|MintTo|Refresh|Initialize|Close|Sync|Create)/.test(x));
    txs.push({ signature: s.signature, slot: s.slot, err: s.err, instructions: names });
  }

  const totals = {
    legs: out.length, premiumUsdc: n(bk1.premium) / 1e6, debtCoveredUsdc: +out.reduce((a, r) => a + r.debtUsdcAtAdd, 0).toFixed(2),
    advancedUsdc: out.reduce((a, r) => a + r.advancedUsdc, 0), payoutsUsdc: out.reduce((a, r) => a + r.payoutUsdc, 0),
    paying: out.filter((r) => r.payoutUsdc > 0).length, shieldActed: out.filter((r) => r.advancedUsdc > 0).length,
  };
  const result = {
    label: LABEL, mondayOpen: genuineOpen ? 'GENUINE captured Scope open' : SYNTH_GAP !== null ? 'SYNTHETIC' : 'PLACEHOLDER', ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000),
    realWeekend: { closure: CLOSURE_ID, bell: new Date(real.bell * 1000).toISOString(), close: new Date(real.close * 1000).toISOString(), open: new Date(real.open * 1000).toISOString() },
    fork: { url: 'surfpool mainnet fork (lazy clone at the current slot; the past slot of the Friday bell cannot be forked)', epochClosure: group, shiftDays: shift / 86_400, forkSlot: await c.conn.getSlot(),
      chainTime: { bell: fmtTime(bell), close: fmtTime(close), open: fmtTime(open) } },
    prices: Object.fromEntries(SYMS.map((s) => [s, { scopeClose: closeReading[s].price, closeTs: new Date(closeReading[s].ts * 1000).toISOString(), scopeOpen: openReading[s].price,
      openTs: new Date(openReading[s].ts * 1000).toISOString(), openGenuine: openReading[s].genuine, gap: openReading[s].price / closeReading[s].price - 1, closeSource: closeReading[s].source, openSource: openReading[s].source }])),
    positions: { chosen: pick.length, largestByDebt: largest.length, flaggedByShadow: [...flagged], added: legs.length, refused },
    book: { address: book.toBase58(), curator: curator.publicKey.toBase58(), premiumUsdc: n(bk1.premium) / 1e6, state: bkEnd.state, legsDone: bkEnd.legsDone, legsAdded: bkEnd.legsAdded,
      advancedUsdc: n(bkEnd.advanced) / 1e6, paidOutUsdc: n(bkEnd.paidOut) / 1e6, refundedUsdc: n(bkEnd.refunded) / 1e6 },
    totals, groupReleased: lossVec.settled === 1, legs: out, shield: shieldRuns,
    keeper: { close: { sent: rClose.sent, failed: rClose.failed }, settle: { sent: [...rSettle.sent, ...rSettle2.sent], failed: [...rSettle.failed, ...rSettle2.failed] } },
    transactions: txs,
    real: ['klend, Kamino Scope reserves and every position cloned from mainnet', 'the Friday close and Monday-open Scope readings and the Pyth weekend pushes are genuine captures (times shifted by whole days)',
      'credence_core built from this repo: open_book, add_book_leg, seal_book, shield_book_leg, settle_book_leg through klend'],
    simulated: ['the clock (surfpool time travel) and the epoch (the next weekend\'s, see above)', 'USDC and SOL of the demo wallets (cheatcodes)', ...notes],
  };
  const dir = process.env.REPLAY_OUT ?? join(ROOT, 'data/replay', String(CLOSURE_ID) + (genuineOpen ? '' : SYNTH_GAP !== null ? '-SYNTHETIC' : '-PLACEHOLDER'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'replay.json'), JSON.stringify(result, null, 2) + '\n');
  const L = [`# Replay of the real Oct 9–12 weekend (closure ${CLOSURE_ID})`, '', `_${LABEL}._`, '', `**Monday open: ${result.mondayOpen}.**`, '',
    `- Epoch: closure ${group} on the fork (shift +${shift / 86_400} d); book ${book.toBase58()}; ${totals.legs} legs, ${totals.debtCoveredUsdc.toLocaleString('en-US')} USDC of debt; premium ${totals.premiumUsdc.toFixed(2)} USDC`,
    `- Shield advanced ${totals.advancedUsdc.toFixed(2)} USDC on ${totals.shieldActed} legs; payouts ${totals.payoutsUsdc.toFixed(2)} USDC on ${totals.paying} legs; group released: ${result.groupReleased}`, '',
    '| Asset | Position | D/C′ add → close → open → after | Advanced | Payout | State |', '|---|---|---|---|---|---|',
    ...out.map((r) => `| ${r.asset} | ${r.position.slice(0, 8)}${r.flaggedByShadow ? ' (flagged)' : ''} | ${r.dcAtAdd} → ${r.dcAtClose} → ${r.dcAtOpen} → ${r.dcAfter} | ${r.advancedUsdc.toFixed(2)} | ${r.payoutUsdc.toFixed(2)} | ${r.state} |`),
    '', `Transactions: ${txs.length} (signatures in replay.json).`, '', '## Simulated / notes', '', ...result.simulated.map((x) => `- ${x}`), ''];
  writeFileSync(join(dir, 'replay.md'), L.join('\n'));
  console.log(L.join('\n'));
  const failed = [...rClose.failed, ...rSettle.failed, ...rSettle2.failed, ...shieldRuns.flatMap((r) => r.failed)];
  if (failed.length || bkEnd.state !== BOOK.SEALED) { console.error(`REPLAY FAILED (${failed.join('; ')})`); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
