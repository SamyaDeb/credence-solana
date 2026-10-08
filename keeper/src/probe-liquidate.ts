// W2 gate (fork only): `liquidate_obligation_and_redeem_reserve_collateral_v2` through a PDA-signed cross-program call
// (programs/kamino-probe `liquidate` → credence_core::kamino helper → klend), the probe-program method of task 1.3.
//   1. deploy kamino-probe at its declared id (surfpool cheatcode)
//   2. a fresh wallet opens a real $50k SPYx position at D/C′ 0.96 through klend; Kamino's Scope SPYx price −8%
//      (SIMULATED move) makes it liquidatable
//   3. the probe's PDA (`vault_auth`) gets USDC (cheatcode) and its cToken and SPYx token accounts
//   4. refresh_reserve ×2 + refresh_obligation + probe.liquidate in one transaction
// Prints and writes data/demo/backstop-cpi-probe.json. Usage (fork running, RPC_URL): pnpm tsx src/probe-liquidate.ts
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import anchor from '@anchor-lang/core';
const { web3 } = anchor;
import { FARMS, INSTRUCTIONS_SYSVAR, KLEND, ROOT, SCOPE_PRICES, TOKEN, USDC_MINT, ata, connect, createAtaIx, decodeScope, log, pk, send } from './chain.js';
import { rpc, setTokenBalance } from './fork.js';
import { borrows, deposits, farmUserState, loadObligation, loadReserve, refreshIxs } from './kamino.js';
import { freshPrices, openPosition } from './create-position.js';
import { writeScope } from './weekend.js';

const DEFAULT = '11111111111111111111111111111111';
const w = (pubkey: InstanceType<typeof web3.PublicKey>) => ({ pubkey, isSigner: false, isWritable: true });
const r = (pubkey: InstanceType<typeof web3.PublicKey>) => ({ pubkey, isSigner: false, isWritable: false });

