// W12 Jupiter Lend demo on the surfpool mainnet fork (after scripts/demo.sh has deployed and loaded the program, with
// the Jupiter alias assets): a real Jupiter Lend SPYx/USDC position is covered, shielded and settled.
//
//   1. A real position of vault 78 (SPYx / USDC, the largest one with debt) gets a demo owner: its NFT's token account
//      is rewritten to the demo wallet (cheatcode, SIMULATED); that owner borrows more USDC through Jupiter Lend to
//      D/C′ ≈ JL_RATIO (a real Jupiter operate).
//   2. The owner buys cover on SPYx.J (buy_cover_jl). Clock → Friday close: Jupiter's SPYx Chainlink cache holds its
//      price at the close (cheatcode, SIMULATED refresh time; the price is the cache's own); keeper: closes.
//   3. Sunday 20:30 ET: the SPYx push account holds a fair value JL_FAIR below the close (SIMULATED price on a genuine
//      recorded update); keeper: shields → shield_advance_jl pays back into the position (operate CPI).
//   4. Monday open + 75 s: Jupiter's cache JL_OPEN below the close (SIMULATED move); keeper: settlement price and
//      settle_policy_jl.
// Result: data/demo/jl-result.json.     pnpm -C keeper run jl-demo
import { config } from 'dotenv';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import { getOperateIx, getRatioAtTick } from '@jup-ag/lend/borrow';
import { type Chain, EPOCH, ROOT, TOKEN, USDC_MINT, ata, chainNow, connect, createAtaIx, decodePriceUpdate, fmtTime, log, pdas, pk, pushAccount, tickerStr } from './chain.js';
import { setAccount, setTokenBalance, timeTravel } from './fork.js';
import { tick } from './jobs.js';
import { JL_VAULTS, positionIds, readJlCache, sendV0 } from './jupiter.js';

config({ path: join(ROOT, '.env'), quiet: true });
const VAULT_ID = Number(process.env.JL_VAULT ?? 78);
const TICKER = process.env.JL_TICKER ?? 'SPYx.J';
const FAIR = Number(process.env.JL_FAIR ?? -0.08);
const OPEN = Number(process.env.JL_OPEN ?? -0.1);
/** Friday's move before the purchase: Jupiter caps borrowing at D/C′ = CF/LT (0.88 for SPYx), below where any stress
 * scenario loses, so the position is brought near the threshold the way positions get there: the price falls. */
const PREDROP = Number(process.env.JL_PREDROP ?? -0.06);
const RATIO = Number(process.env.JL_RATIO ?? 0.87); // borrowing stops at CF/LT (SPYx 75%/85% = 0.88)
const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());
type Pk = InstanceType<typeof web3.PublicKey>;
const simulated: string[] = [];
const POSITION_DISC = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]);

/** Jupiter's view of a position: collateral (tokens), debt (USDC) from the tick, D/C′ at the cache price. */
async function state(c: Chain, position: Pk, vaultState: Pk, cacheKey: Pk, ltPermille: number) {
  const p = (await c.conn.getAccountInfo(position))!.data;
  const vs = (await c.conn.getAccountInfo(vaultState))!.data;
  const [supEx, borEx] = [vs.readBigUInt64LE(99), vs.readBigUInt64LE(107)];
  const colRaw = p.readBigUInt64LE(55);
  const tick = p.readInt32LE(47);
  const col = Number((colRaw * supEx) / 10n ** 12n) / 1e9; // tokens
  // Fluid: debt_raw = ratio(tick) × (col_raw + 1) >> 48, + 1 (risk-core::fluid).
  const debtRaw = tick > -16383 ? ((BigInt(getRatioAtTick(tick).toString()) * (colRaw + 1n)) >> 48n) + 1n : 0n;
  const debt = Number((debtRaw * borEx) / 10n ** 12n) / 1e9; // USDC
  const px = (await readJlCache(c, cacheKey))!.price;
  return { tick, collateralTokens: col, debtUsdc: debt, price: px, debtToCovered: debt / (col * px * ltPermille / 1000) };
}

