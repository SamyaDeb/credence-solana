// Task 1.5: upload data/onchain/ to a cluster (default: local fork) and verify it hash-matches the files.
// Idempotent: skips anything already finalised. Admin = ~/.config/solana/id.json.
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
const WEEKEND = 2;
const WAD = 10n ** 18n;
const wad = (x: number) => new BN((BigInt(Math.round(x * 1e6)) * WAD / 1_000_000n).toString());

/** Phase 1 parameters (demo values; see plan/02 §2–3). */
const CONFIG = {
  uMaxWad: wad(0.5),
  maxAssetShareWad: wad(0.5),
  thetaWad: wad(0.2),
  costOfCapWad: wad(0.1),
  etaWad: wad(1),
  betaWad: wad(0.975),
  kappaWad: wad(0), // Gap Payout has no liquidation cost (plan/02 §2, "Mapping the payout rule")
  minPremium: new BN(1_000_000),
  feeBps: 0,
  maxConfBps: 50, // Pyth conf ≤ 0.5% of price
  xcheckBps: 200, // equity × multiplier within 2% of Crypto.<T>X/USD
  // Friday close window. 60 s for equity feeds; the XSTOCK fallback (push accounts every 20–60 min) needs 3600.
  closeWindowSecs: Number(process.env.CLOSE_WINDOW_SECS ?? 60),
};
/** EQUITY = 0 (plan), XSTOCK = 1 (fallback while the Hermes key lacks equity entitlement, plan/06). */
const SETTLE_SOURCE = Number(process.env.SETTLE_SOURCE ?? 1);

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
    }

    for (const a of assets) {
      const params = {
        feedEquity: hex32(a.feeds.equity), feedXstock: hex32(a.feeds.xstock), feedRedemption: hex32(a.feeds.redemption),
        kaminoReserves: a.kaminoReserves.map((k: string) => new web3.PublicKey(k)),
        sigmaWad: new BN(a.sigmaWad), dividendWad: new BN(a.dividendWad), jointColumn: a.jointColumn, enabled: true, settleSource: SETTLE_SOURCE,
      };
      if (!(await conn.getAccountInfo(pdas.asset(a.ticker)))) {
        await m.addAsset(ticker8(a.ticker), params)
          .accountsPartial({ admin, config: pdas.config(), asset: pdas.asset(a.ticker), mint: new web3.PublicKey(a.mint), tokenProgram: TOKEN_2022 })
          .rpc();
        console.log(`${a.ticker}: asset added`);
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
