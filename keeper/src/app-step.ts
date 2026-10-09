// The app's demo mode, one step per run, driven by app/src/app/api/demo/step (which streams this output):
//
//   setup                 two LPs deposit 1,500,000 USDC; the keeper opens the next four weekends' epochs
//   close                 clock → the demo weekend's Friday close + 30 s; Kamino's Scope holds the close (the genuine
//                         recorded reading from the real close window if the recorder has one, else the fork's current
//                         Scope value with its refresh time moved to the bell); keeper pass (snapshot_close)
//   open --gap -0.08      clock → Monday open + 75 s; Kamino's Scope price of every asset set `gap` from its close,
//                         refreshed at open + 70 s; no keeper pass yet
//   settle                keeper pass: post_settlement, settle_policy (repay into each obligation), process queues;
//                         prints the obligations' debt and the vault before and after
//   status                the demo weekend and the chain clock
//
// The demo weekend is the earliest group with an OPEN epoch. Every transaction goes through the keeper's own jobs and
// prints "ok <what> (<CU> CU)"; the last line is "@@result <json>" with what the step did and what it simulated.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import {
  type Chain, EPOCH, POLICY, ROOT, SCOPE_PRICES, SOURCE, USDC_MINT, ata, chainNow, connect, createAtaIx, decodeScope, fmtTime, log, pdas, send, tickerStr,
} from './chain.js';
import { setTokenBalance, timeTravel } from './fork.js';
import { borrowedSf, loadObligation } from './kamino.js';
import { tick } from './jobs.js';
import { redact } from './redact.js';
import { recordedScope, writeScope } from './weekend.js';

const STATE = join(ROOT, '.fork/app-demo.json');
const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
type State = { group?: number; close?: Record<string, { chain: number; price: number; real: boolean; ts: number }> };
const load = (): State => (existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {});
const save = (s: State) => { mkdirSync(join(ROOT, '.fork'), { recursive: true }); writeFileSync(STATE, JSON.stringify(s, null, 2)); };
const result = (r: unknown) => console.log(`@@result ${JSON.stringify(r)}`);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = { publicKey: InstanceType<typeof web3.PublicKey>; account: any };

async function demoGroup(c: Chain) {
  const epochs = (await c.program.account.epoch.all()) as Row[];
  const open = epochs.filter((e) => e.account.state === EPOCH.OPEN);
  if (!open.length) throw new Error('no OPEN epoch: run the keeper (setup) first');
  const group = Math.min(...open.map((e) => e.account.closureId as number));
  const mine = epochs.filter((e) => e.account.closureId === group);
  return { group, epochs: mine, close: n(mine[0].account.close), open: n(mine[0].account.open) };
}

async function scopeAssets(c: Chain) {
  const assets = (await c.program.account.assetConfig.all()) as Row[];
  return assets.filter((a) => a.account.enabled === 1 && n(a.account.settleSource) === SOURCE.SCOPE);
}

async function vaultSnap(c: Chain) {
  const v = await c.program.account.vault.fetch(pdas.vault());
  const supply = BigInt((await c.conn.getTokenSupply(pdas.shares())).value.amount);
  const equity = BigInt(v.equity.toString());
  return { equity: Number(equity) / 1e6, navPerShare: supply > 0n ? Number((equity * 1_000_000n) / supply) / 1e6 : 1,
    premiumsUnearned: Number(BigInt(v.premiumsUnearned.toString())) / 1e6, totalPayouts: Number(BigInt(v.totalPayouts.toString())) / 1e6,
    liveGroups: v.liveGroups as number };
}

async function policiesOf(c: Chain, group: number) {
  const epochKeys = new Set(((await c.program.account.epoch.all()) as Row[]).filter((e) => e.account.closureId === group).map((e) => e.publicKey.toBase58()));
  const rows = ((await c.program.account.policy.all()) as Row[]).filter((p) => epochKeys.has(p.account.epoch.toBase58()));
  const out = [];
  for (const p of rows) {
    const ob = await loadObligation(c, p.account.obligation);
    out.push({ policy: p.publicKey.toBase58(), ticker: tickerStr(p.account.ticker), obligation: p.account.obligation.toBase58(), state: p.account.state as number,
      maxPayout: n(p.account.maxPayout) / 1e6, premium: n(p.account.premium) / 1e6, payout: n(p.account.payout) / 1e6,
      debt: ob ? Number(borrowedSf(ob, p.account.borrowReserve) >> 60n) / 1e6 : null });
  }
  return out;
}

