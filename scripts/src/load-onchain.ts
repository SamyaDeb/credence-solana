// Upload data/onchain/ to a cluster (default: local fork) and verify it hash-matches the files: config,
// assets, scenario sets, joint set and gap factors; then the XNYS calendar and the vault, whose fee account
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

/** Phase 1 parameters. θ 1.0 and the 5 USDC minimum premium were picked from the pricing sweep (README,
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
  const assets = onchain('assets.json');
  const joint = onchain('joint-v1.json');

  if (!verifyOnly) {
    if (!(await conn.getAccountInfo(pdas.config()))) {
      await m.initConfig({ guardian: admin, keeper: admin, ...CONFIG })
        .accountsPartial({ admin, config: pdas.config(), usdcMint: USDC_MINT, tokenProgram: TOKEN }).rpc();
      console.log('config initialised');
    } else {
      const c = await acct.config.fetch(pdas.config());
      const changed = Object.entries(CONFIG).some(([k, v]) => String(c[k]) !== String(v));
      if (changed) {
        await m.setParams(CONFIG).accountsPartial({ admin, config: pdas.config() }).rpc();
        console.log('config parameters updated (set_params)');
      }
    }

    for (const a of assets) {
      const params = {
        feedEquity: hex32(a.feeds.equity), feedXstock: hex32(a.feeds.xstock), feedRedemption: hex32(a.feeds.redemption),
        kaminoReserves: a.kaminoReserves.map((k: string) => new web3.PublicKey(k)),
        sigmaWad: new BN(a.sigmaWad), dividendWad: new BN(a.dividendWad), jointColumn: a.jointColumn, enabled: true, settleSource: SETTLE_SOURCE, scopeChain: a.scopeChain,
      };
      if (!(await conn.getAccountInfo(pdas.asset(a.ticker)))) {
        await m.addAsset(ticker8(a.ticker), params)
          .accountsPartial({ admin, config: pdas.config(), asset: pdas.asset(a.ticker), mint: new web3.PublicKey(a.mint), tokenProgram: TOKEN_2022 })
          .rpc();
        console.log(`${a.ticker}: asset added`);
      } else if ((await acct.assetConfig.fetch(pdas.asset(a.ticker))).sigmaWad.toString() !== a.sigmaWad) {
        // σ changed (e.g. the σ floor): update_asset resets the gap factors; compute_gap_factors below recomputes them.
        await m.updateAsset(ticker8(a.ticker), params).accountsPartial({ admin, config: pdas.config(), asset: pdas.asset(a.ticker) }).rpc();
        console.log(`${a.ticker}: σ updated to ${a.sigmaWad} (update_asset)`);
      }

      const scen = onchain(`${a.ticker}-WEEKEND.json`);
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
      if (st.gfCount === 256 && st.gfSigmaWad.toString() === a.sigmaWad) continue;
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
  }

  // Verify: recompute hashes from on-chain values and compare with the files.
  let ok = true;
  for (const a of assets) {
    const s = await acct.scenarioSet.fetch(pdas.scen(a.ticker, WEEKEND));
    const z = (s.z as number[]).slice(0, s.n);
    const file = onchain(`${a.ticker}-WEEKEND.json`);
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
