// W4 multi-collateral + PYUSD demo on the surfpool mainnet fork (after scripts/demo.sh has deployed and loaded the
// program): a real Sentora xStocks Market obligation with SPYx and NVDAx deposits and a PYUSD debt is covered, shielded
// on both legs and settled in PYUSD from the vault's sleeve.
//
//   1. The real obligation xkHzu8RC… (SPYx + NVDAx / PYUSD, Kamino's Sentora market) gets a demo owner (owner field
//      rewritten by cheatcode, SIMULATED); that owner borrows more PYUSD through real klend to D/C′ ≈ MULTI_RATIO.
//   2. The keeper holds PYUSD (cheatcode, SIMULATED: a Jupiter USDC → PYUSD swap on mainnet) and funds the sleeve
//      through fund_sleeve at klend's PYUSD price (real).
//   3. The owner buys cover (refreshes + buy_cover_multi, 2 legs). Clock → Friday close; Scope holds both closes;
//      keeper: closes.
//   4. Sunday 20:30 ET: both push accounts hold fair values below the close (SIMULATED prices on genuine recorded
//      updates). Keeper: shields → one advance on both legs, from the sleeve, into the obligation.
//   5. Monday open + 75 s: Scope opens below the close on both (SIMULATED move); keeper: settlement prices and
//      settle_policy (both legs SETTLED) → the remainder from the sleeve into the obligation.
// Result: data/demo/multi-result.json with what was simulated.
//
//   pnpm -C keeper run multi-demo    (MULTI_FAIR="-0.10,-0.15", MULTI_OPEN="-0.12,-0.18", MULTI_RATIO=0.87)
import { config } from 'dotenv';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { address, createNoopSigner, createSolanaRpc, AccountRole, type Instruction } from '@solana/kit';
import { KaminoAction, KaminoMarket } from '@kamino-finance/klend-sdk';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import {
  CLOSURE, type Chain, EPOCH, ROOT, TOKEN, TOKEN_2022, USDC_MINT, ata, chainNow, connect, createAtaIx, decodePriceUpdate, fmtTime, log, pdas,
  pk, pushAccount, send, tickerStr,
} from './chain.js';
import { setAccount, setTokenBalance, timeTravel } from './fork.js';
import { borrowedSf, loadObligation, loadReserve, refreshIxs } from './kamino.js';
import { tick } from './jobs.js';
import { sleeveState } from './sleeve.js';
import { recordedScope, restampScope, writeScope } from './weekend.js';

config({ path: join(ROOT, '.env'), quiet: true });
const SENTORA = '8BNUWRSibVasaAmhYpBCFpGgMisGKfVAf9ho3Cmf6vjr';
const OBLIGATION = pk(process.env.MULTI_OBLIGATION ?? 'xkHzu8RCP7giAaBq6AwRu7MreJc2RTLthqLe3yoyiBu');
const PYUSD_RESERVE = '6bR98MJTH68s7eV8ssyBgfuuH5oR2bEt58P9rZPLpBrC';
const LEGS = ['SPYx', 'NVDAx'];
const FAIR = (process.env.MULTI_FAIR ?? '-0.10,-0.15').split(',').map(Number);
const OPEN = (process.env.MULTI_OPEN ?? '-0.12,-0.18').split(',').map(Number);
const RATIO = Number(process.env.MULTI_RATIO ?? 0.87);
const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());
type Pk = InstanceType<typeof web3.PublicKey>;
const simulated: string[] = [];

function toV1(ix: Instruction) {
  return new web3.TransactionInstruction({
    programId: pk(ix.programAddress),
    data: Buffer.from(ix.data ?? new Uint8Array()),
    keys: (ix.accounts ?? []).map((a) => ({
      pubkey: pk(a.address),
      isSigner: a.role === AccountRole.READONLY_SIGNER || a.role === AccountRole.WRITABLE_SIGNER,
      isWritable: a.role === AccountRole.WRITABLE || a.role === AccountRole.WRITABLE_SIGNER,
    })),
  });
}