async function setup(c: Chain) {
  const v = await c.program.account.vault.fetch(pdas.vault());
  const simulated: string[] = [];
  if (BigInt(v.equity.toString()) === 0n) {
    for (const amount of [1_000_000, 500_000]) {
      const lp = web3.Keypair.generate();
      await c.conn.confirmTransaction(await c.conn.requestAirdrop(lp.publicKey, 2e9), 'confirmed');
      await setTokenBalance(c, lp.publicKey.toBase58(), USDC_MINT.toBase58(), BigInt(amount) * 1_000_000n);
      const r = await send(c, [createAtaIx(c.payer.publicKey, lp.publicKey, pdas.shares()),
        await c.program.methods.deposit(new BN((BigInt(amount) * 1_000_000n).toString()))
          .accountsPartial({ depositor: lp.publicKey, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), depositorUsdc: ata(lp.publicKey, USDC_MINT), depositorShares: ata(lp.publicKey, pdas.shares()), shareEscrow: pdas.shareEscrow() })
          .instruction()], [lp]);
      log(`  ok   deposit ${amount.toLocaleString()} USDC from LP ${lp.publicKey.toBase58().slice(0, 8)} (${r.cu} CU)`);
    }
    simulated.push('two demo LPs funded with 1,500,000 USDC by a surfpool cheatcode');
  }
  const r = await tick(c);
  const g = await demoGroup(c);
  save({ group: g.group });
  result({ step: 'setup', group: g.group, close: fmtTime(g.close), open: fmtTime(g.open), sent: r.sent.length, failed: r.failed, simulated, vault: await vaultSnap(c) });
}

async function close(c: Chain) {
  const g = await demoGroup(c);
  const cfg = await c.program.account.config.fetch(pdas.config());
  const now = await chainNow(c);
  const scopeNow = (await c.conn.getAccountInfo(SCOPE_PRICES))!.data; // before time travel
  if (now < g.close + 30) await timeTravel(c, g.close + 30);
  log(`clock → ${fmtTime(await chainNow(c))} (Friday close + 30 s, weekend ${g.group})`);
  const st: State = { group: g.group, close: {} };
  const simulated: string[] = ['the clock: surfpool time travel to the Friday close'];
  const writes: { chain: number; price: number; ts: number }[] = [];
  for (const a of await scopeAssets(c)) {
    const sym = tickerStr(a.account.ticker);
    const chain = n(a.account.scopeChain);
    const real = recordedScope(sym, g.close - (cfg.closeWindowSecs as number), g.close + 900);
    if (real) {
      writes.push({ chain, price: real.price, ts: real.ts });
      log(`  ${sym}: REAL Kamino Scope close ${real.price.toFixed(4)} recorded at ${fmtTime(real.ts)}`);
      st.close![sym] = { chain, price: real.price, real: true, ts: real.ts };
    } else {
      // No genuine reading from this close: the latest genuine mainnet reading the recorder has (so demo weekends do
      // not compound the previous simulated gap), else the fork's current value; refresh time moved to the bell.
      const latest = recordedScope(sym, 0, Number.MAX_SAFE_INTEGER);
      const v = latest ?? { price: decodeScope(scopeNow, chain).price, ts: 0 };
      writes.push({ chain, price: v.price, ts: g.close + 20 });
      st.close![sym] = { chain, price: v.price, real: false, ts: g.close + 20 };
      simulated.push(latest
        ? `${sym} close: Kamino's real Scope price ${v.price.toFixed(4)} (latest mainnet reading by the recorder, refreshed ${fmtTime(latest.ts)}), refresh time moved to the bell (${fmtTime(g.close + 20)}) because no reading from this close exists`
        : `${sym} close: Kamino's Scope price on the fork (${v.price.toFixed(4)}), refresh time moved to the bell (${fmtTime(g.close + 20)}); no genuine reading from this close was recorded`);
    }
  }
  await writeScope(c, writes);
  save(st);
  const r = await tick(c);
  result({ step: 'close', group: g.group, chainTime: fmtTime(await chainNow(c)), closes: st.close, sent: r.sent.length, failed: r.failed, waiting: r.waiting, simulated });
}

