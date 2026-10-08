// FORK ONLY (task 4.5): opens a bigger SPYx position in the real xStocks Market so demo mode has a payout worth seeing,
// and gives it to a wallet. The real near-threshold positions in the mainnet scan are small (the largest at a fresh
// D/C′ above 0.92 has about $430 of debt), so:
//   1. the demo keeper wallet gets SPYx with a surfpool cheatcode (SIMULATED: no one sold it these tokens)
//   2. it deposits them and borrows USDC through klend-sdk's own deposit+borrow instructions (REAL klend, v2
//      instructions, refreshes included) up to D/C′ = TARGET (default 0.96; SPYx LTV 73% / LT 75% allows up to 0.973)
//   3. the obligation's owner field is rewritten to --owner (SIMULATED, as for the real positions) so that wallet can
//      sign buy_cover.
// Prints one JSON line: {obligation, owner, depositTokens, debtUsdc, ratio, simulated[]}.
//
//   pnpm tsx src/create-position.ts --owner <pubkey> [--debt 50000] [--ratio 0.96]
import { address, createNoopSigner, createSolanaRpc, AccountRole, type Instruction } from '@solana/kit';
import { KaminoAction, KaminoMarket, VanillaObligation } from '@kamino-finance/klend-sdk';
import anchor from '@anchor-lang/core';
const { BN, web3 } = anchor;
import { type Chain, KLEND, SCOPE_PRICES, TOKEN_2022, chainNow, connect, decodeScope, log, pk, send } from './chain.js';
import { setAccount, setTokenBalance } from './fork.js';
import { loadObligation, loadReserve } from './kamino.js';
import { redact } from './redact.js';
import { restampScope } from './weekend.js';

const XSTOCKS_MARKET = '5wJeMrUYECGq41fxRESKALVcHnNX26TAWy4W98yULsua';
const SPYX_RESERVE = 'UvXjBuC7YZYaGB9Rn1PpBD1GySmjzunXgE8Zev9ua8d';
const USDC_RESERVE = '97zoywd8mPZsGTg8q1wdD2Wgkdrs2tqusp1Qqcxbyj7E';
const arg = (k: string, d?: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };

/** @solana/kit instruction → web3.js v1 (the keeper's send). */
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

/** Scope (price, TWAP) pairs of the two reserves, restamped to the fork clock so klend accepts them. */
async function freshPrices(c: Chain) {
  const pairs: { price: number; twap: number | null }[] = [];
  for (const k of [SPYX_RESERVE, USDC_RESERVE]) {
    const s = (await loadReserve(c, pk(k))).config.tokenInfo.scopeConfiguration;
    pairs.push({ price: s.priceChain[0], twap: s.twapChain[0] !== 65535 ? s.twapChain[0] : null });
  }
  return restampScope(c, pairs);
}

/** Sends `ixs` in as few transactions as fit (1,232 bytes each, no lookup tables on the fork). */
async function sendPacked(c: Chain, ixs: InstanceType<typeof web3.TransactionInstruction>[], label: string) {
  let batch: typeof ixs = [];
  const fits = (b: typeof ixs) => {
    const tx = new web3.Transaction().add(web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...b);
    tx.feePayer = c.payer.publicKey;
    tx.recentBlockhash = web3.PublicKey.default.toBase58();
    try { return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length <= 1232; } catch { return false; }
  };
  const flush = async () => { if (batch.length) { const r = await send(c, batch); log(`  ok   ${label} (${batch.length} ix, ${r.cu} CU)`); batch = []; } };
  for (const ix of ixs) {
    if (fits([...batch, ix])) batch.push(ix);
    else { await flush(); batch = [ix]; }
  }
  await flush();
}

