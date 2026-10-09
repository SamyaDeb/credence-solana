// "Protect my position": a Solana Action (spec v2.4) that sells this weekend's gap protection on a Kamino or Jupiter
// Lend position, on the local mainnet fork.
//   GET  ?position=<pubkey>&lender=kamino|jupiter          the Action: the live quote (a simulated program instruction),
//                                                          the chance it pays anything, linked actions per max payout
//   POST ?position=…&lender=…&cap=full|need8|need12 {account}  an unsigned transaction: the lender's refreshes + buy
// The chain is behind `ProtectChain` (lib/actions/fork-chain.ts on the fork; a fake in the tests), so every check
// here is tested without a fork. Nothing is signed on the server.
import type { PublicKey } from '@solana/web3.js';
import type { RateLimiter } from './guard';
import type { Lender } from './shape';

export type { Lender };
export const LENDERS: readonly Lender[] = ['kamino', 'jupiter'];
export type Cap = 'full' | 'need8' | 'need12';
export const CAPS: readonly Cap[] = ['full', 'need8', 'need12'];

export type Position = {
  lender: Lender;
  kind: 'kamino' | 'kamino-multi' | 'jupiter';
  key: PublicKey;
  /** Kamino: the obligation's owner. Jupiter Lend: the holder of the position NFT (null when none holds it). */
  owner: PublicKey | null;
  /** The covered xStock(s), e.g. "SPYx" or "SPYx + QQQx". */
  ticker: string;
  /** Why credence_core would refuse this position (the program's rules, mirrored from the app's checks), or null. */
  why: string | null;
  /** The epoch on sale now for this position, or null with `saleNote` saying why. */
  sale: { epoch: string; closureId: number; closureType: number; bell: number } | null;
  saleNote: string | null;
  /** Chain clock (the fork's, after any time travel). */
  now: number;
  /** C′ and D in USDC base units, as buy_cover will snapshot them; null when they could not be simulated (snapNote). */
  snap: { coveredValue: bigint; debt: bigint } | null;
  snapNote: string | null;
  /** Share of the asset's WEEKEND scenario set that pays anything (lib/odds `modelPays`); null for multi-collateral. */
  odds: { count: number; n: number; p: number } | null;
};

export type QuoteResult = { premium: bigint; cu: number };

export interface ProtectChain {
  load(lender: Lender, position: PublicKey): Promise<Position | null>;
  /** The premium the program charges for `maxPayout`: quote_cover (Kamino, one xStock) or the buy itself (multi,
   * Jupiter), simulated on the fork. Throws `Refusal` with the decoded CoreError when the program refuses. */
  quote(p: Position, maxPayout: bigint): Promise<QuoteResult>;
  /** The unsigned transaction (base64), simulated first: a failing simulation throws `Refusal` (decoded CoreError). */
  build(p: Position, account: PublicKey, maxPayout: bigint, maxPremium: bigint): Promise<{ transaction: string; cu: number }>;
}

/** A refusal the user should read: spec-shaped `{ message }` with this status. */
export class Refusal extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}

export type ProtectDeps = {
  chain: () => ProtectChain;
  limiter: RateLimiter;
  timeoutMs: number;
  network: 'fork' | 'mainnet';
  /** Absolute origin for the icon (ACTION_BASE_URL, else the request's). */
  baseUrl?: string;
};

export async function handleProtect(_req: Request, _deps: ProtectDeps): Promise<Response> {
  return new Response('not implemented', { status: 501 });
}
