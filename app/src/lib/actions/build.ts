// The instructions the Protect Action returns, built from decoded chain state (no RPC here, so the transaction shape is
// unit-tested): the lender's refreshes + the right buy for the position, behind a compute-unit limit and price.
//   Kamino, one xStock deposit + one USDC borrow: refresh_reserve ×N, refresh_obligation, buy_cover (lib/cover.ts, the
//     app's own builder)
//   Kamino, several deposits (covered xStocks and stablecoins), one USDC or PYUSD borrow: the same refreshes,
//     buy_cover_multi (legs in order of first appearance among the deposits, A-45)
//   Jupiter Lend: buy_cover_jl alone (it reads the position, its tick, the vault state and Jupiter's oracle cache; there
//     is no Jupiter refresh to run, and klend never shares a transaction with Jupiter's program)
import { ComputeBudgetProgram, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { type Asset, type EpochView, buyCoverIxs } from '@/lib/cover';
import { type CoreProgram, TOKEN, USDC_MINT, ata, bn, pdas } from '@/lib/credence';
import { type ObligationState, type ReserveState, deposits, refreshIxs } from '@/lib/kamino';
import { CU_PRICE_MICROLAMPORTS } from '@/lib/tx';

export const JL_VAULTS = new PublicKey('jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi');
/** Jupiter Lend `Position` account discriminator (as keeper/src/jl-demo.ts). */
export const JL_POSITION_DISC = Buffer.from([170, 188, 143, 228, 122, 64, 247, 208]);
/** Fluid's lowest tick: a position at it has no debt. */
export const JL_MIN_TICK = -16383;

export type JlPosition = { vaultId: number; nftId: number; mint: PublicKey; supplyOnly: boolean; tick: number };

/** Position: discriminator, vault_id u16 @8, nft_id u32 @10, position_mint @14, is_supply_only @46, tick i32 @47. */
export function decodeJlPosition(d: Buffer): JlPosition | null {
  if (d.length < 63 || !d.subarray(0, 8).equals(JL_POSITION_DISC)) return null;
  return { vaultId: d.readUInt16LE(8), nftId: d.readUInt32LE(10), mint: new PublicKey(d.subarray(14, 46)), supplyOnly: d[46] !== 0, tick: d.readInt32LE(47) };
}

const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const jlVaultState = (vaultId: number) => PublicKey.findProgramAddressSync([Buffer.from('vault_state'), u16(vaultId)], JL_VAULTS)[0];
export const jlTick = (vaultId: number, tick: number) => PublicKey.findProgramAddressSync([Buffer.from('tick'), u16(vaultId), u32(tick - JL_MIN_TICK)], JL_VAULTS)[0];

/** A Jupiter Lend alias asset (`<T>.J`, lender 1): its vault config and oracle cache. */
export type JlAsset = { key: PublicKey; ticker: string; tickerBytes: number[]; lenderVault: PublicKey; lenderOracle: PublicKey; enabled: boolean; sigmaWad: bigint };

export type BuyArgs = { buyer: PublicKey; feeAccount: PublicKey; maxPayout: bigint; maxPremium: bigint };

export async function kaminoBuy(prog: CoreProgram, a: BuyArgs & { asset: Asset; epoch: EpochView; obligation: PublicKey; o: ObligationState; reserves: Map<string, ReserveState> }) {
  return buyCoverIxs(prog, a.buyer, a.asset, a.epoch, a.obligation, a.o, a.reserves, a.feeAccount, a.maxPayout, a.maxPremium);
}

export type Leg = { asset: PublicKey; ticker: string; epoch: PublicKey };

export async function kaminoMultiBuy(prog: CoreProgram, a: BuyArgs & { closureId: number; legs: Leg[]; obligation: PublicKey; o: ObligationState;
  reserves: Map<string, ReserveState>; borrowReserve: PublicKey; sleeve: PublicKey | null }) {
  const policy = pdas.policy(a.legs[0].epoch, a.obligation);
  const rem = [
    ...deposits(a.o).map((k) => ({ pubkey: k, isSigner: false, isWritable: false })),
    ...a.legs.flatMap((l) => [
      { pubkey: l.asset, isSigner: false, isWritable: false },
      { pubkey: pdas.scen(l.ticker), isSigner: false, isWritable: false },
      { pubkey: l.epoch, isSigner: false, isWritable: true },
    ]),
  ];
  const buy: TransactionInstruction = await prog.methods
    .buyCoverMulti(a.closureId, bn(a.maxPayout), bn(a.maxPremium))
    .accountsPartial({ buyer: a.buyer, epoch: a.legs[0].epoch, loss: pdas.loss(a.closureId), vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(),
      feeAccount: a.feeAccount, buyerUsdc: ata(a.buyer, USDC_MINT), obligation: a.obligation, borrowReserve: a.borrowReserve, sleeve: a.sleeve,
      policy, tokenProgram: TOKEN })
    .remainingAccounts(rem)
    .instruction();
  return { ixs: [...refreshIxs(a.obligation, a.o, a.reserves), buy], policy };
}

export async function jupiterBuy(prog: CoreProgram, a: BuyArgs & { asset: JlAsset; epoch: Pick<EpochView, 'key' | 'closureId'>; position: PublicKey;
  pos: JlPosition; nftAccount: PublicKey }) {
  const policy = pdas.policy(a.epoch.key, a.position);
  const buy: TransactionInstruction = await prog.methods
    .buyCoverJl(a.asset.tickerBytes, a.epoch.closureId, bn(a.maxPayout), bn(a.maxPremium))
    .accountsPartial({ buyer: a.buyer, asset: a.asset.key, scenarios: pdas.scen(a.asset.ticker), epoch: a.epoch.key, loss: pdas.loss(a.epoch.closureId),
      vaultUsdc: pdas.vaultUsdc(), shareMint: pdas.shares(), feeAccount: a.feeAccount, buyerUsdc: ata(a.buyer, USDC_MINT), position: a.position,
      positionTokenAccount: a.nftAccount, vaultConfig: a.asset.lenderVault, vaultState: jlVaultState(a.pos.vaultId),
      positionTick: jlTick(a.pos.vaultId, a.pos.tick), cache: a.asset.lenderOracle, policy, tokenProgram: TOKEN })
    .instruction();
  return { ixs: [buy], policy };
}

/** Compute-unit limit and price first, then `ixs`; fee payer = the wallet that signs. Unsigned, a legacy message (every
 * wallet and the app's own signer take it; no lookup table is needed: buy_cover_jl alone, or klend's refreshes + one
 * buy, fit), wrapped as a VersionedTransaction so it can be simulated with the RPC's config options. */
export function assembleTx(payer: PublicKey, blockhash: string, ixs: TransactionInstruction[], cuLimit: number): VersionedTransaction {
  const msg = new TransactionMessage({
    payerKey: payer, recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: CU_PRICE_MICROLAMPORTS }),
      ...ixs,
    ],
  }).compileToLegacyMessage();
  return new VersionedTransaction(msg);
}

export const encodeTx = (tx: VersionedTransaction) => Buffer.from(tx.serialize()).toString('base64');

/** The limit the app's sendTx uses: simulated consumption + 10% + 10k, capped at 1.4M. */
export const cuLimitFor = (consumed: number) => Math.min(1_400_000, Math.ceil(consumed * 1.1) + 10_000);