async function main() {
  const owner = arg('--owner');
  if (!owner) throw new Error('--owner <pubkey> required');
  const targetDebt = Number(arg('--debt', '50000'));
  const ratio = Number(arg('--ratio', '0.96'));
  const c = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  const me = c.payer.publicKey;
  const fresh = await freshPrices(c);

  // Size: D = ratio × LT × C, so C = D / (ratio × 0.75).
  const spy = await loadReserve(c, pk(SPYX_RESERVE));
  const lt = spy.config.liquidationThresholdPct / 100;
  const price = decodeScope((await c.conn.getAccountInfo(SCOPE_PRICES))!.data, spy.config.tokenInfo.scopeConfiguration.priceChain[0]).price;
  const collateralUsd = targetDebt / (ratio * lt);
  const tokens = BigInt(Math.ceil((collateralUsd / price) * 1e8));
  const borrow = BigInt(Math.floor(targetDebt * 1e6));
  log(`SPYx @ ${price.toFixed(4)} (fork Scope); deposit ${(Number(tokens) / 1e8).toFixed(8)} SPYx ≈ $${collateralUsd.toFixed(2)}, borrow ${targetDebt} USDC → D/C′ ≈ ${ratio}`);

  // 1. SPYx for the demo keeper wallet (cheatcode, Token-2022).
  await setTokenBalance(c, me.toBase58(), spy.liquidity.mintPubkey, tokens, TOKEN_2022.toBase58());

  // 2. klend-sdk's deposit + borrow for a fresh vanilla obligation of the keeper wallet.
  const rpc = createSolanaRpc(c.url);
  const market = await KaminoMarket.load(rpc as never, address(XSTOCKS_MARKET), 400);
  if (!market) throw new Error('xStocks Market not found on the fork');
  const slot = BigInt(await c.conn.getSlot());
  const instant = { slot, blockTime: BigInt(await chainNow(c)) } as never;
  // The keeper wallet's next free vanilla obligation id (one demo position per run).
  let kind = new VanillaObligation(address(KLEND.toBase58()), 0);
  let obligation = pk(await kind.toPda(address(XSTOCKS_MARKET), address(me.toBase58())));
  for (let id = 1; (await c.conn.getAccountInfo(obligation)) && id < 256; id++) {
    kind = new VanillaObligation(address(KLEND.toBase58()), id);
    obligation = pk(await kind.toPda(address(XSTOCKS_MARKET), address(me.toBase58())));
  }
  const action = await KaminoAction.buildDepositAndBorrowTxns({
    kaminoMarket: market, depositAmount: new BN(tokens.toString()), depositReserveAddress: address(SPYX_RESERVE),
    borrowAmount: new BN(borrow.toString()), borrowReserveAddress: address(USDC_RESERVE),
    owner: createNoopSigner(address(me.toBase58())), obligation: kind, useV2Ixs: true, scopeRefreshConfig: undefined,
    includeAtaIxs: true, requestElevationGroup: false, initUserMetadata: { skipInitialization: false, skipLutCreation: true },
    currentLedgerInstant: instant,
  });
  const a = action as unknown as { setupIxs: Instruction[]; setupIxsLabels: string[]; lendingIxsLabels: string[]; cleanupIxsLabels: string[] };
  log(`  klend-sdk setup: ${a.setupIxsLabels.join(', ')}; lending: ${a.lendingIxsLabels.join(', ')}`);
  // Account creation first (its own transactions); refreshes stay with the deposit and borrow, in one transaction.
  const isInit = (l: string) => /init|create|ata/i.test(l) && !/refresh/i.test(l);
  const setup = a.setupIxs.filter((_, i) => isInit(a.setupIxsLabels[i])).map(toV1);
  if (setup.length) await sendPacked(c, setup, 'klend setup (user metadata, obligation, farms, ATAs)');
  await freshPrices(c);
  const initSet = new Set(a.setupIxs.filter((_, i) => isInit(a.setupIxsLabels[i])));
  const rest = KaminoAction.actionToIxs(action).filter((ix) => !initSet.has(ix)).map(toV1)
    .filter((ix) => !ix.programId.equals(web3.ComputeBudgetProgram.programId));
  const r = await send(c, rest);
  log(`  ok   klend refreshes + deposit + borrow in one transaction (${rest.length} ix, ${r.cu} CU)`);

  // 3. Give it to the wallet.
  const acc = (await c.conn.getAccountInfo(obligation))!;
  const data = Buffer.from(acc.data);
  pk(owner).toBuffer().copy(data, 64);
  await setAccount(c, obligation.toBase58(), { lamports: acc.lamports, data, owner: acc.owner.toBase58() });
  const ob = (await loadObligation(c, obligation))!;
  const debt = Number(BigInt(ob.borrows[0].borrowedAmountSf.toString()) >> 60n) / 1e6;
  console.log(JSON.stringify({
    obligation: obligation.toBase58(), owner, depositTokens: Number(tokens) / 1e8, debtUsdc: debt, price,
    simulated: [
      ...(fresh.aligned ? ["Kamino's Scope TWAP set to the spot price after a simulated gap (a real TWAP converges within days)"] : []),
      `${(Number(tokens) / 1e8).toFixed(8)} SPYx given to the demo keeper wallet by a surfpool cheatcode`,
      `obligation ${obligation.toBase58()} created on the fork through klend (deposit ${(Number(tokens) / 1e8).toFixed(4)} SPYx, borrow ${targetDebt} USDC), then its owner field set to ${owner}`,
    ],
  }));
}
main().catch((e) => { console.error(redact(String(e?.message ?? e))); process.exit(1); });