async function main() {
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const idl = JSON.parse(readFileSync(join(ROOT, 'target/idl/kamino_probe.json'), 'utf8'));
  const PROBE = pk(idl.address);
  const so = readFileSync(join(ROOT, 'target/deploy/kamino_probe.so'));
  for (let off = 0; off < so.length; off += 512 * 1024) {
    await rpc(c, 'surfnet_writeProgram', [PROBE.toBase58(), so.subarray(off, off + 512 * 1024).toString('hex'), off, c.payer.publicKey.toBase58()]);
  }
  log(`kamino-probe deployed at ${PROBE.toBase58()} (${so.length} bytes)`);

  // A liquidatable position.
  const owner = web3.Keypair.generate();
  await c.conn.confirmTransaction(await c.conn.requestAirdrop(owner.publicKey, 10e9), 'confirmed');
  const pos = await openPosition(c, owner, 50_000, 0.96);
  const ob = (await loadObligation(c, pos.obligation))!;
  const [withdrawKey] = deposits(ob);
  const [repayKey] = borrows(ob);
  const [withdraw, repay] = [await loadReserve(c, withdrawKey), await loadReserve(c, repayKey)];
  const chain = withdraw.config.tokenInfo.scopeConfiguration.priceChain[0];
  const px = decodeScope((await c.conn.getAccountInfo(SCOPE_PRICES))!.data, chain).price;
  await writeScope(c, [{ chain, price: px * 0.92, ts: Number((await c.conn.getAccountInfo(web3.SYSVAR_CLOCK_PUBKEY))!.data.readBigInt64LE(32)) }]);
  await freshPrices(c);
  log(`position ${pos.obligation.toBase58()}: ${pos.debtUsdc.toFixed(2)} USDC debt; Scope SPYx ${px.toFixed(4)} → ${(px * 0.92).toFixed(4)} (SIMULATED −8%)`);

  // The PDA liquidator's accounts.
  const [auth] = web3.PublicKey.findProgramAddressSync([Buffer.from('vault_auth')], PROBE);
  const xProg = pk(withdraw.liquidity.tokenProgram);
  const src = ata(auth, USDC_MINT), dColl = ata(auth, pk(withdraw.collateral.mintPubkey), TOKEN), dLiq = ata(auth, pk(withdraw.liquidity.mintPubkey), xProg);
  await setTokenBalance(c, auth.toBase58(), USDC_MINT.toBase58(), 100_000_000_000n);
  await send(c, [createAtaIx(c.payer.publicKey, auth, pk(withdraw.collateral.mintPubkey), TOKEN), createAtaIx(c.payer.publicKey, auth, pk(withdraw.liquidity.mintPubkey), xProg)]);
  const bal = async (k: InstanceType<typeof web3.PublicKey>) => BigInt((await c.conn.getTokenAccountBalance(k)).value.amount);
  const [usdc0, x0] = [await bal(src), await bal(dLiq)];
  const debt0 = BigInt(ob.borrows[0].borrowedAmountSf.toString()) >> 60n;

  const lma = web3.PublicKey.findProgramAddressSync([Buffer.from('lma'), pk(ob.lendingMarket).toBuffer()], KLEND)[0];
  const farm = (f: string) => (f === DEFAULT ? KLEND : pk(f));
  const user = (f: string) => (f === DEFAULT ? KLEND : farmUserState(pk(f), pos.obligation));
  const data = Buffer.concat([createHash('sha256').update('global:liquidate').digest().subarray(0, 8), Buffer.alloc(16)]);
  data.writeBigUInt64LE(debt0, 8); // most it will repay; klend applies the close factor
  data.writeBigUInt64LE(0n, 16);
  const ix = new web3.TransactionInstruction({
    programId: PROBE, data,
    keys: [
      r(auth), w(pos.obligation), r(pk(ob.lendingMarket)), r(lma),
      w(repayKey), r(pk(repay.liquidity.mintPubkey)), w(pk(repay.liquidity.supplyVault)),
      w(withdrawKey), r(pk(withdraw.liquidity.mintPubkey)), w(pk(withdraw.collateral.mintPubkey)), w(pk(withdraw.collateral.supplyVault)),
      w(pk(withdraw.liquidity.supplyVault)), w(pk(withdraw.liquidity.feeVault)),
      w(src), w(dColl), w(dLiq),
      r(TOKEN), r(pk(repay.liquidity.tokenProgram)), r(xProg), r(INSTRUCTIONS_SYSVAR),
      ...[user(withdraw.farmCollateral), farm(withdraw.farmCollateral), user(repay.farmDebt), farm(repay.farmDebt)].map((k) => (k.equals(KLEND) ? r(k) : w(k))),
      r(FARMS), r(KLEND),
    ],
  });
  const res = await send(c, [...(await refreshIxs(c, pos.obligation, ob)), ix]);
  const after = (await loadObligation(c, pos.obligation))!;
  const debt1 = BigInt(after.borrows.find((b) => b.borrowReserve === repayKey.toBase58())!.borrowedAmountSf.toString()) >> 60n;
  const out = {
    ranAt: new Date().toISOString(), result: 'PASS: liquidate v2 through a PDA-signed CPI', transactionCu: res.cu, signature: res.sig,
    obligation: pos.obligation.toBase58(), probe: PROBE.toBase58(), liquidatorPda: auth.toBase58(),
    debtUsdc: { before: Number(debt0) / 1e6, after: Number(debt1) / 1e6 },
    pdaPaidUsdc: Number(usdc0 - (await bal(src))) / 1e6, pdaReceivedSpyx: Number((await bal(dLiq)) - x0) / 1e8,
    simulated: ['SPYx deposit and USDC funding by surfpool cheatcode', 'Kamino Scope SPYx price −8% to make the position liquidatable', 'fork clock / Scope refresh times'],
  };
  if (out.pdaPaidUsdc <= 0 || out.pdaReceivedSpyx <= 0 || debt1 >= debt0) throw new Error(`liquidation did not happen: ${JSON.stringify(out)}`);
  mkdirSync(join(ROOT, 'data/demo'), { recursive: true });
  writeFileSync(join(ROOT, 'data/demo/backstop-cpi-probe.json'), JSON.stringify(out, null, 2) + '\n');
  console.log(JSON.stringify(out, null, 2));
}
main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
