// Quote and build an owner's cover on a Kamino xStock position: the program's own quote_cover (simulated), a
// slippage-bounded max_premium, the refreshes + buy_cover as UNSIGNED instructions. The SDK never signs or sends: the
// wallet does. release_book_leg goes first automatically when a curator's book holds the position.
//   RPC_URL=http://127.0.0.1:8899 OBLIGATION=<pubkey> OWNER=<pubkey> pnpm tsx examples/quote-and-buy.ts
import { ComputeBudgetProgram, Connection, PublicKey, Transaction } from '@solana/web3.js';
import {
  buyCover, chainNow, currentEpoch, decodeObligation, deposits, borrows, loadAssets, loadEpochs, loadReserves, pdas, program, quoteSingle, readBookLeg, reserveToAsset, snapshot,
  withSlippage,
} from '@credence/sdk';

const conn = new Connection(process.env.RPC_URL ?? 'http://127.0.0.1:8899', 'confirmed');
const prog = program(conn);
const obligation = new PublicKey(process.env.OBLIGATION!);
const owner = new PublicKey(process.env.OWNER!);

const o = decodeObligation((await conn.getAccountInfo(obligation))!.data);
const reserves = await loadReserves(conn, [...deposits(o), ...borrows(o)]);
const assets = await loadAssets(prog);
const asset = reserveToAsset(assets).get(deposits(o)[0].toBase58())!;
const epoch = currentEpoch(await loadEpochs(prog), asset.ticker, await chainNow(conn));
if (!epoch) throw new Error(`no ${asset.ticker} epoch is on sale`);

const { coveredValue, debt } = snapshot(o); // display / quote inputs; the program recomputes them on-chain at the buy
const quote = await quoteSingle(conn, prog, owner, asset, epoch, coveredValue, debt, debt); // full cover
const vault = await prog.account.vault.fetch(pdas.vault());
const leg = await readBookLeg(prog, epoch.key, obligation);
const { ixs } = await buyCover(prog, {
  kind: 'kamino', buyer: owner, feeAccount: vault.feeAccount, maxPayout: debt, maxPremium: withSlippage(quote.premium, 100), // +1%
  asset, epoch, obligation, o, reserves,
  release: leg ? { ...leg, releaseAsset: asset.key, releaseEpoch: epoch.key, closureId: epoch.closureId, positionTokenAccount: null } : undefined,
});
const { blockhash } = await conn.getLatestBlockhash();
const tx = new Transaction({ feePayer: owner, recentBlockhash: blockhash }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }), ...ixs);
console.log(`premium ${Number(quote.premium) / 1e6} USDC for ${Number(debt) / 1e6} USDC of cover; ${tx.instructions.length} instructions; hand the transaction to the wallet to sign`);
