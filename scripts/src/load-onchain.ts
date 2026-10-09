// Task 1.5: upload data/onchain/ to a cluster (default: local fork) and verify it hash-matches the files: config,
// assets, scenario sets, joint set and gap factors; then (task 3.2) the XNYS calendar and the vault, whose fee account
// is the admin's USDC associated token account. Idempotent: skips anything already finalised or created.
// Admin = ~/.config/solana/id.json.
// Usage: pnpm tsx src/load-onchain.ts [--verify-only]
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import { ROOT, connect, cuLimit, pdas, ticker8 } from './lib/credence.js';

const USDC_MINT = new web3.PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const TOKEN = new web3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const TOKEN_2022 = new web3.PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
const ATA = new web3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const WEEKEND = 2;
const WAD = 10n ** 18n;
const wad = (x: number) => new BN((BigInt(Math.round(x * 1e6)) * WAD / 1_000_000n).toString());

/** PYUSD (Token-2022, 6 decimals): the Sentora xStocks Market's borrowable stablecoin. */
const PYUSD_MINT = new web3.PublicKey('2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo');
/** Phase 1 parameters. θ 1.0 and the 5 USDC minimum premium were picked from the Day 5 pricing sweep (README,
 * Measured), together with the σ floor in gen-onchain.ts. Before: θ 0.2, minimum 1 USDC. */
const CONFIG = {
  uMaxWad: wad(0.5),
  maxAssetShareWad: wad(0.5),
  thetaWad: wad(1.0),
  costOfCapWad: wad(0.1),
  etaWad: wad(1),
  betaWad: wad(0.975),
  kappaWad: wad(0), // Gap Payout has no liquidation cost
  minPremium: new BN(5_000_000),
  feeBps: 0,
  maxConfBps: 50, // Pyth conf ≤ 0.5% of price
  xcheckBps: 200, // equity × multiplier within 2% of Crypto.<T>X/USD
  // EQUITY: Friday close window (60 s). XSTOCK (push accounts, 14.5-min heartbeat): close and open windows.
  closeWindowSecs: Number(process.env.CLOSE_WINDOW_SECS ?? 60),
  xstockSettleWindowSecs: Number(process.env.XSTOCK_SETTLE_WINDOW_SECS ?? 3600),
  // Liquidation Shield (W1, plan/06): α 50% of the cap, buffer 2%, no extra health margin, λ 2 (= 1 + θ), fair values
  // up to 36 h old (weekend pushes are deviation-driven), window Sunday 20:00 ET → Monday 07:00 ET before a 09:30 open.
  shieldAlphaWad: wad(Number(process.env.SHIELD_ALPHA ?? 0.5)),
  shieldBufferWad: wad(Number(process.env.SHIELD_BUFFER ?? 0.02)),
  shieldHealthWad: wad(Number(process.env.SHIELD_HEALTH ?? 0)),
  shieldLambdaWad: wad(Number(process.env.SHIELD_LAMBDA ?? 2)),
  shieldMaxAgeSecs: 36 * 3600,
  shieldStartBeforeOpenSecs: 48_600,
  shieldDeadlineBeforeOpenSecs: 9_000,
  // Task 1.2: capacity reserves the shield's own advance at a fair value k·σ_b below each joint scenario's gap.
  shieldReserveKWad: wad(Number(process.env.SHIELD_RESERVE_K ?? 2)),
  // Interest a covered debt may accrue before the open that the shield and settlement count (and premiums price).
  debtGrowthCapWad: wad(Number(process.env.DEBT_GROWTH_CAP ?? 0.005)),
  // ...and premiums price the expected interest: the USDC reserve's 5.5% borrow APY over a week (Oct 9).
  debtGrowthEstWad: wad(Number(process.env.DEBT_GROWTH_EST ?? 0.001)),
  // W4: PYUSD debt (the Sentora xStocks Market) is covered and paid in PYUSD from the vault's sleeve; fund_sleeve pays
  // at most klend's PYUSD price + 30 bps for it.
  pyusdMint: PYUSD_MINT,
  sleeveSlippageBps: Number(process.env.SLEEVE_SLIPPAGE_BPS ?? 30),
};
/** Monday Backstop (W2): open inventory ≤ 25% of equity at cost, NAV mark at Scope − 10%, INV-8's committed price at
 * Scope − 15%, auction from Scope + 2% to Scope − 5% over 2 h, Scope prices at most 5 minutes old. */
