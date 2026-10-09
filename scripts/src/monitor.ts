// Monitoring (W6, docs/mainnet-runbook.md §6): reads credence_core's state and reports what an operator must know, as
// lines of `ok | warn | alert`. Read-only; any RPC. Run on a schedule (Railway cron or the keeper host) and page on
// `alert`.
//
//   paused                      alert while config.paused (someone pulled the guardian switch)
//   INV-2                       alert if reserved_total > u_max × (equity − inventory cost); warn above 80%
//   INV-13 cash                 alert if vault USDC < reserved cash (reserved − advances + unearned + queued deposits)
//   inventory marks             warn when a held xStock's mark is older than 15 minutes (share prices wait for it)
//   lending valuation           warn when the lent position's valuation is older than 15 minutes
//   live groups                 info: how many weekends are live, the oldest one
// Usage: pnpm tsx src/monitor.ts [--json]   (RPC_URL)
import anchor from '@anchor-lang/core';
import { connect, pdas } from './lib/credence.js';

type Conn = InstanceType<typeof anchor.web3.Connection>;
export type Line = { level: 'ok' | 'warn' | 'alert'; what: string };
const MARK_MAX_AGE = 900;

export async function checks(conn: Conn, program: any): Promise<Line[]> {
  const out: Line[] = [];
  const [cfg, v, clock] = await Promise.all([
    program.account.config.fetch(pdas.config()),
    program.account.vault.fetch(pdas.vault()),
    conn.getAccountInfo(anchor.web3.SYSVAR_CLOCK_PUBKEY),
  ]);
  const now = Number(clock!.data.readBigInt64LE(32));
  const n = (x: { toString(): string }) => BigInt(x.toString());
  out.push(cfg.paused ? { level: 'alert', what: 'protocol paused' } : { level: 'ok', what: 'not paused' });
  const invCost = (v.inv as { cost: { toString(): string } }[]).reduce((a, s) => a + n(s.cost), 0n);
  const limit = ((n(v.equity) - invCost) * n(cfg.uMaxWad)) / 10n ** 18n;
  const reserved = n(v.reservedTotal);
  const util = limit > 0n ? Number((reserved * 10_000n) / limit) / 100 : reserved > 0n ? Infinity : 0;
  out.push({ level: reserved > limit ? 'alert' : util > 80 ? 'warn' : 'ok', what: `INV-2 utilisation ${util.toFixed(2)}% (reserved ${reserved}, limit ${limit})` });
  const cash = BigInt((await conn.getTokenAccountBalance(pdas.vaultUsdc())).value.amount);
  const keep = reserved - n(v.advancedLive ?? 0) + n(v.premiumsUnearned) + n(v.queuedDeposits);
  out.push({ level: cash < keep ? 'alert' : 'ok', what: `INV-13 cash ${cash} ≥ reserved cash ${keep}` });
  for (const s of v.inv as { ticker: number[]; cost: { toString(): string }; markedAt: { toString(): string } }[]) {
    if (n(s.cost) === 0n) continue;
    const age = now - Number(n(s.markedAt));
    out.push({ level: age > MARK_MAX_AGE ? 'warn' : 'ok', what: `inventory ${Buffer.from(s.ticker).toString().replace(/\0+$/, '')} marked ${age}s ago` });
  }
  if (n(v.lentCtokens ?? 0) > 0n) {
    const age = now - Number(n(v.lentValuedAt));
    out.push({ level: age > MARK_MAX_AGE ? 'warn' : 'ok', what: `lending valued ${age}s ago (${n(v.lentValue)} lent)` });
  }
  const live = (v.live as number[]).filter((g) => g !== 0).sort();
  out.push({ level: 'ok', what: `${live.length} live weekend(s)${live.length ? `, oldest ${live[0]}` : ''}` });
  return out;
}

if (process.argv[1]?.endsWith('monitor.ts')) {
  const { conn, program } = connect(process.env.RPC_URL ?? 'http://127.0.0.1:8899');
  checks(conn, program).then((r) => {
    if (process.argv.includes('--json')) console.log(JSON.stringify(r));
    else for (const l of r) console.log(`${l.level.padEnd(5)} ${l.what}`);
    process.exit(r.some((l) => l.level === 'alert') ? 2 : 0);
  }).catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
}