/** Every Scope (price, TWAP) pair the obligation's reserves read, restamped to the fork clock. */
async function freshSentora(c: Chain) {
  const ob = (await loadObligation(c, OBLIGATION))!;
  const keys = [...ob.deposits, ...ob.borrows].map((d: any) => d.depositReserve ?? d.borrowReserve).filter((k: string) => k !== '11111111111111111111111111111111');
  const pairs = [];
  for (const k of new Set(keys)) {
    const s = (await loadReserve(c, pk(k as string))).config.tokenInfo.scopeConfiguration;
    pairs.push({ price: s.priceChain[0], twap: s.twapChain[0] !== 65535 ? s.twapChain[0] : null });
  }
  return restampScope(c, pairs);
}

/** klend's view after a refresh: debt (PYUSD), D/C′ = debt value / unhealthy borrow value. */
async function state(c: Chain) {
  await freshSentora(c);
  const ob0 = (await loadObligation(c, OBLIGATION))!;
  await send(c, await refreshIxs(c, OBLIGATION, ob0));
  const o = (await loadObligation(c, OBLIGATION))!;
  const sf = (x: { toString(): string }) => Number(BigInt(x.toString()) >> 40n) / 2 ** 20;
  return {
    debtPyusd: Number(BigInt(o.borrows[0].borrowedAmountSf.toString()) >> 60n) / 1e6,
    collateralUsd: sf(o.depositedValueSf),
    debtToCovered: sf(o.borrowFactorAdjustedDebtValueSf) / sf(o.unhealthyBorrowValueSf),
  };
}

/** The newest recorded genuine Pyth push price of the xStock `sym` (committed in data/live/pyth): the fallback genuine
 * price where the live recorder's Scope readings are not available (a fresh clone). */
function recordedPush(sym: string): { price: number; ts: number } | null {
  const dir = join(ROOT, 'data/live/pyth');
  const f = readdirSync(dir).filter((x) => x.startsWith(`${sym}-`)).sort().pop();
  if (!f) return null;
  const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const u = decodePriceUpdate(Buffer.from(j.account.data[0], 'base64'));
  return { price: u.price, ts: u.publishTime };
}