const BACKSTOP = {
  maxShareWad: wad(0.25), haircutWad: wad(0.1), maxDiscountWad: wad(0.15), salePremiumWad: wad(0.02), saleDiscountWad: wad(0.05),
  saleSecs: 7_200, maxPriceAgeSecs: 300,
};
/** σ_b per asset from the basis study (scripts/src/shield-basis.ts → data/shield-basis.json); 1% where it has no
 * estimate (conservative: a larger σ_b prices a larger shield loading). */
const basisSigmaWad = (ticker: string): string => {
  try {
    const b = JSON.parse(readFileSync(join(ROOT, 'data/shield-basis.json'), 'utf8'));
    const s = b.assets?.[ticker]?.sigmaBUsed;
    if (typeof s === 'number' && s > 0) return wad(s).toString();
  } catch { /* no study yet */ }
  return wad(0.01).toString();
};
/** EQUITY = 0 (the design; needs a Pyth Pro equities plan), XSTOCK = 1 (Pyth push accounts), SCOPE = 2 (Kamino's own oracle:
 * Chainlink Data Streams + Pyth Pro, free; the default since Oct 8). */
const SETTLE_SOURCE = Number(process.env.SETTLE_SOURCE ?? 2);

const onchain = (f: string) => JSON.parse(readFileSync(join(ROOT, 'data/onchain', f), 'utf8'));
const sha256I16 = (...cols: number[][]) => {
  const h = createHash('sha256');
  for (const c of cols) {
    const b = Buffer.alloc(c.length * 2);
    c.forEach((v, i) => b.writeInt16LE(v, i * 2));
    h.update(b);
  }
  return h.digest('hex');
};
const hex32 = (h: string) => [...Buffer.from(h, 'hex')];

