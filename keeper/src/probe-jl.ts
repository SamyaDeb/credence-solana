// B2.0 spike (W12, fork only): can a program pay back someone else's Jupiter Lend position through a CPI?
//   1. deploy kamino-probe (its `jl_operate` passes a Vaults `operate` through, signed by its PDA `vault_auth`)
//   2. pick a real SPYx/USDC position with debt on mainnet's Jupiter Lend (largest collateral), owner untouched
//   3. the PDA gets USDC (cheatcode, SIMULATED); `@jup-ag/lend`'s getOperateIx builds a payback of PAYBACK USDC
//      (col 0, debt −PAYBACK) with signer = the PDA and positionOwner = the real owner
//   4. one v0 transaction (Jupiter's lookup tables): probe.jl_operate(data) with operate's accounts as remaining accounts
// Measures the position's debt and the PDA's USDC before and after → data/jupiter/cpi-probe.json.
// Usage (fork running, RPC_URL): pnpm tsx src/probe-jl.ts      PAYBACK=100
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import anchorBn from '@anchor-lang/core';
const BN = anchorBn.BN;
import { getCurrentPosition, getOperateIx } from '@jup-ag/lend/borrow';
import anchor from '@anchor-lang/core';
const { web3 } = anchor;
import { ROOT, USDC_MINT, ata, connect, log, pk } from './chain.js';
import { offlineMissing, rpc, setAccount, setTokenBalance } from './fork.js';
import { redact } from './redact.js';

const VAULTS = pk('jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi');
const VAULT_ID = Number(process.env.JL_VAULT ?? 78); // SPYx / USDC
const PAYBACK = Number(process.env.PAYBACK ?? 100);
const POSITION_DISC = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]);

