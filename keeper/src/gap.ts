// Gap tokens (D2) keeper job: RESEARCH PROTOTYPE, NOT OFFERED. Opening is opt-in (GAP_TOKENS=1): off by default, so a keeper
// never pays rent for series nobody asked for; settling and expiring existing series is always on. Per pass:
//   - open: every epoch still open for sales with no series gets `init_gap_series` (permissionless; the program derives the
//     band and the mints from the epoch and the asset, nothing is chosen here);
//   - settle: a series whose epoch is SETTLED (after `post_settlement`) or VOIDED gets `settle_gap_series`;
//   - expire: a series whose epoch is still unsettled 14 days after it should have settled gets `expire_gap_series`.
// The keeper holds no tokens and takes no side; every instruction is one anyone may send.
import anchor from '@anchor-lang/core';
const { web3 } = anchor;
import { CLOSURE, EPOCH, PROGRAM_ID, TOKEN, TOKEN_2022, USDC_MINT, chainNow, log, pdas, send, tickerStr, type Chain } from './chain.js';

type Pk = InstanceType<typeof web3.PublicKey>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = { publicKey: Pk; account: any };
export type Report = { sent: string[]; failed: string[]; waiting: string[] };
const n = (x: { toNumber(): number } | number) => (typeof x === 'number' ? x : x.toNumber());

const u32le = (v: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(v);
  return b;
};
const pda = (seeds: Buffer[]) => web3.PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
export const gapPdas = {
  series: (t: string, closureId: number) => pda([Buffer.from('gseries'), Buffer.from(t.padEnd(8, '\0')), u32le(closureId)]),
  down: (s: Pk) => pda([Buffer.from('gdown'), s.toBuffer()]),
  up: (s: Pk) => pda([Buffer.from('gup'), s.toBuffer()]),
  collateral: (s: Pk) => pda([Buffer.from('gcoll'), s.toBuffer()]),
};

/** Opening series is opt-in (GAP_TOKENS=1, optionally only GAP_TICKERS=SPYx,QQQx); settling and expiring never are. */
export const gapEnabled = () => process.env.GAP_TOKENS === '1';
const gapTickers = () => (process.env.GAP_TICKERS ? new Set(process.env.GAP_TICKERS.split(',').map((x) => x.trim())) : null);

export async function gapJob(c: Chain): Promise<Report> {
  const r: Report = { sent: [], failed: [], waiting: [] };
  // One scan of the series; with opening off and none existing there is nothing to read (the default keeper pays no RPC for this job).
  const existingRows = (await c.program.account.gapSeries.all()) as Row[];
  if (!gapEnabled() && existingRows.length === 0) return r;
  const now = await chainNow(c);
  const epochs = (await c.program.account.epoch.all()) as Row[];
  const byKey = new Map(epochs.map((e) => [e.publicKey.toBase58(), e]));
  const existing = new Set(existingRows.map((s) => s.publicKey.toBase58()));
  const assets = gapEnabled() ? new Map(((await c.program.account.assetConfig.all()) as Row[]).map((a) => [tickerStr(a.account.ticker), a])) : new Map<string, Row>();

  // Open.
  const only = gapTickers();
  for (const e of gapEnabled() ? epochs : []) {
    const ep = e.account;
    const t = tickerStr(ep.ticker);
    if (only && !only.has(t)) continue;
    const series = gapPdas.series(t, ep.closureId);
    if (existing.has(series.toBase58()) || ep.state !== EPOCH.OPEN || n(ep.bell) <= now) continue;
    if (!assets.get(t) || assets.get(t)!.account.enabled !== 1) continue;
    if (ep.closureType === CLOSURE.OVERNIGHT && process.env.GAP_OVERNIGHT !== '1') continue; // weekends by default
    if (!(await c.conn.getAccountInfo(pdas.scen(t, ep.closureType)))) continue;
    const id = `init_gap_series ${t} ${ep.closureId}`;
    try {
      await send(c, [await c.program.methods.initGapSeries(ep.ticker, ep.closureId).accountsPartial({
        payer: c.payer.publicKey, config: pdas.config(), asset: assets.get(t)!.publicKey, scenarios: pdas.scen(t, ep.closureType), epoch: e.publicKey, earnings: pdas.earnings(t),
        series, downMint: gapPdas.down(series), upMint: gapPdas.up(series), collateral: gapPdas.collateral(series), usdcMint: USDC_MINT,
        tokenProgram: TOKEN, token2022Program: TOKEN_2022,
      }).instruction()]);
      r.sent.push(id);
      log(`  ok   ${id} (research prototype, not offered)`);
    } catch (err) {
      r.failed.push(id);
      log(`  FAIL ${id}: ${(err as Error).message.split('\n').slice(0, 3).join(' | ')}`);
    }
  }

  // Settle and expire.
  for (const s of existingRows) {
    const g = s.account;
    if (g.state !== 0) continue;
    const t = tickerStr(g.ticker);
    const epochKey = pdas.epoch(t, g.closureId);
    const ep = byKey.get(epochKey.toBase58())?.account;
    if (!ep) continue;
    const accts = { caller: c.payer.publicKey, series: s.publicKey, epoch: epochKey, downMint: g.downMint, upMint: g.upMint, token2022Program: TOKEN_2022 };
    if (ep.state === EPOCH.SETTLED || ep.state === EPOCH.VOIDED) {
      const id = `settle_gap_series ${t} ${g.closureId}`;
      try {
        await send(c, [await c.program.methods.settleGapSeries().accountsPartial(accts).instruction()]);
        r.sent.push(id);
        log(`  ok   ${id}`);
      } catch (err) {
        r.failed.push(id);
        log(`  FAIL ${id}: ${(err as Error).message.split('\n').slice(0, 3).join(' | ')}`);
      }
    } else if (now >= n(g.expiresAt)) {
      const id = `expire_gap_series ${t} ${g.closureId}`;
      try {
        await send(c, [await c.program.methods.expireGapSeries().accountsPartial(accts).instruction()]);
        r.sent.push(id);
        log(`  ok   ${id}`);
      } catch (err) {
        r.failed.push(id);
        log(`  FAIL ${id}: ${(err as Error).message.split('\n').slice(0, 3).join(' | ')}`);
      }
    } else {
      r.waiting.push(`${t} ${g.closureId}: epoch not settled yet`);
    }
  }
  return r;
}
