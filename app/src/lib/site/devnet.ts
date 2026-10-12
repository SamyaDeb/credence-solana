// Server-only: the devnet deployment, read live (DEVNET_RPC). credence_core runs on devnet as a devnet-only build at
// DEVNET_PROGRAM_ID (only declare_id differs from the repo's program), initialised with stand-in mints; a keeper and the
// monitor run against it on Railway (deploy/railway-devnet). This reads what is on chain: the program account, config,
// assets, epochs, the monitor's checks (scripts/src/monitor.ts, same rules) and the keeper key's activity. Cached 30 s.
// Without DEVNET_RPC it returns null and the section is not shown.
import 'server-only';
import { Program } from '@anchor-lang/core';
import { Connection, PublicKey, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { IDL, tickerStr } from '@credence/sdk';

export const EPOCH_STATES = ['open', 'closed', 'settled', 'halted', 'voided'] as const;
export type Line = { level: 'ok' | 'warn' | 'alert'; what: string };
export type DevnetStatus = {
  asOf: string;
  programId: string;
  deployedSlot: number | null;
  authority: string | null;
  config: { paused: boolean; admin: string; guardian: string; keeper: string; usdcMint: string };
  assets: { ticker: string; mint: string; enabled: boolean }[];
  epochs: { ticker: string; closureId: number; state: string }[];
  monitor: Line[];
  keeper: { pubkey: string; sol: number; lastTxAt: string | null; txLastHour: number };
};

const TTL_MS = 30_000;
const MARK_MAX_AGE = 900;
let cache: { at: number; value: DevnetStatus | { error: string } } | null = null;

const n = (x: { toString(): string }) => BigInt(x.toString());

/** The monitor's checks (scripts/src/monitor.ts), on the devnet program. */
async function checks(conn: Connection, program: Program, pda: (s: string) => PublicKey): Promise<Line[]> {
  const out: Line[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acct = program.account as any;
  const [cfg, v, clock] = await Promise.all([acct.config.fetch(pda('config')), acct.vault.fetch(pda('vault')), conn.getAccountInfo(SYSVAR_CLOCK_PUBKEY)]);
  const now = Number(clock!.data.readBigInt64LE(32));
  out.push(cfg.paused ? { level: 'alert', what: 'protocol paused' } : { level: 'ok', what: 'not paused' });
  const invCost = (v.inv as { cost: { toString(): string } }[]).reduce((a, s) => a + n(s.cost), 0n);
  const limit = ((n(v.equity) - invCost) * n(cfg.uMaxWad)) / 10n ** 18n;
  const reserved = n(v.reservedTotal);
  const util = limit > 0n ? Number((reserved * 10_000n) / limit) / 100 : reserved > 0n ? Infinity : 0;
  out.push({ level: reserved > limit ? 'alert' : util > 80 ? 'warn' : 'ok', what: `INV-2 utilisation ${util.toFixed(2)}%` });
  const cash = BigInt((await conn.getTokenAccountBalance(pda('vault_usdc'))).value.amount);
  const keep = reserved - n(v.advancedLive ?? 0) + n(v.premiumsUnearned) + n(v.queuedDeposits);
  out.push({ level: cash < keep ? 'alert' : 'ok', what: `INV-13 cash ${cash} ≥ reserved cash ${keep}` });
  for (const s of v.inv as { ticker: number[]; cost: { toString(): string }; markedAt: { toString(): string } }[]) {
    if (n(s.cost) === 0n) continue;
    const age = now - Number(n(s.markedAt));
    out.push({ level: age > MARK_MAX_AGE ? 'warn' : 'ok', what: `inventory ${tickerStr(s.ticker)} marked ${age}s ago` });
  }
  const live = (v.live as number[]).filter((g) => g !== 0).sort();
  out.push({ level: 'ok', what: `${live.length} live weekend(s)${live.length ? `, oldest ${live[0]}` : ''}` });
  return out;
}

async function read(rpc: string, programId: PublicKey): Promise<DevnetStatus> {
  const conn = new Connection(rpc, 'confirmed');
  const program = new Program({ ...IDL, address: programId.toBase58() }, { connection: conn });
  const pda = (s: string) => PublicKey.findProgramAddressSync([Buffer.from(s)], programId)[0];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const acct = program.account as any;

  // The upgradeable loader: the program account names its ProgramData, which holds the deploy slot and the authority.
  const prog = await conn.getAccountInfo(programId);
  let deployedSlot: number | null = null, authority: string | null = null;
  if (prog && prog.data.length >= 36) {
    const pd = await conn.getAccountInfo(new PublicKey(prog.data.subarray(4, 36)));
    if (pd && pd.data.length >= 45) {
      deployedSlot = Number(pd.data.readBigUInt64LE(4));
      authority = pd.data[12] === 1 ? new PublicKey(pd.data.subarray(13, 45)).toBase58() : null;
    }
  }

  const cfg = await acct.config.fetch(pda('config'));
  const [assets, epochs, monitor] = await Promise.all([acct.assetConfig.all(), acct.epoch.all(), checks(conn, program, pda)]);
  const keeperKey = cfg.keeper as PublicKey;
  const [lamports, sigs] = await Promise.all([conn.getBalance(keeperKey), conn.getSignaturesForAddress(keeperKey, { limit: 200 })]);
  const hourAgo = Date.now() / 1000 - 3600;
  const last = sigs.find((s) => s.blockTime);

  return {
    asOf: new Date().toISOString(),
    programId: programId.toBase58(),
    deployedSlot,
    authority,
    config: { paused: !!cfg.paused, admin: cfg.admin.toBase58(), guardian: cfg.guardian.toBase58(), keeper: keeperKey.toBase58(), usdcMint: cfg.usdcMint.toBase58() },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    assets: assets.map((a: any) => ({ ticker: tickerStr(a.account.ticker), mint: a.account.mint.toBase58(), enabled: !!a.account.enabled }))
      .sort((a: { ticker: string }, b: { ticker: string }) => a.ticker.localeCompare(b.ticker)),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    epochs: epochs.map((e: any) => ({ ticker: tickerStr(e.account.ticker), closureId: Number(e.account.closureId), state: EPOCH_STATES[e.account.state] ?? `state ${e.account.state}` }))
      .sort((a: { closureId: number; ticker: string }, b: { closureId: number; ticker: string }) => b.closureId - a.closureId || a.ticker.localeCompare(b.ticker)),
    monitor,
    keeper: {
      pubkey: keeperKey.toBase58(),
      sol: lamports / 1e9,
      lastTxAt: last?.blockTime ? new Date(last.blockTime * 1000).toISOString() : null,
      txLastHour: sigs.filter((s) => (s.blockTime ?? 0) >= hourAgo).length,
    },
  };
}

export async function loadDevnet(): Promise<DevnetStatus | { error: string } | null> {
  const rpc = process.env.DEVNET_RPC, id = process.env.DEVNET_PROGRAM_ID;
  if (!rpc || !id) return null;
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  let value: DevnetStatus | { error: string };
  try {
    value = await read(rpc, new PublicKey(id));
  } catch {
    // Never echo the RPC error (it can carry the endpoint); the page says the devnet read failed.
    value = { error: 'the devnet read failed; try again shortly' };
  }
  cache = { at: Date.now(), value };
  return value;
}