async function open(c: Chain, gap: number) {
  const st = load();
  if (!st.close || !st.group) throw new Error('run the Friday close step first');
  const epochs = ((await c.program.account.epoch.all()) as Row[]).filter((e) => e.account.closureId === st.group);
  if (!epochs.length) throw new Error(`no epochs for weekend ${st.group}`);
  if (epochs.some((e) => e.account.state === EPOCH.OPEN)) throw new Error(`weekend ${st.group} has no Friday close yet`);
  const openT = n(epochs[0].account.open);
  const now = await chainNow(c);
  if (now > openT + 75 + 60) throw new Error(`the fork's clock (${fmtTime(now)}) is already past this weekend's open; start a new weekend`);
  if (now < openT + 75) await timeTravel(c, openT + 75);
  log(`clock → ${fmtTime(await chainNow(c))} (Monday open + 75 s)`);
  await writeScope(c, Object.values(st.close).map((x) => ({ chain: x.chain, price: x.price * (1 + gap), ts: openT + 70 })));
  for (const [sym, x] of Object.entries(st.close)) log(`  ${sym}: Kamino Scope ${x.price.toFixed(4)} → ${(x.price * (1 + gap)).toFixed(4)} (${(gap * 100).toFixed(1)}%) at ${fmtTime(openT + 70)}`);
  save({ ...st, gap } as State);
  result({ step: 'open', group: st.group, gap, chainTime: fmtTime(await chainNow(c)), policies: await policiesOf(c, st.group), vault: await vaultSnap(c),
    simulated: ['the clock: surfpool time travel to the Monday open', `Monday open: Kamino's Scope price of every asset set ${(gap * 100).toFixed(1)}% from its close at ${fmtTime(openT + 70)} (klend sees the same price)`] });
}

async function settle(c: Chain) {
  const st = load();
  if (!st.group) throw new Error('run the Friday close and Monday open steps first');
  const before = { policies: await policiesOf(c, st.group), vault: await vaultSnap(c) };
  const r = await tick(c);
  const after = { policies: await policiesOf(c, st.group), vault: await vaultSnap(c) };
  const epochs = ((await c.program.account.epoch.all()) as Row[]).filter((e) => e.account.closureId === st.group);
  result({ step: 'settle', group: st.group, chainTime: fmtTime(await chainNow(c)), sent: r.sent.length, failed: r.failed, waiting: r.waiting,
    epochs: epochs.map((e) => ({ ticker: tickerStr(e.account.ticker), state: e.account.state, closePrice: Number(BigInt(e.account.closePriceWad.toString()) / 10n ** 12n) / 1e6, settlePrice: Number(BigInt(e.account.settlePriceWad.toString()) / 10n ** 12n) / 1e6 })),
    before, after, settled: after.policies.filter((p) => p.state === POLICY.SETTLED).length });
}

async function status(c: Chain) {
  const g = await demoGroup(c).catch(() => null);
  result({ step: 'status', chainTime: fmtTime(await chainNow(c)), chainNow: await chainNow(c), group: g?.group ?? null, close: g?.close ?? null, open: g?.open ?? null, state: load() });
}

async function main() {
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const step = process.argv[2];
  if (step === 'setup') await setup(c);
  else if (step === 'close') await close(c);
  else if (step === 'open') await open(c, Number(arg('--gap', '-0.08')));
  else if (step === 'settle') await settle(c);
  else if (step === 'status') await status(c);
  else throw new Error('usage: app-step.ts setup|close|open --gap <x>|settle|status');
}
main().then(() => process.exit(0)).catch((e) => {
  console.error(`@@error ${redact(String(e?.message ?? e)).split('\n')[0]}`);
  process.exit(1);
});