function pushAt(sym: string, price: number, t: number) {
  const dir = join(ROOT, 'data/live/pyth');
  const f = readdirSync(dir).filter((x) => x.startsWith(`${sym}-`)).sort().pop()!;
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

function latestRecorded(asset: string): bigint | null {
  try {
    const lines = readFileSync(join(ROOT, 'data/jupiter/oracle-weekend.jsonl'), 'utf8').trim().split('\n').reverse();
    for (const l of lines) {
      const j = JSON.parse(l);
      if (j.asset === asset && j.operate) return BigInt(j.operate) * 1000n; // 1e15 → WAD
    }
  } catch { /* no recorder output (a fresh clone): use the fork's cache */ }
  return null;
}

/** Writes Jupiter's Chainlink cache price (WAD) and its refresh time (fork only). */
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

async function main() {
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const t0 = Date.now();
  log(`Jupiter Lend demo on ${c.url} — chain time ${fmtTime(await chainNow(c))}`);
  const asset = (await c.program.account.assetConfig.fetch(pdas.asset(TICKER))) as any;
  const cacheKey = asset.lenderOracle as Pk;
  const vaultConfig = asset.lenderVault as Pk;
  const vcData = (await c.conn.getAccountInfo(vaultConfig))!.data;
  const lt = vcData.readUInt16LE(16);
  const [vaultState] = web3.PublicKey.findProgramAddressSync([Buffer.from('vault_state'), Buffer.from([VAULT_ID & 255, VAULT_ID >> 8])], JL_VAULTS);

  // LP if needed, epochs.
  const v0 = await c.program.account.vault.fetch(pdas.vault());
  if (BigInt(v0.equity.toString()) < 500_000_000_000n) {
    const lp = web3.Keypair.generate();
    await c.conn.confirmTransaction(await c.conn.requestAirdrop(lp.publicKey, 10e9), 'confirmed');
    await setTokenBalance(c, lp.publicKey.toBase58(), USDC_MINT.toBase58(), 1_000_000_000_000n);
    const { send } = await import('./chain.js');
    await send(c, [createAtaIx(c.payer.publicKey, lp.publicKey, pdas.shares()),
      await c.program.methods.deposit(new BN('1000000000000')).accountsPartial({ depositor: lp.publicKey, vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(),
        depositorUsdc: ata(lp.publicKey, USDC_MINT), depositorShares: ata(lp.publicKey, pdas.shares()), shareEscrow: pdas.shareEscrow() }).instruction()], [lp]);
    simulated.push('An LP wallet deposited 1,000,000 USDC (cheatcode USDC).');
  }
  // Jupiter's cache refreshed to the fork clock (its genuine price), so purchases and Jupiter's own checks see it fresh.
  const now0 = await chainNow(c);
  const fork0 = (await readJlCache(c, cacheKey))!;
  // A rerun on the same fork starts from a genuine price: the read-only recorder's latest reading of Jupiter's oracle
  // (data/jupiter/oracle-weekend.jsonl, operate price ×1e15 for an 8- to 6-decimal vault), else the fork's cache.
  const recorded = latestRecorded(TICKER.replace('.J', ''));
  const cache0 = recorded ? { ...fork0, priceWad: recorded, price: Number(recorded / 10n ** 10n) / 1e8 } : fork0;
  await writeCache(c, cacheKey, cache0.priceWad, now0);
  simulated.push(`Jupiter's ${TICKER.replace('.J', '')} Chainlink cache keeps its genuine price ${cache0.price.toFixed(4)}; its refresh time is moved to the fork clock at each step.`);
  await tick(c);
  const epochs = (await c.program.account.epoch.all()) as { publicKey: Pk; account: any }[];
  const ep = epochs.filter((e) => tickerStr(e.account.ticker) === TICKER && e.account.state === EPOCH.OPEN && n(e.account.bell) > now0 && n(e.account.saleOpen) <= now0)
    .sort((a, b) => a.account.closureId - b.account.closureId)[0];
  if (!ep) throw new Error(`no ${TICKER} epoch on sale now`);
  const group = ep.account.closureId as number;
  const [close, open] = [n(ep.account.close), n(ep.account.open)];
  log(`weekend ${group}: close ${fmtTime(close)}, open ${fmtTime(open)}`);

  // 1. A real position: the largest SPYx/USDC position with debt; its NFT moved to a demo owner.
  const all = await c.conn.getProgramAccounts(JL_VAULTS, { filters: [
    { memcmp: { offset: 0, bytes: POSITION_DISC.toString('base64'), encoding: 'base64' } } as never,
    { memcmp: { offset: 8, bytes: Buffer.from([VAULT_ID & 255, VAULT_ID >> 8]).toString('base64'), encoding: 'base64' } } as never] });
  const pick = all.filter(({ account: { data: d } }) => d[46] === 0 && d.readInt32LE(47) > -16383 && d.readBigUInt64LE(55) > 0n)
    .sort((a, b) => Number(b.account.data.readBigUInt64LE(55) - a.account.data.readBigUInt64LE(55)))[Number(process.env.JL_PICK ?? 0)];
  const position = pick.pubkey;
  const ids = (await positionIds(c, position))!;
  const holders = await c.conn.getTokenLargestAccounts(ids.mint);
  const nftAcc = holders.value[0].address;
  const nftInfo = (await c.conn.getAccountInfo(nftAcc))!;
  const realOwner = new web3.PublicKey(nftInfo.data.subarray(32, 64));
  const owner = web3.Keypair.generate();
  await c.conn.confirmTransaction(await c.conn.requestAirdrop(owner.publicKey, 10e9), 'confirmed');
  await setTokenBalance(c, owner.publicKey.toBase58(), USDC_MINT.toBase58(), 10_000_000_000n);
  // The SDK expects the NFT in the owner's ATA: give the demo owner an ATA holding it, and empty the real holder's.
  const nftAta = web3.PublicKey.findProgramAddressSync([owner.publicKey.toBuffer(), nftInfo.owner.toBuffer(), ids.mint.toBuffer()], pk('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'))[0];
  const d1 = Buffer.from(nftInfo.data);
  owner.publicKey.toBuffer().copy(d1, 32);
  await setAccount(c, nftAta.toBase58(), { lamports: nftInfo.lamports, data: d1, owner: nftInfo.owner.toBase58() });
  const d0 = Buffer.from(nftInfo.data);
  d0.writeBigUInt64LE(0n, 64);
  await setAccount(c, nftAcc.toBase58(), { lamports: nftInfo.lamports, data: d0, owner: nftInfo.owner.toBase58() });
  simulated.push(`The real Jupiter Lend position ${position.toBase58()} (#${ids.nftId}, vault ${VAULT_ID}; NFT held by ${realOwner.toBase58()} on mainnet) had its NFT moved to the demo wallet ${owner.publicKey.toBase58()} by cheatcode; collateral and debt are mainnet's.`);
  const s0 = await state(c, position, vaultState, cacheKey, lt);
  const extra = BigInt(Math.floor((s0.debtUsdc * RATIO / s0.debtToCovered - s0.debtUsdc) * 1e6));
  if (extra > 0n) {
    const op = await getOperateIx({ vaultId: VAULT_ID, positionId: ids.nftId, colAmount: new BN(0), debtAmount: new BN(extra.toString()),
      connection: c.conn, signer: owner.publicKey, positionOwner: owner.publicKey, market: 'main', includeATASetup: true } as never);
    const r = await sendV0(c, op.ixs, op.addressLookupTableAccounts, [owner]);
    log(`  ok   Jupiter Lend borrow ${(Number(extra) / 1e6).toFixed(2)} USDC more (${r.cu} CU)`);
  }
  const s1 = await state(c, position, vaultState, cacheKey, lt);
  log(`position ${position.toBase58().slice(0, 8)}… #${ids.nftId}: ${s1.collateralTokens.toFixed(4)} SPYx, debt ${s1.debtUsdc.toFixed(2)} USDC, D/C′ ${s1.debtToCovered.toFixed(4)} (tick ${s1.tick})`);

  // 1b. Friday: Jupiter's price falls PREDROP before the purchase (SIMULATED move, the cache keeps it at the close).
  const fridayWad = (cache0.priceWad * BigInt(Math.round((1 + PREDROP) * 1e6))) / 1_000_000n;
  await writeCache(c, cacheKey, fridayWad, await chainNow(c));
  simulated.push(`Friday before the purchase: Jupiter's SPYx cache set ${(PREDROP * 100).toFixed(1)}% from its genuine price (borrowing stops at D/C′ = CF/LT, so a position nears its threshold by falling prices).`);
  const s1b = await state(c, position, vaultState, cacheKey, lt);
  log(`Friday ${(PREDROP * 100).toFixed(1)}%: D/C′ ${s1b.debtToCovered.toFixed(4)}`);

  // 2. buy_cover_jl, cap = the debt.
  const v1 = await c.program.account.vault.fetch(pdas.vault());
  const debtBase = BigInt(Math.floor(s1.debtUsdc * 1e6)) - 10n; // the cap: the debt, just under the program's rounding
  const [posTick] = web3.PublicKey.findProgramAddressSync([Buffer.from('tick'), Buffer.from([VAULT_ID & 255, VAULT_ID >> 8]), (() => { const b = Buffer.alloc(4); b.writeUInt32LE(s1.tick + 16383); return b; })()], JL_VAULTS);
  const policy = pdas.policy(ep.publicKey, position);
  await writeCache(c, cacheKey, fridayWad, await chainNow(c));
  const ix = await c.program.methods.buyCoverJl([...Buffer.from(TICKER.padEnd(8, '\0'))], group, new BN(debtBase.toString()), new BN('50000000000'))
    .accountsPartial({ buyer: owner.publicKey, asset: pdas.asset(TICKER), scenarios: pdas.scen(TICKER), epoch: ep.publicKey, loss: pdas.loss(group),
      vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), feeAccount: v1.feeAccount, buyerUsdc: ata(owner.publicKey, USDC_MINT), position,
      positionTokenAccount: nftAta, vaultConfig, vaultState, positionTick: posTick, cache: cacheKey, policy, tokenProgram: TOKEN })
    .instruction();
  const bought = await sendV0(c, [ix], [], [owner]);
  const p0 = await c.program.account.policy.fetch(policy);
  log(`cover bought on ${TICKER}: C′ ${(n(p0.coveredValue) / 1e6).toFixed(2)}, D ${(n(p0.debt) / 1e6).toFixed(2)}, cap ${(n(p0.maxPayout) / 1e6).toFixed(2)}, premium ${(n(p0.premium) / 1e6).toFixed(2)} USDC (shield loading ${(n(p0.shieldLoading) / 1e6).toFixed(2)}), ${bought.cu} CU`);

  // 3. Friday close: the cache at its own price, refreshed at the close.
  await timeTravel(c, close + 30);
  await writeCache(c, cacheKey, fridayWad, close + 20);
  await tick(c);
  const e1 = await c.program.account.epoch.fetch(ep.publicKey);
  if (e1.state !== EPOCH.CLOSED) throw new Error('the close was not stored');
  const closePx = Number(BigInt(e1.closePriceWad.toString()) / 10n ** 10n) / 1e8;

  // 4. Sunday 20:30 ET: the SPYx push account at fair value; keeper shields.
  const sunday = open - 13 * 3600;
  await timeTravel(c, sunday);
  const push = pushAt(TICKER.replace('.J', ''), closePx * (1 + FAIR), sunday - 120);
  await setAccount(c, pushAccount(asset.feedXstock).toBase58(), { lamports: push.lamports, data: push.data, owner: push.owner });
  simulated.push(`Sunday ${fmtTime(sunday)}: the SPYx push account holds the genuine recorded update ${push.file} with its price set to ${(closePx * (1 + FAIR)).toFixed(4)} (${(FAIR * 100).toFixed(1)}% from the close).`);
  await writeCache(c, cacheKey, fridayWad, sunday);
  const rShield = await tick(c);
  const p1 = await c.program.account.policy.fetch(policy);
  const advanced = n(p1.advanced) / 1e6;
  const s2 = await state(c, position, vaultState, cacheKey, lt);
  log(`Sunday: shield advanced ${advanced.toFixed(2)} USDC into the Jupiter Lend position; debt ${s2.debtUsdc.toFixed(2)}, D/C′ ${s2.debtToCovered.toFixed(4)}`);

  // 5. Monday open: Jupiter's cache moves; settlement.
  await timeTravel(c, open + 75);
  const openWad = (fridayWad * BigInt(Math.round((1 + OPEN) * 1e6))) / 1_000_000n;
  await writeCache(c, cacheKey, openWad, open + 70);
  simulated.push(`Monday ${fmtTime(open + 70)}: Jupiter's Chainlink cache SPYx set ${(OPEN * 100).toFixed(1)}% from the close (Jupiter's own health and Credence's settlement read it).`);
  const s3pre = await state(c, position, vaultState, cacheKey, lt);
  const rSettle = await tick(c);
  const p2 = await c.program.account.policy.fetch(policy);
  const s3 = await state(c, position, vaultState, cacheKey, lt);
  const payout = n(p2.payout) / 1e6;
  log(`open: settled; payout ${payout.toFixed(2)} USDC in total (advance ${advanced.toFixed(2)} + remainder ${(payout - advanced).toFixed(2)}); D/C′ ${s3pre.debtToCovered.toFixed(4)} → ${s3.debtToCovered.toFixed(4)}`);

  const result = {
    ranAt: new Date().toISOString(), seconds: Math.round((Date.now() - t0) / 1000), group, ticker: TICKER, vaultId: VAULT_ID, fair: FAIR, open: OPEN,
    chainTime: { close: fmtTime(close), shield: fmtTime(sunday), open: fmtTime(open) },
    position: position.toBase58(), nftId: ids.nftId,
    policy: { address: policy.toBase58(), premiumUsdc: n(p0.premium) / 1e6, shieldLoadingUsdc: n(p0.shieldLoading) / 1e6, capUsdc: n(p0.maxPayout) / 1e6,
      coveredValueUsdc: n(p0.coveredValue) / 1e6, debtUsdc: n(p0.debt) / 1e6, reservedUsdc: n(p0.worstLoss) / 1e6, advancedUsdc: advanced, payoutUsdc: payout,
      remainderUsdc: +(payout - advanced).toFixed(6), state: p2.state, buyCu: bought.cu },
    stages: { before: s0, borrowedUp: s1, bought: s1b, afterShield: s2, atOpen: s3pre, afterSettlement: s3 },
    keeper: { shieldPass: { sent: rShield.sent, failed: rShield.failed }, settlePass: { sent: rSettle.sent, failed: rSettle.failed } },
    real: [
      'Jupiter Lend (Vaults, Liquidity, Oracle programs and every vault account) cloned from mainnet; the position, its collateral and debt are mainnet\'s',
      'the extra borrow is a real Jupiter Lend operate signed by the demo owner',
      'credence_core built from this repo: buy_cover_jl (snapshot from the position, its tick and Jupiter\'s cache), shield_advance_jl and settle_policy_jl (operate CPI signed by the vault PDA)',
    ],
    simulated: ['the clock (surfpool time travel)', 'USDC and SOL of the demo wallets (cheatcodes)', ...simulated],
  };
  mkdirSync(join(ROOT, 'data/demo'), { recursive: true });
  writeFileSync(join(ROOT, 'data/demo/jl-result.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(`\n================ Jupiter Lend demo, weekend ${group} ================`);
  console.log(`position ${position.toBase58()} (#${ids.nftId}, vault ${VAULT_ID}): D/C′ ${s1.debtToCovered.toFixed(4)}; premium ${result.policy.premiumUsdc.toFixed(2)} USDC; shield ${advanced.toFixed(2)}; total payout ${payout.toFixed(2)} USDC`);
  console.log('simulated:'); for (const s of result.simulated) console.log(`  - ${s}`);
  console.log(`@@result ${JSON.stringify(result)}`);
  const ok = p2.state === 1 && rSettle.failed.length === 0 && rShield.failed.length === 0 && advanced > 0;
  if (!ok) { console.error('JL DEMO FAILED'); process.exit(1); }
}
main().catch((e) => { console.error(e); process.exit(1); });