/** The newest recorded genuine push update of `sym`, its price set to `price` and publish time to `t` (fork only). */
function pushAt(sym: string, price: number, t: number) {
  const dir = join(ROOT, 'data/live/pyth');
  const f = readdirSync(dir).filter((x) => x.startsWith(`${sym}-`)).sort().pop();
  if (!f) throw new Error(`no recorded ${sym} push update in data/live/pyth`);
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
  log(`multi-collateral demo on ${c.url} — chain time ${fmtTime(await chainNow(c))}`);
  const cfg = await c.program.account.config.fetch(pdas.config());
  const PYUSD = cfg.pyusdMint as Pk;
  if (PYUSD.toBase58() === '11111111111111111111111111111111') throw new Error('config has no PYUSD mint: run load-onchain first');

  // Vault: an LP if it is small; the keeper opens the coming weekends.
  const v0 = await c.program.account.vault.fetch(pdas.vault());
  if (BigInt(v0.equity.toString()) < 500_000_000_000n) {
    const lp = web3.Keypair.generate();
    await c.conn.confirmTransaction(await c.conn.requestAirdrop(lp.publicKey, 10e9), 'confirmed');
    await setTokenBalance(c, lp.publicKey.toBase58(), USDC_MINT.toBase58(), 1_000_000_000_000n);
    await send(c, [createAtaIx(c.payer.publicKey, lp.publicKey, pdas.shares()),
      await c.program.methods.deposit(new BN('1000000000000'))
        .accountsPartial({ depositor: lp.publicKey, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), depositorUsdc: ata(lp.publicKey, USDC_MINT),
          depositorShares: ata(lp.publicKey, pdas.shares()), shareEscrow: pdas.shareEscrow() }).instruction()], [lp]);
    simulated.push('An LP wallet deposited 1,000,000 USDC (cheatcode USDC).');
  }
  await tick(c);
  const now0 = await chainNow(c);
  const epochs = (await c.program.account.epoch.all()) as { publicKey: Pk; account: any }[];
  const onSale = (t: string) => epochs.filter((e) => e.account.closureType === CLOSURE.WEEKEND && tickerStr(e.account.ticker) === t && e.account.state === EPOCH.OPEN && n(e.account.bell) > now0 && n(e.account.saleOpen) <= now0);
  const group = Math.min(...onSale('SPYx').map((e) => e.account.closureId as number).filter((g) => onSale('NVDAx').some((e) => e.account.closureId === g)));
  if (!Number.isFinite(group)) throw new Error('no weekend with both SPYx and NVDAx on sale now');
  const legEpochs = LEGS.map((t) => onSale(t).find((e) => e.account.closureId === group)!);
  const [close, open] = [n(legEpochs[0].account.close), n(legEpochs[0].account.open)];
  log(`weekend ${group}: close ${fmtTime(close)}, open ${fmtTime(open)}`);

  // 0. A rerun on the same fork starts from genuine prices: the recorder's latest Scope reading per leg, written to
  // Credence's and the Sentora reserves' chains (an earlier run left them at its simulated open).
  const legChains: Record<string, number[]> = {};
  const assets0 = (await c.program.account.assetConfig.all()) as { publicKey: Pk; account: any }[];
  for (const t of LEGS) {
    const a = assets0.find((x) => tickerStr(x.account.ticker) === t)!;
    const sentoraChain = (await loadReserve(c, (a.account.kaminoReserves as Pk[])[1])).config.tokenInfo.scopeConfiguration.priceChain[0];
    legChains[t] = [...new Set([n(a.account.scopeChain), sentoraChain])];
  }
  const now1 = await chainNow(c);
  const resets = LEGS.flatMap((t) => {
    const real = recordedScope(t, 0, Number.MAX_SAFE_INTEGER) ?? recordedPush(t);
    return real ? legChains[t].map((ch) => ({ chain: ch, price: real.price, ts: now1 })) : [];
  });
  if (resets.length) {
    await writeScope(c, resets);
    simulated.push(`Start: Kamino's Scope ${LEGS.join(', ')} set to the latest genuine reading recorded (Kamino Scope from the live recorder, else the xStock's Pyth push price), refreshed now (a rerun on this fork would otherwise start from an earlier run's simulated open).`);
  }

  // 1. The real obligation, a demo owner, more PYUSD borrowed through klend.
  const owner = web3.Keypair.generate();
  await c.conn.confirmTransaction(await c.conn.requestAirdrop(owner.publicKey, 10e9), 'confirmed');
  await setTokenBalance(c, owner.publicKey.toBase58(), USDC_MINT.toBase58(), 10_000_000_000n);
  const acc = (await c.conn.getAccountInfo(OBLIGATION))!;
  const realOwner = new web3.PublicKey(acc.data.subarray(64, 96)).toBase58();
  const data = Buffer.from(acc.data);
  owner.publicKey.toBuffer().copy(data, 64);
  await setAccount(c, OBLIGATION.toBase58(), { lamports: acc.lamports, data, owner: acc.owner.toBase58() });
  simulated.push(`The real Sentora obligation ${OBLIGATION.toBase58()} (owner ${realOwner} on mainnet) had its owner field set to the demo wallet ${owner.publicKey.toBase58()} by cheatcode; deposits and debt are mainnet's.`);
  const s0 = await state(c);
  const extra = Math.floor((s0.debtPyusd * RATIO / s0.debtToCovered - s0.debtPyusd) * 1e6);
  if (extra > 0) {
    await setTokenBalance(c, owner.publicKey.toBase58(), PYUSD.toBase58(), 0n, TOKEN_2022.toBase58());
    const market = await KaminoMarket.load(createSolanaRpc(c.url) as never, address(SENTORA), 400);
    if (!market) throw new Error('Sentora market not found on the fork');
    const kob = await market.getObligationByAddress(address(OBLIGATION.toBase58()));
    const action = await KaminoAction.buildBorrowTxns({
      kaminoMarket: market, amount: new BN(extra.toString()), reserveAddress: address(PYUSD_RESERVE),
      owner: createNoopSigner(address(owner.publicKey.toBase58())), obligation: kob!, useV2Ixs: true, scopeRefreshConfig: undefined,
      includeAtaIxs: true, requestElevationGroup: false, initUserMetadata: { skipInitialization: true, skipLutCreation: true },
      currentLedgerInstant: { slot: BigInt(await c.conn.getSlot()), blockTime: BigInt(await chainNow(c)) } as never,
    });
    await freshSentora(c);
    const ixs = KaminoAction.actionToIxs(action).map(toV1).filter((ix) => !ix.programId.equals(web3.ComputeBudgetProgram.programId));
    const r = await send(c, ixs, [owner]);
    log(`  ok   klend borrow ${(extra / 1e6).toFixed(2)} PYUSD more (${r.cu} CU)`);
  }
  const s1 = await state(c);
  log(`position ${OBLIGATION.toBase58().slice(0, 8)}…: debt ${s1.debtPyusd.toFixed(2)} PYUSD, collateral $${s1.collateralUsd.toFixed(2)}, D/C′ ${s1.debtToCovered.toFixed(4)}`);

  // 2. The sleeve: the keeper's PYUSD (cheatcode) sold to the vault through fund_sleeve.
  const target = Math.ceil(s1.debtPyusd);
  process.env.SLEEVE_TARGET_PYUSD = String(target);
  await setTokenBalance(c, c.payer.publicKey.toBase58(), PYUSD.toBase58(), BigInt(target) * 1_000_000n, TOKEN_2022.toBase58());
  simulated.push(`The keeper wallet was given ${target} PYUSD by cheatcode (on mainnet: a Jupiter USDC → PYUSD swap in its own transaction).`);
  await freshSentora(c);
  const rSleeve = await tick(c);
  const sl = (await sleeveState(c))!;
  log(`sleeve holds ${(Number(sl.held) / 1e6).toFixed(2)} PYUSD (${rSleeve.sent.filter((x) => x.startsWith('fund_sleeve')).join('; ')})`);

  // 3. buy_cover_multi on both legs, cap = the debt.
  const ob = (await loadObligation(c, OBLIGATION))!;
  const debtBase = (borrowedSf(ob, pk(PYUSD_RESERVE)) >> 60n) + 1n;
  const policy = pdas.policy(legEpochs[0].publicKey, OBLIGATION);
  const deps = ob.deposits.filter((d: any) => d.depositReserve !== '11111111111111111111111111111111').map((d: any) => pk(d.depositReserve));
  const rem = [
    ...deps.map((k: Pk) => ({ pubkey: k, isSigner: false, isWritable: false })),
    ...LEGS.flatMap((t, i) => [
      { pubkey: pdas.asset(t), isSigner: false, isWritable: false },
      { pubkey: pdas.scen(t), isSigner: false, isWritable: false },
      { pubkey: legEpochs[i].publicKey, isSigner: false, isWritable: true },
    ]),
  ];
  await freshSentora(c);
  const v1 = await c.program.account.vault.fetch(pdas.vault());
  const bought = await send(c, [...(await refreshIxs(c, OBLIGATION, ob)),
    await c.program.methods.buyCoverMulti(group, new BN(debtBase.toString()), new BN('50000000000'))
      .accountsPartial({ buyer: owner.publicKey, epoch: legEpochs[0].publicKey, loss: pdas.loss(group), vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(),
        feeAccount: v1.feeAccount, buyerUsdc: ata(owner.publicKey, USDC_MINT), obligation: OBLIGATION, borrowReserve: pk(PYUSD_RESERVE),
        sleeve: v1.pyusdSleeve, policy, tokenProgram: TOKEN })
      .remainingAccounts(rem).instruction()], [owner]);
  const p0 = await c.program.account.policy.fetch(policy);
  log(`cover bought on ${LEGS.join(' + ')}: cap ${(n(p0.maxPayout) / 1e6).toFixed(2)} PYUSD, premium ${(n(p0.premium) / 1e6).toFixed(2)} USDC (shield loading ${(n(p0.shieldLoading) / 1e6).toFixed(2)}), reserved ${(n(p0.worstLoss) / 1e6).toFixed(2)}, ${bought.cu} CU`);

  // 3b. Friday close: Kamino's Scope for every SCOPE asset (Credence's chains) and the Sentora chains, genuine prices
  // restamped to the close.
  await timeTravel(c, close + 30);
  const assets = (await c.program.account.assetConfig.all()) as { publicKey: Pk; account: any }[];
  const { decodeScope, SCOPE_PRICES } = await import('./chain.js');
  const scope = (await c.conn.getAccountInfo(SCOPE_PRICES))!.data;
  const chains: Record<string, number[]> = {};
  for (const t of LEGS) {
    const a = assets.find((x) => tickerStr(x.account.ticker) === t)!;
    const sentoraReserve = (a.account.kaminoReserves as Pk[])[1];
    const sentoraChain = (await loadReserve(c, sentoraReserve)).config.tokenInfo.scopeConfiguration.priceChain[0];
    chains[t] = [...new Set([n(a.account.scopeChain), sentoraChain])];
  }
  const closePx: Record<string, number> = {};
  const writes: { chain: number; price: number; ts: number }[] = [];
  for (const a of assets.filter((x) => x.account.enabled === 1 && n(x.account.settleSource) === 2)) {
    const t = tickerStr(a.account.ticker);
    // The recorder's genuine reading (this close window, else its latest), not the fork's current value: an earlier
    // demo run on the same fork left it at a simulated gap, and repeated gaps leave klend's price-heuristic bounds.
    const real = recordedScope(t, close - 60, close + 900) ?? recordedScope(t, 0, Number.MAX_SAFE_INTEGER) ?? recordedPush(t);
    const px = real?.price ?? decodeScope(scope, n(a.account.scopeChain)).price;
    closePx[t] = px;
    for (const ch of chains[t] ?? [n(a.account.scopeChain)]) writes.push({ chain: ch, price: px, ts: close + 20 });
  }
  await writeScope(c, writes);
  simulated.push(`Friday close: Kamino's genuine Scope prices (recorded, else as on the fork: ${LEGS.map((t) => `${t} ${closePx[t].toFixed(4)}`).join(', ')}), refresh time moved to the close.`);
  await tick(c);
  for (const e of legEpochs) if ((await c.program.account.epoch.fetch(e.publicKey)).state !== EPOCH.CLOSED) throw new Error('a close was not stored');

  // 4. Sunday 20:30 ET: fair values below the close on both legs; the keeper shields.
  const sunday = open - 13 * 3600;
  await timeTravel(c, sunday);
  for (const [i, t] of LEGS.entries()) {
    const a = assets.find((x) => tickerStr(x.account.ticker) === t)!;
    const e = await c.program.account.epoch.fetch(legEpochs[i].publicKey);
    const cw = Number(BigInt(e.closePriceWad.toString()) / 10n ** 10n) / 1e8;
    const push = pushAt(t, cw * (1 + FAIR[i]), sunday - 120);
    await setAccount(c, pushAccount(a.account.feedXstock).toBase58(), { lamports: push.lamports, data: push.data, owner: push.owner });
    simulated.push(`Sunday ${fmtTime(sunday)}: the ${t} push account holds the genuine recorded update ${push.file} with its price set to ${(cw * (1 + FAIR[i])).toFixed(4)} (${(FAIR[i] * 100).toFixed(1)}% from the close).`);
  }
  await freshSentora(c);
  const sleeve0 = BigInt((await c.conn.getTokenAccountBalance(sl.sleeve)).value.amount);
  const rShield = await tick(c);
  const p1 = await c.program.account.policy.fetch(policy);
  const advanced = n(p1.advanced) / 1e6;
  const sleeve1 = BigInt((await c.conn.getTokenAccountBalance(sl.sleeve)).value.amount);
  const s2 = await state(c);
  log(`Sunday: shield advanced ${advanced.toFixed(2)} PYUSD from the sleeve (sleeve −${(Number(sleeve0 - sleeve1) / 1e6).toFixed(2)}); D/C′ ${s2.debtToCovered.toFixed(4)}`);

  // 5. Monday open: Scope below the close on both legs; settlement.
  await timeTravel(c, open + 75);
  const moves: { chain: number; price: number; ts: number }[] = [];
  for (const [i, t] of LEGS.entries()) for (const ch of chains[t]) moves.push({ chain: ch, price: closePx[t] * (1 + OPEN[i]), ts: open + 70 });
  await writeScope(c, moves);
  simulated.push(`Monday ${fmtTime(open + 70)}: Kamino's Scope ${LEGS.map((t, i) => `${t} ${(OPEN[i] * 100).toFixed(1)}%`).join(', ')} from the close (both Credence's and the Sentora reserves' chains).`);
  await freshSentora(c);
  const rSettle = await tick(c);
  const p2 = await c.program.account.policy.fetch(policy);
  const sleeve2 = BigInt((await c.conn.getTokenAccountBalance(sl.sleeve)).value.amount);
  const s3 = await state(c);
  const payout = n(p2.payout) / 1e6;
  const vEnd = await c.program.account.vault.fetch(pdas.vault());
  log(`open: settled; payout ${payout.toFixed(2)} PYUSD in total (advance ${advanced.toFixed(2)} + remainder ${(payout - advanced).toFixed(2)}); D/C′ ${s3.debtToCovered.toFixed(4)}`);

  const result = {
    ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), group, legs: LEGS, fair: FAIR, open: OPEN,
    chainTime: { close: fmtTime(close), shield: fmtTime(sunday), open: fmtTime(open) },
    obligation: OBLIGATION.toBase58(), market: SENTORA,
    policy: {
      address: policy.toBase58(), premiumUsdc: n(p0.premium) / 1e6, shieldLoadingUsdc: n(p0.shieldLoading) / 1e6, capPyusd: n(p0.maxPayout) / 1e6,
      reservedPyusd: n(p0.worstLoss) / 1e6, legCoveredPyusd: LEGS.map((_, i) => n(p0.legCovered[i]) / 1e6), debtPyusd: n(p0.debt) / 1e6,
      advancedPyusd: advanced, payoutPyusd: payout, remainderPyusd: +(payout - advanced).toFixed(6), state: p2.state, buyCu: bought.cu,
    },
    sleeve: { fundedPyusd: Number(sl.held) / 1e6, afterShield: Number(sleeve1) / 1e6, afterSettlement: Number(sleeve2) / 1e6, reservedAfter: n(vEnd.pyusdReserved) / 1e6, advancedAfter: n(vEnd.pyusdAdvanced) / 1e6 },
    stages: { before: s0, bought: s1, afterShield: s2, afterSettlement: s3 },
    keeper: { sleevePass: rSleeve.sent.filter((x) => x.startsWith('fund_sleeve')), shieldPass: { sent: rShield.sent, failed: rShield.failed }, settlePass: { sent: rSettle.sent, failed: rSettle.failed } },
    real: [
      'klend and every Kamino account (Sentora xStocks Market, its SPYx, NVDAx and PYUSD reserves, Scope) cloned from mainnet; the obligation and its deposits are mainnet\'s',
      'the extra PYUSD borrow is a real klend borrow signed by the demo owner',
      'credence_core built from this repo: fund_sleeve, buy_cover_multi (2 legs), shield_advance on both legs and settle_policy (vault-PDA repay v2 CPI in PYUSD, Token-2022)',
    ],
    simulated: ['the clock (surfpool time travel)', 'USDC, PYUSD and SOL of the demo wallets (cheatcodes)', ...simulated],
  };
  mkdirSync(join(ROOT, 'data/demo'), { recursive: true });
  writeFileSync(join(ROOT, 'data/demo/multi-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`\n================ multi-collateral demo, weekend ${group} ================`);
  console.log(`obligation ${OBLIGATION.toBase58()} (Sentora): ${LEGS.join(' + ')} / PYUSD, D/C′ ${s1.debtToCovered.toFixed(4)}`);
  console.log(`premium ${result.policy.premiumUsdc.toFixed(2)} USDC; shield ${advanced.toFixed(2)} PYUSD; settlement remainder ${(payout - advanced).toFixed(2)}; total ${payout.toFixed(2)} PYUSD`);
  console.log('simulated:'); for (const s of result.simulated) console.log(`  - ${s}`);
  console.log('result: data/demo/multi-result.json');
  console.log(`@@result ${JSON.stringify(result)}`);
  const ok = advanced > 0 && p2.state === 1 && rSettle.failed.length === 0 && rShield.failed.length === 0 && n(vEnd.pyusdReserved) === 0;
  if (!ok) { console.error('MULTI DEMO FAILED'); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
