import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { IDL, PROGRAM_ID, pdas, program } from '../src/index';
import { GAP_DISCLAIMER, GAP_SIDE, gapBand, gapInitSeries, gapMergeSet, gapMintSet, gapOwed, gapPdas, gapRate, gapRedeem, gapSeriesView, gapSettleSeries, gapExpireSeries, gapSplit } from '../src/gap';

const prog = program(new Connection('http://127.0.0.1:1'));
const rand = () => Keypair.generate().publicKey;
const golden = JSON.parse(readFileSync(new URL('./fixtures/gap-golden.json', import.meta.url), 'utf8')) as { band: [string, string][]; split: [string, string, number, number][] };
const idlAccounts = (name: string) => {
  const i = (IDL.instructions as any[]).find((x) => x.name === name);
  return i.accounts.length as number;
};
const series = { key: rand(), downMint: rand(), upMint: rand(), collateral: rand(), ticker: 'SPYx', closureId: 20261009 };

describe('gap tokens (research prototype, not offered)', () => {
  it('states the disclaimer', () => {
    expect(GAP_DISCLAIMER).toBe('research prototype, not offered');
  });
  it('derives the program accounts from the seeds', () => {
    const s = gapPdas.series('SPYx', 20261009);
    expect(PublicKey.findProgramAddressSync([Buffer.from('gseries'), Buffer.from('SPYx\0\0\0\0'), Buffer.from(new Uint8Array(new Uint32Array([20261009]).buffer))], PROGRAM_ID)[0].equals(s)).toBe(true);
    expect(new Set([gapPdas.down(s), gapPdas.up(s), gapPdas.collateral(s)].map((k) => k.toBase58())).size).toBe(3);
  });
  it('every builder has the IDL account count', async () => {
    const user = rand();
    expect((await gapInitSeries(prog, { payer: user, ticker: 'SPYx', closureId: 20261009, closureType: 2 })).keys.length).toBe(idlAccounts('init_gap_series'));
    const mint = await gapMintSet(prog, { user, series, amount: 1n });
    expect(mint.length).toBe(3);
    expect(mint[2].keys.length).toBe(idlAccounts('mint_gap_set'));
    expect((await gapMergeSet(prog, { user, series, amount: 1n })).keys.length).toBe(idlAccounts('merge_gap_set'));
    expect((await gapSettleSeries(prog, { caller: user, series })).keys.length).toBe(idlAccounts('settle_gap_series'));
    expect((await gapExpireSeries(prog, { caller: user, series })).keys.length).toBe(idlAccounts('expire_gap_series'));
    expect((await gapRedeem(prog, { user, series, side: GAP_SIDE.UP, amount: 1n })).keys.length).toBe(idlAccounts('redeem_gap'));
  });
  it('merge and redeem touch no config, so a pause cannot block them', async () => {
    const user = rand();
    const cfg = pdas.config().toBase58();
    for (const ix of [await gapMergeSet(prog, { user, series, amount: 1n }), await gapRedeem(prog, { user, series, side: 0, amount: 1n }), await gapSettleSeries(prog, { caller: user, series })]) {
      expect(ix.keys.some((k) => k.pubkey.toBase58() === cfg)).toBe(false);
    }
  });
  it('reads the series account into one shape', () => {
    const s: any = {
      ticker: [...Buffer.from('SPYx\0\0\0\0')], closureId: 20261009, closureType: 2, state: 1, downMint: rand(), upMint: rand(), collateral: rand(), kWad: '100000000000000000',
      bell: '1791575100', expiresAt: '1793000000', setsOutstanding: '1000000000', downMicro: 900_000, upMicro: 100_000, closePriceWad: '1', settlePriceWad: '1', closeSource: 2,
      settledAt: '5', setsSettled: '1000000000', poolDown: '900000000', poolUp: '100000000', redeemedDown: '1', redeemedUp: '0', paidDown: '0', paidUp: '0',
    };
    const v = gapSeriesView(rand(), s);
    expect(v.state).toBe('settled');
    expect(gapRate(v, 0)).toBe(900_000);
    expect(gapOwed(v)).toEqual({ down: 900_000_000n, up: 100_000_000n });
    expect(gapRate({ ...v, state: 'open' }, 1)).toBeNull();
    expect(gapOwed({ ...v, state: 'open' })).toBeNull(); // open: the pools are 0, setsOutstanding backs the tokens
  });
  it('the display port equals risk-core::gap_token on the golden vectors', () => {
    expect(golden.band.length).toBeGreaterThan(5);
    for (const [sigma, k] of golden.band) expect(gapBand(BigInt(sigma)).toString()).toBe(k);
    for (const [r, k, d, u] of golden.split) {
      const [dn, up] = gapSplit(BigInt(r), BigInt(k));
      expect([dn, up]).toEqual([d, u]);
      expect(dn + up).toBe(1_000_000);
    }
  });
});
