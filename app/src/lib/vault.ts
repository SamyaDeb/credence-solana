// The underwriter vault as the app shows it. Every figure is a stored field or a stated function of stored
// fields, in base units; the page formats these and test/vault-accounts.test.ts checks them against raw account bytes.
//   NAV per share         = equity / share supply (USDC per share, both 6 decimals), shown to 6 decimals, rounded down
//   premiums earned        = total_premiums − premiums_unearned (lifetime premiums net of fee, released to equity)
//   capacity limit         = ⌊u_max × equity⌋ (INV-2, as the program computes it)
//   utilisation            = reserved_total / capacity limit (ppm, rounded down)
import { Connection, PublicKey } from '@solana/web3.js';
import { type CoreProgram, TICKET, WAD, big, pdas } from './credence';
import type { Row } from './cover';

export type VaultView = {
  equity: bigint; reservedTotal: bigint; premiumsUnearned: bigint; queuedDeposits: bigint; queuedWithdrawShares: bigint;
  totalPremiums: bigint; totalPayouts: bigint; liveGroups: number; latestGroup: number; live: number[]; feeAccount: PublicKey;
};

export function vaultView(v: Record<string, unknown>): VaultView {
  return {
    equity: big(v.equity as never), reservedTotal: big(v.reservedTotal as never), premiumsUnearned: big(v.premiumsUnearned as never),
    queuedDeposits: big(v.queuedDeposits as never), queuedWithdrawShares: big(v.queuedWithdrawShares as never),
    totalPremiums: big(v.totalPremiums as never), totalPayouts: big(v.totalPayouts as never), liveGroups: v.liveGroups as number,
    latestGroup: v.latestGroup as number, live: (v.live as number[]).filter((g) => g !== 0).sort((a, b) => a - b),
    feeAccount: v.feeAccount as PublicKey,
  };
}

export function vaultFigures(v: VaultView, supply: bigint, uMaxWad: bigint) {
  const limit = (v.equity * uMaxWad) / WAD;
  return {
    navPerShare6: supply > 0n ? (v.equity * 1_000_000n) / supply : 1_000_000n,
    premiumsEarned: v.totalPremiums - v.premiumsUnearned,
    capacityLimit: limit,
    /** reserved / limit in parts per million, rounded down. */
    utilisationPpm: limit > 0n ? Number((v.reservedTotal * 1_000_000n) / limit) : 0,
    freeCapacity: limit > v.reservedTotal ? limit - v.reservedTotal : 0n,
  };
}

export async function loadVault(conn: Connection, prog: CoreProgram) {
  const [v, cfg, supply] = await Promise.all([
    prog.account.vault.fetch(pdas.vault(), 'confirmed'),
    prog.account.config.fetch(pdas.config(), 'confirmed'),
    conn.getTokenSupply(pdas.shares(), 'confirmed'),
  ]);
  const view = vaultView(v);
  const uMaxWad = big(cfg.uMaxWad);
  return { view, supply: BigInt(supply.value.amount), uMaxWad, figures: vaultFigures(view, BigInt(supply.value.amount), uMaxWad), paused: cfg.paused as boolean };
}

export type TicketView = { key: PublicKey; owner: PublicKey; waitGroup: number; kind: number; amount: bigint; requestedAt: number };

export async function ticketsOf(prog: CoreProgram, owner: PublicKey): Promise<TicketView[]> {
  const rows = (await prog.account.queueTicket.all([{ memcmp: { offset: 8, bytes: owner.toBase58() } }])) as Row[];
  return rows.map(({ publicKey, account: t }) => ({
    key: publicKey, owner: t.owner, waitGroup: t.waitGroup, kind: t.kind, amount: big(t.amount), requestedAt: Number(big(t.requestedAt)),
  })).sort((a, b) => a.requestedAt - b.requestedAt);
}

export const ticketLabel = (t: TicketView) => (t.kind === TICKET.DEPOSIT ? 'deposit' : 'withdrawal');
/** A ticket is ready once no group up to its wait group is live (credence-core `Vault::live_through`). */
export const ticketReady = (t: TicketView, live: number[]) => !live.some((g) => g <= t.waitGroup);

/** credence-core `math::free_equity`: equity net of the queued withdrawals' value (the deduction rounded up), which
 * new cover is sized on. Null when the queue exceeds the supply (the program refuses then). */
export function freeEquity(equity: bigint, queuedWithdrawShares: bigint, supply: bigint): bigint | null {
  if (queuedWithdrawShares === 0n) return equity;
  if (queuedWithdrawShares > supply) return null;
  const leaving = (queuedWithdrawShares * equity + supply - 1n) / supply;
  return equity >= leaving ? equity - leaving : null;
}

/** credence-core `cover::concentration_limit`: one asset's worst covered loss ≤ ⌊⌊equity × u_max⌋ × share⌋ (WAD). */
export const concentrationLimit = (equity: bigint, uMaxWad: bigint, shareWad: bigint) => ((equity * uMaxWad) / WAD) * shareWad / WAD;
