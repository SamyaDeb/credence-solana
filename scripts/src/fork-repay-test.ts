// Task 1.3 acceptance: on the local mainnet fork, repay a real Kamino obligation through a PDA-signed CPI
// (kamino-probe → klend repay_obligation_liquidity_v2), after refresh_reserve + refresh_obligation in the same tx.
// Usage (fork running): pnpm tsx src/fork-repay-test.ts [amountUsdcBaseUnits]
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import {
  ComputeBudgetProgram, Connection, Keypair, PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, Transaction,
  TransactionInstruction, sendAndConfirmTransaction,
} from '@solana/web3.js';
import { Obligation } from '@kamino-finance/klend-sdk/dist/@codegen/klend/accounts/index.js';
import { redact } from './lib/redact.js';

const env = Object.fromEntries(
  readFileSync(new URL('../fork/accounts.env', import.meta.url), 'utf8')
    .split('\n').filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split('=') as [string, string]),
);
const pk = (s: string) => new PublicKey(s);
const disc = (name: string) => createHash('sha256').update(`global:${name}`).digest().subarray(0, 8);
const kp = (p: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));

const KLEND = pk(env.KLEND), FARMS = pk(env.FARMS), MARKET = pk(env.MARKET), SCOPE = pk(env.SCOPE_PRICES);
const USDC_MINT = pk(env.USDC_MINT), USDC_RESERVE = pk(env.USDC_RESERVE), SPYX_RESERVE = pk(env.SPYX_RESERVE);
const OBLIGATION = pk(env.OBLIGATION);
const TOKEN = pk('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA = pk('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
const SF = 2n ** 60n;

const conn = new Connection('http://127.0.0.1:8899', 'confirmed');
const payer = kp(`${homedir()}/.config/solana/id.json`);
const PROBE = kp(new URL('../../target/deploy/kamino_probe-keypair.json', import.meta.url).pathname).publicKey;
const [vaultAuth] = PublicKey.findProgramAddressSync([Buffer.from('vault_auth')], PROBE);
const [vaultUsdc] = PublicKey.findProgramAddressSync([vaultAuth.toBuffer(), TOKEN.toBuffer(), USDC_MINT.toBuffer()], ATA);
const [lma] = PublicKey.findProgramAddressSync([Buffer.from('lma'), MARKET.toBuffer()], KLEND);

const refreshReserve = (reserve: PublicKey) => new TransactionInstruction({
  programId: KLEND, data: disc('refresh_reserve'),
  keys: [
    { pubkey: reserve, isSigner: false, isWritable: true },
    { pubkey: MARKET, isSigner: false, isWritable: false },
    { pubkey: KLEND, isSigner: false, isWritable: false }, // pyth: none
    { pubkey: KLEND, isSigner: false, isWritable: false }, // switchboard price: none
    { pubkey: KLEND, isSigner: false, isWritable: false }, // switchboard twap: none
    { pubkey: SCOPE, isSigner: false, isWritable: false },
  ],
});

async function debtUsdc(): Promise<{ sf: bigint; usd: number }> {
  const o = Obligation.decode((await conn.getAccountInfo(OBLIGATION))!.data);
  const b = o.borrows.find((x) => x.borrowReserve === USDC_RESERVE.toBase58())!;
  const sf = BigInt(b.borrowedAmountSf.toString());
  return { sf, usd: Number(sf / SF) / 1e6 };
}

async function main() {
  const amount = BigInt(process.argv[2] ?? 10_000_000_000); // 10,000 USDC
  const o = Obligation.decode((await conn.getAccountInfo(OBLIGATION))!.data);
  const deps = o.deposits.filter((d) => d.depositReserve !== PublicKey.default.toBase58()).map((d) => pk(d.depositReserve));
  const bors = o.borrows.filter((b) => b.borrowReserve !== PublicKey.default.toBase58()).map((b) => pk(b.borrowReserve));
  console.log('deposit reserves', deps.map(String), 'borrow reserves', bors.map(String));

  const refreshObligation = new TransactionInstruction({
    programId: KLEND, data: disc('refresh_obligation'),
    keys: [
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: OBLIGATION, isSigner: false, isWritable: true },
      ...[...deps, ...bors].map((r) => ({ pubkey: r, isSigner: false, isWritable: false })),
    ],
  });
  const data = Buffer.alloc(16); disc('repay').copy(data, 0); data.writeBigUInt64LE(amount, 8);
  const repay = new TransactionInstruction({
    programId: PROBE, data,
    keys: [
      { pubkey: vaultAuth, isSigner: false, isWritable: false },
      { pubkey: OBLIGATION, isSigner: false, isWritable: true },
      { pubkey: MARKET, isSigner: false, isWritable: false },
      { pubkey: USDC_RESERVE, isSigner: false, isWritable: true },
      { pubkey: USDC_MINT, isSigner: false, isWritable: false },
      { pubkey: pk(env.USDC_SUPPLY_VAULT), isSigner: false, isWritable: true },
      { pubkey: vaultUsdc, isSigner: false, isWritable: true },
      { pubkey: TOKEN, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: pk(env.OBLIGATION_FARM_USER_STATE), isSigner: false, isWritable: true },
      { pubkey: pk(env.USDC_DEBT_FARM), isSigner: false, isWritable: true },
      { pubkey: lma, isSigner: false, isWritable: false },
      { pubkey: FARMS, isSigner: false, isWritable: false },
      { pubkey: KLEND, isSigner: false, isWritable: false },
    ],
  });
  const uniq = [...new Set([...deps, ...bors].map(String))].map(pk);
  // Refresh alone first so `before` includes interest accrued since the obligation's last mainnet refresh.
  await sendAndConfirmTransaction(conn, new Transaction().add(...uniq.map(refreshReserve), refreshObligation), [payer]);
  const before = await debtUsdc();
  const balBefore = BigInt((await conn.getTokenAccountBalance(vaultUsdc)).value.amount);
  const tx = new Transaction().add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    ...uniq.map(refreshReserve),
    refreshObligation,
    repay,
  );
  const sig = await sendAndConfirmTransaction(conn, tx, [payer], { skipPreflight: true, commitment: 'confirmed' });
  const t = await conn.getTransaction(sig, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
  if (t?.meta?.err) {
    console.log(t.meta.logMessages?.join('\n'));
    throw new Error(`tx failed: ${JSON.stringify(t.meta.err)}`);
  }
  const after = await debtUsdc();
  const balAfter = BigInt((await conn.getTokenAccountBalance(vaultUsdc)).value.amount);
  const paid = balBefore - balAfter;
  console.log(t?.meta?.logMessages?.filter((l) => /consumed|Program log: (Instruction|Repay)|invoke \[2\]/.test(l)).join('\n'));
  console.log({ sig, computeUnits: t?.meta?.computeUnitsConsumed, debtBeforeUsdc: before.usd, debtAfterUsdc: after.usd, vaultPaidUsdc: Number(paid) / 1e6 });
  const debtDrop = Number((before.sf - after.sf) / SF) / 1e6;
  if (paid !== amount) throw new Error(`vault paid ${paid}, expected ${amount}`);
  if (after.sf >= before.sf) throw new Error('debt did not decrease');
  // A few slots of interest accrue between the two transactions; allow 0.01 USDC.
  if (Math.abs(debtDrop - Number(amount) / 1e6) > 0.01) throw new Error(`debt fell ${debtDrop}, paid ${Number(amount) / 1e6}`);
  console.log('PASS: repay_obligation_liquidity_v2 via PDA-signed CPI reduced the obligation debt by the amount paid');
}
main().catch((e) => { console.error(redact(String(e?.stack ?? e))); process.exit(1); });