async function main() {
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const idl = JSON.parse(readFileSync(join(ROOT, 'target/idl/kamino_probe.json'), 'utf8'));
  const PROBE = pk(idl.address);
  const so = readFileSync(join(ROOT, 'target/deploy/kamino_probe.so'));
  for (let off = 0; off < so.length; off += 512 * 1024) {
    await rpc(c, 'surfnet_writeProgram', [PROBE.toBase58(), so.subarray(off, off + 512 * 1024).toString('hex'), off, c.payer.publicKey.toBase58()]);
  }
  const [auth] = web3.PublicKey.findProgramAddressSync([Buffer.from('vault_auth')], PROBE);
  log(`kamino-probe deployed at ${PROBE.toBase58()}; PDA ${auth.toBase58()}`);

  // A real position with debt: the largest collateral in the vault (read from mainnet through the fork).
  const pos = await c.conn.getProgramAccounts(VAULTS, {
    filters: [{ memcmp: { offset: 0, bytes: POSITION_DISC.toString('base64'), encoding: 'base64' } } as never,
      { memcmp: { offset: 8, bytes: Buffer.from([VAULT_ID & 255, VAULT_ID >> 8]).toString('base64'), encoding: 'base64' } } as never],
  });
  const withDebt = pos.filter(({ account: { data: d } }) => d[46] === 0 && d.readInt32LE(47) > -16383 && d.readBigUInt64LE(55) > 0n)
    .sort((a, b) => Number(b.account.data.readBigUInt64LE(55) - a.account.data.readBigUInt64LE(55)));
  const target = withDebt[Number(process.env.JL_PICK ?? 0)];
  const nftId = target.account.data.readUInt32LE(10);
  const positionMint = new web3.PublicKey(target.account.data.subarray(14, 46));
  const holders = await c.conn.getTokenLargestAccounts(positionMint);
  const holderAcc = await c.conn.getParsedAccountInfo(holders.value[0].address);
  const owner = pk((holderAcc.value!.data as any).parsed.info.owner);
  const before = await getCurrentPosition({ vaultId: VAULT_ID, positionId: nftId, connection: c.conn } as never) as any;
  log(`position #${nftId} (${target.pubkey.toBase58()}), owner ${owner.toBase58()}: col ${before.colRaw?.toString?.() ?? before.colRaw} debt ${before.debtRaw?.toString?.() ?? before.debtRaw}`);

  // USDC for the PDA (cheatcode) and the payback built for signer = PDA, the position's real owner unchanged.
  const pay = BigInt(PAYBACK * 1e6);
  await setTokenBalance(c, auth.toBase58(), USDC_MINT.toBase58(), pay * 2n);
  const op = await getOperateIx({
    vaultId: VAULT_ID, positionId: nftId, colAmount: new BN(0), debtAmount: new BN((-pay).toString()),
    connection: c.conn, signer: auth, positionOwner: owner, market: 'main',
  } as never);
  const ix = op.operateIx;
  // operate wants the signer's collateral-token account to exist even for a pure payback: an empty one (Token-2022 for xStocks).
  const supplyMint = op.accounts.supplyToken as InstanceType<typeof web3.PublicKey>;
  const supplyProg = (await c.conn.getAccountInfo(supplyMint))!.owner;
  await setTokenBalance(c, auth.toBase58(), supplyMint.toBase58(), 0n, supplyProg.toBase58());
  // JL_NON_ATA=1: pay from a USDC account of the PDA that is not its ATA (as credence_core's vault_usdc PDA).
  let payFrom = ata(auth, USDC_MINT);
  if (process.env.JL_NON_ATA === '1') {
    const k = web3.Keypair.generate().publicKey;
    const src = (await c.conn.getAccountInfo(payFrom))!;
    await setAccount(c, k.toBase58(), { lamports: src.lamports, data: Buffer.from(src.data), owner: src.owner.toBase58() });
    payFrom = k;
    for (const m of ix.keys) if (m.pubkey.equals(ata(auth, USDC_MINT))) m.pubkey = k;
  }
  const pdaUsdc0 = BigInt((await c.conn.getTokenAccountBalance(payFrom)).value.amount);
  const disc = createHash('sha256').update('global:jl_operate').digest().subarray(0, 8);
  const len = Buffer.alloc(4); len.writeUInt32LE(ix.data.length);
  const wrapped = new web3.TransactionInstruction({
    programId: PROBE,
    data: Buffer.concat([disc, len, ix.data]),
    keys: [
      { pubkey: auth, isSigner: false, isWritable: true },
      { pubkey: VAULTS, isSigner: false, isWritable: false },
      ...ix.keys.map((k) => ({ ...k, isSigner: false })), // the PDA signs inside the CPI
    ],
  });
  // Surfpool: accounts the transaction touches that do not exist yet (new branch or tick PDAs) are local-only.
  await offlineMissing(c.url, [...wrapped.keys.map((k) => k.pubkey.toBase58()), ...op.addressLookupTableAccounts.flatMap((t: any) => t.state.addresses.map((a: any) => a.toBase58()))]);
  const { blockhash } = await c.conn.getLatestBlockhash();
  const msg = new web3.TransactionMessage({
    payerKey: c.payer.publicKey, recentBlockhash: blockhash,
    instructions: [web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), wrapped],
  }).compileToV0Message(op.addressLookupTableAccounts);
  const tx = new web3.VersionedTransaction(msg);
  tx.sign([c.payer]);
  const sig = await c.conn.sendTransaction(tx, { skipPreflight: true });
  await c.conn.confirmTransaction(sig, 'confirmed');
  const t = await c.conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  const err = t?.meta?.err ?? null;
  const logs = t?.meta?.logMessages ?? [];
  const after = await getCurrentPosition({ vaultId: VAULT_ID, positionId: nftId, connection: c.conn } as never) as any;
  const pdaUsdc1 = BigInt((await c.conn.getTokenAccountBalance(payFrom)).value.amount);
  const result = {
    ranAt: new Date().toISOString(), vaultId: VAULT_ID, position: target.pubkey.toBase58(), nftId, owner: owner.toBase58(), signer: auth.toBase58(),
    payback: PAYBACK, ok: err === null, err, cu: t?.meta?.computeUnitsConsumed ?? 0,
    debtBefore: String(before.debtRaw), debtAfter: String(after.debtRaw), colBefore: String(before.colRaw), colAfter: String(after.colRaw),
    tickBefore: before.tick, tickAfter: after.tick, pdaPaidUsdc: Number(pdaUsdc0 - pdaUsdc1) / 1e6,
    operateAccounts: ix.keys.length, lookupTables: op.addressLookupTableAddresses.map((k: InstanceType<typeof web3.PublicKey>) => k.toBase58()),
    logs: logs.filter((l) => /Program (jupr|jupe|2Ljo)|Error|failed|consumed/.test(l)).slice(-12),
    simulated: ['kamino-probe deployed by cheatcode', `${Number(pay * 2n) / 1e6} USDC given to the probe PDA by cheatcode`],
  };
  mkdirSync(join(ROOT, 'data/jupiter'), { recursive: true });
  writeFileSync(join(ROOT, 'data/jupiter/cpi-probe.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (err) process.exit(1);
}
main().catch((e) => { console.error(redact(String((e as Error)?.stack ?? e))); process.exit(1); });