async function main() {
  const verifyOnly = process.argv.includes('--verify-only');
  const { program, wallet, conn } = connect();
  const admin = wallet.publicKey;
  const acct = program.account as any;
  const m = program.methods as any;
  // Jupiter Lend alias assets (W12): `<T>.J` covers Jupiter Lend positions of <T>, with <T>'s scenarios and joint
  // column (netted in one loss vector) and settled on Jupiter's own oracle (source JUPITER = 3).
  const base = onchain('assets.json');
  const assets = [
    ...base.map((a: any) => ({ ...a, scen: a.ticker })),
    ...base.filter((a: any) => a.jupiter).map((a: any) => ({ ...a, ticker: `${a.ticker}.J`, scen: a.ticker, alias: true,
      kaminoReserves: [web3.PublicKey.default.toBase58(), web3.PublicKey.default.toBase58()] })),
  ];
  // Joint set v2 (W11/W16): both tails, Kamino's eight xStocks; v1 (down only, three assets) is superseded.
  const joint = onchain('joint-v2.json');

  if (!verifyOnly) {
    if (!(await conn.getAccountInfo(pdas.config()))) {
      await m.initConfig({ guardian: admin, keeper: admin, ...CONFIG })
        .accountsPartial({ admin, config: pdas.config(), usdcMint: USDC_MINT, tokenProgram: TOKEN }).rpc();
      console.log('config initialised');
    } else {
      const c = await acct.config.fetch(pdas.config());
      const changed = Object.entries(CONFIG).some(([k, v]) => String(c[k]) !== String(v));
      if (changed) {
        await m.setParams({ guardian: c.guardian, keeper: c.keeper, ...CONFIG }).accountsPartial({ admin, config: pdas.config() }).rpc();
        console.log('config parameters updated (set_params)');
      }
    }

    for (const a of assets) {
      const params = {
        feedEquity: hex32(a.feeds.equity), feedXstock: hex32(a.feeds.xstock), feedRedemption: hex32(a.feeds.redemption),
        kaminoReserves: a.kaminoReserves.map((k: string) => new web3.PublicKey(k)),
        sigmaWad: new BN(a.sigmaWad), dividendWad: new BN(a.dividendWad), jointColumn: a.jointColumn, enabled: true,
        settleSource: a.alias ? 3 : SETTLE_SOURCE, scopeChain: a.scopeChain,
        basisSigmaWad: new BN(basisSigmaWad(a.scen)),
      };
      if (!(await conn.getAccountInfo(pdas.asset(a.ticker)))) {
        await m.addAsset(ticker8(a.ticker), params)
          .accountsPartial({ admin, config: pdas.config(), asset: pdas.asset(a.ticker), mint: new web3.PublicKey(a.mint), tokenProgram: TOKEN_2022 })
          .rpc();
        console.log(`${a.ticker}: asset added`);
        if (a.alias) {
          await m.setAssetLender(ticker8(a.ticker))
            .accountsPartial({ admin, config: pdas.config(), asset: pdas.asset(a.ticker),
              lenderVault: new web3.PublicKey(a.jupiter.vaultConfig), lenderOracleConfig: new web3.PublicKey(a.jupiter.oracle) })
            .rpc();
          console.log(`${a.ticker}: Jupiter Lend asset (vault ${a.jupiter.vaultConfig})`);
        }
      } else {
        const cur = await acct.assetConfig.fetch(pdas.asset(a.ticker));
        if (cur.sigmaWad.toString() !== a.sigmaWad || cur.basisSigmaWad.toString() !== params.basisSigmaWad.toString()) {
          // Keep what an admin set on the live asset (audit A-27): a σ or σ_b refresh must not re-enable a disabled asset
          // or reset its settlement source.
          Object.assign(params, { enabled: cur.enabled === 1, settleSource: Number(cur.settleSource.toString()) });
          // σ changed (e.g. the σ floor): update_asset resets the gap factors; compute_gap_factors below recomputes them.
          // σ_b alone (the basis study) leaves them as they are.
          await m.updateAsset(ticker8(a.ticker), params).accountsPartial({ admin, config: pdas.config(), asset: pdas.asset(a.ticker) }).rpc();
          console.log(`${a.ticker}: σ ${a.sigmaWad}, σ_b ${params.basisSigmaWad} (update_asset)`);
        }
      }

      const scen = onchain(`${a.scen}-WEEKEND.json`);
      const set = pdas.scen(a.ticker, WEEKEND);
      const existing = await acct.scenarioSet.fetchNullable(set);
      if (!existing) {
        await m.initScenarioSet(ticker8(a.ticker), WEEKEND, scen.n).accountsPartial({ admin, config: pdas.config(), set }).rpc();
      }
      if (!existing || existing.finalized === 0) {
        for (let off = 0; off < scen.n; off += 400) {
          await m.writeScenarios(off, scen.z.slice(off, off + 400)).accountsPartial({ admin, config: pdas.config(), set }).rpc();
        }
        await m.finalizeScenarioSet(hex32(scen.sha256))
          .accountsPartial({ admin, config: pdas.config(), set, asset: pdas.asset(a.ticker) }).rpc();
        console.log(`${a.ticker}: scenario set uploaded (${scen.n})`);
      }
      // W11: the OVERNIGHT and HOLIDAY_WEEKEND sets and their σ (Kamino assets; Jupiter aliases sell weekends).
      if (a.alias) continue;
      for (const [name, ct] of [['OVERNIGHT', 1], ['HOLIDAY_WEEKEND', 3]] as const) {
        const f = onchain(`${a.scen}-${name}.json`);
        const tset = pdas.scen(a.ticker, ct);
        const ex = await acct.scenarioSet.fetchNullable(tset);
        if (!ex) await m.initScenarioSet(ticker8(a.ticker), ct, f.n).accountsPartial({ admin, config: pdas.config(), set: tset }).rpc();
        if (!ex || ex.finalized === 0) {
          for (let off = 0; off < f.n; off += 400) {
            await m.writeScenarios(off, f.z.slice(off, off + 400)).accountsPartial({ admin, config: pdas.config(), set: tset }).rpc();
          }
          await m.finalizeScenarioSet(hex32(f.sha256)).accountsPartial({ admin, config: pdas.config(), set: tset, asset: pdas.asset(a.ticker) }).rpc();
        }
        if (!ex || ex.sigmaWad.toString() !== f.sigmaWad) {
          await m.setScenarioSigma(new BN(f.sigmaWad)).accountsPartial({ admin, config: pdas.config(), set: tset }).rpc();
          console.log(`${a.ticker}: ${name} set (${f.n}), σ ${f.sigmaWad}`);
        }
      }
    }

    const jset = pdas.joint(joint.version);
    const jex = await acct.jointSet.fetchNullable(jset);
    if (!jex) {
      await m.initJointSet(joint.version, joint.tickers.map(ticker8)).accountsPartial({ admin, config: pdas.config(), set: jset }).rpc();
    }
    if (!jex || jex.finalized === 0) {
      for (let c = 0; c < joint.columns.length; c++) {
        await m.writeJoint(c, 0, joint.columns[c]).accountsPartial({ admin, config: pdas.config(), set: jset }).rpc();
      }
      await m.finalizeJointSet(hex32(joint.sha256)).accountsPartial({ admin, config: pdas.config(), set: jset }).rpc();
      console.log('joint set uploaded');
    }

    for (const a of assets) {
      const st = await acct.assetConfig.fetch(pdas.asset(a.ticker));
      if (st.gfCount === 256 && st.gfSigmaWad.toString() === a.sigmaWad && st.jointSet.equals(jset)) continue;
      for (let start = 0; start < 256; start += 128) {
        await m.computeGapFactors(start, 128)
          .accountsPartial({ admin, config: pdas.config(), asset: pdas.asset(a.ticker), joint: jset })
          .preInstructions([cuLimit()]).rpc();
      }
      console.log(`${a.ticker}: gap factors computed`);
    }
  }

  if (!verifyOnly) {
    const cal = onchain('calendar-XNYS.json');
    const calKey = pdas.calendar();
    const cex = await acct.calendar.fetchNullable(calKey);
    if (!cex) {
      await m.initCalendar([...Buffer.from('XNYS\0\0\0\0')], cal.sessions.length).accountsPartial({ admin, calendar: calKey }).rpc();
    }
    if (!cex || cex.finalized === 0) {
      for (let off = 0; off < cal.sessions.length; off += 40) {
        const chunk = cal.sessions.slice(off, off + 40).map((x: { date: number; open: number; close: number }) => ({
          date: x.date, open: new BN(x.open), close: new BN(x.close),
        }));
        await m.writeCalendar(off, chunk).accountsPartial({ admin, calendar: calKey }).rpc();
      }
      await m.finalizeCalendar(hex32(cal.sha256)).accountsPartial({ admin, calendar: calKey }).rpc();
      console.log(`calendar uploaded (${cal.sessions.length} sessions, sha256 ${cal.sha256})`);
    }
    if (!(await conn.getAccountInfo(pdas.vault()))) {
      const feeAta = web3.PublicKey.findProgramAddressSync([admin.toBuffer(), TOKEN.toBuffer(), USDC_MINT.toBuffer()], ATA)[0];
      const createFee = new web3.TransactionInstruction({
        programId: ATA, data: Buffer.from([1]),
        keys: [
          { pubkey: admin, isSigner: true, isWritable: true }, { pubkey: feeAta, isSigner: false, isWritable: true },
          { pubkey: admin, isSigner: false, isWritable: false }, { pubkey: USDC_MINT, isSigner: false, isWritable: false },
          { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: TOKEN, isSigner: false, isWritable: false },
        ],
      });
      await m.initVault()
        .accountsPartial({
          admin, vault: pdas.vault(), vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), shareEscrow: pdas.shareEscrow(),
          usdcMint: USDC_MINT, feeAccount: feeAta, tokenProgram: TOKEN,
        })
        .preInstructions([createFee]).rpc();
      console.log(`vault initialised (fee account ${feeAta.toBase58()})`);
    }

    // Monday Backstop (W2): the pool and one inventory per asset listed in the xStocks Market, holding units in the
    // vault PDA's ATAs (Token-2022 for the xStock, SPL Token for the reserve's cToken).
    const pool = new web3.PublicKey(web3.PublicKey.findProgramAddressSync([Buffer.from('backstop')], program.programId)[0]);
    if (!(await conn.getAccountInfo(pool))) {
      await m.initBackstop(BACKSTOP).accountsPartial({ admin, config: pdas.config(), pool }).rpc();
      console.log('backstop pool initialised');
    }
    const ataIx = (owner: InstanceType<typeof web3.PublicKey>, mint: InstanceType<typeof web3.PublicKey>, prog: InstanceType<typeof web3.PublicKey>) => new web3.TransactionInstruction({
      programId: ATA, data: Buffer.from([1]),
      keys: [
        { pubkey: admin, isSigner: true, isWritable: true },
        { pubkey: web3.PublicKey.findProgramAddressSync([owner.toBuffer(), prog.toBuffer(), mint.toBuffer()], ATA)[0], isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: web3.SystemProgram.programId, isSigner: false, isWritable: false }, { pubkey: prog, isSigner: false, isWritable: false },
      ],
    });
    for (const a of assets) {
      if (a.alias) continue; // a Jupiter alias holds no inventory: the backstop liquidates on Kamino (W2)
      const inv = web3.PublicKey.findProgramAddressSync([Buffer.from('inventory'), Buffer.from(ticker8(a.ticker))], program.programId)[0];
      if (await conn.getAccountInfo(inv)) continue;
      const st = await acct.assetConfig.fetch(pdas.asset(a.ticker));
      const reserve = (st.kaminoReserves as InstanceType<typeof web3.PublicKey>[])[0];
      const r = await conn.getAccountInfo(reserve);
      if (!r) { console.log(`${a.ticker}: no xStocks Market reserve on this cluster, no inventory`); continue; }
      const cMint = new web3.PublicKey(r.data.subarray(2560, 2592)); // Reserve.collateral.mint_pubkey (kamino.rs layout)
      const vault = pdas.vault();
      const mint = new web3.PublicKey(a.mint);
      await m.initInventory(ticker8(a.ticker))
        .accountsPartial({
          admin, config: pdas.config(), asset: pdas.asset(a.ticker), vault, inventory: inv, reserve,
          tokens: web3.PublicKey.findProgramAddressSync([vault.toBuffer(), TOKEN_2022.toBuffer(), mint.toBuffer()], ATA)[0],
          ctokens: web3.PublicKey.findProgramAddressSync([vault.toBuffer(), TOKEN.toBuffer(), cMint.toBuffer()], ATA)[0],
          tokenProgram: TOKEN, token2022Program: TOKEN_2022,
        })
        .preInstructions([ataIx(vault, mint, TOKEN_2022), ataIx(vault, cMint, TOKEN)]).rpc();
      console.log(`${a.ticker}: backstop inventory initialised`);
    }

    // Yield vault (W3): idle cash above the buffer is lent to the xStocks Market USDC reserve; 10% of cover equity stays
    // cash on top of the buffer for cover sold between rebalances.
    const vs = await acct.vault.fetch(pdas.vault());
    if (vs.yieldReserve.equals(web3.PublicKey.default)) {
      const USDC_RESERVE = new web3.PublicKey('97zoywd8mPZsGTg8q1wdD2Wgkdrs2tqusp1Qqcxbyj7E');
      const r = await conn.getAccountInfo(USDC_RESERVE);
      if (r) {
        const cMint = new web3.PublicKey(r.data.subarray(2560, 2592)); // Reserve.collateral.mint_pubkey
        const vault = pdas.vault();
        await m.setYieldReserve(wad(Number(process.env.CASH_HEADROOM ?? 0.1)))
          .accountsPartial({ admin, vault, reserve: USDC_RESERVE,
            kusdc: web3.PublicKey.findProgramAddressSync([vault.toBuffer(), TOKEN.toBuffer(), cMint.toBuffer()], ATA)[0], tokenProgram: TOKEN })
          .preInstructions([ataIx(vault, cMint, TOKEN)]).rpc();
        console.log('yield reserve set (xStocks Market USDC)');
      }
    }

    // PYUSD sleeve (W4): the vault PDA's PYUSD ATA (Token-2022) pays PYUSD cover. Funded by the keeper (fund_sleeve).
    const vs2 = await acct.vault.fetch(pdas.vault());
    if (vs2.pyusdSleeve.equals(web3.PublicKey.default) && (await conn.getAccountInfo(PYUSD_MINT))) {
      const vault = pdas.vault();
      const sleeve = web3.PublicKey.findProgramAddressSync([vault.toBuffer(), TOKEN_2022.toBuffer(), PYUSD_MINT.toBuffer()], ATA)[0];
      await m.setPyusdSleeve().accountsPartial({ admin, vault, sleeve, token2022Program: TOKEN_2022 })
        .preInstructions([ataIx(vault, PYUSD_MINT, TOKEN_2022)]).rpc();
      console.log(`PYUSD sleeve set (${sleeve.toBase58()})`);
    }
  }

  // Verify: recompute hashes from on-chain values and compare with the files.
  let ok = true;
  for (const a of assets) {
    const s = await acct.scenarioSet.fetch(pdas.scen(a.ticker, WEEKEND));
    const z = (s.z as number[]).slice(0, s.n);
    const file = onchain(`${a.scen}-WEEKEND.json`);
    const chain = sha256I16(z);
    const st = await acct.assetConfig.fetch(pdas.asset(a.ticker));
    const good = chain === file.sha256 && Buffer.from(s.hash).toString('hex') === file.sha256 && s.finalized === 1
      && st.gfCount === 256 && st.sigmaWad.toString() === a.sigmaWad && st.scenarioSet.equals(pdas.scen(a.ticker, WEEKEND));
    ok &&= good;
    console.log(`${good ? 'OK  ' : 'FAIL'} ${a.ticker} scenarios sha256 ${chain} (file ${file.sha256}) gf ${st.gfCount}/256 σ ${st.sigmaWad}`);
  }
  const j = await acct.jointSet.fetch(pdas.joint(joint.version));
  const cols = (j.z as number[][]).slice(0, j.nAssets);
  const jchain = sha256I16(...cols);
  const jgood = jchain === joint.sha256 && j.finalized === 1;
  ok &&= jgood;
  console.log(`${jgood ? 'OK  ' : 'FAIL'} joint v${joint.version} sha256 ${jchain} (file ${joint.sha256})`);
  if (!ok) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
