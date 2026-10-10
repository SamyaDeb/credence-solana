import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';
import { IDL, KLEND, PROGRAM_ID, pdas, program } from '../src/index';
import { Connection } from '@solana/web3.js';
import { WSM_MARKET, addonAprBps, weekendStatus, wsmAutoCover, wsmBorrow, wsmClaim, wsmDeposit, wsmOpen, wsmPdas, wsmReopen, wsmRepay, wsmWithdraw } from '../src/wsm';
import type { EpochView } from '../src/cover';

const prog = program(new Connection('http://127.0.0.1:1'));
const user = Keypair.generate().publicKey;
const rand = () => Keypair.generate().publicKey;
const reserveState = (): any => ({
  liquidity: { supplyVault: rand().toBase58(), feeVault: rand().toBase58() },
  collateral: { mintPubkey: rand().toBase58(), supplyVault: rand().toBase58() },
});

describe('addresses', () => {
  it('WSM_MARKET is the program constant', () => {
    const src = readFileSync(new URL('../../../programs/credence-core/src/kamino.rs', import.meta.url), 'utf8');
    expect(src).toContain(`pub const WSM_MARKET: Pubkey = pubkey!("${WSM_MARKET.toBase58()}")`);
  });
  it('derives the program accounts and the klend obligation from the seeds', () => {
    const a = wsmPdas.account(user);
    expect(PublicKey.findProgramAddressSync([Buffer.from('wsm'), user.toBuffer()], PROGRAM_ID)[0].equals(a)).toBe(true);
    expect(wsmPdas.obligation(a).equals(wsmPdas.obligation(a))).toBe(true);
    expect(wsmPdas.obligation(a).equals(wsmPdas.obligation(wsmPdas.account(rand())))).toBe(false);
  });
});

describe('builders', () => {
  const names = (ix: { keys: { pubkey: PublicKey }[] }) => new Set(ix.keys.map((k) => k.pubkey.toBase58()));
  const idlAccounts = (name: string) => {
    const i = (IDL.instructions as any[]).find((x) => x.name === name);
    const flat = (l: any[]): number => l.reduce((n, a) => n + (a.accounts ? flat(a.accounts) : 1), 0);
    return flat(i.accounts);
  };
  it('every user instruction has the IDL’s account count', async () => {
    const coll = rand();
    const rs = reserveState();
    const open = await wsmOpen(prog, { user, ticker: 'SPYx', coll });
    expect(open.keys.length).toBe(idlAccounts('wsm_open'));
    expect((await wsmReopen(prog, { user })).keys.length).toBe(idlAccounts('wsm_reopen'));
    const dep = await wsmDeposit(prog, { user, ticker: 'SPYx', coll, amount: 1n, reserve: rand(), reserveState: rs });
    expect(dep[dep.length - 1].keys.length).toBe(idlAccounts('wsm_deposit'));
    const bor = await wsmBorrow(prog, { user, amount: 1n, usdcReserve: rand(), usdcState: rs, refreshes: [] });
    expect(bor[bor.length - 1].keys.length).toBe(idlAccounts('wsm_borrow'));
    const rep = await wsmRepay(prog, { user, amount: 1n, usdcReserve: rand(), usdcState: rs, refreshes: [] });
    expect(rep[rep.length - 1].keys.length).toBe(idlAccounts('wsm_repay'));
    const wd = await wsmWithdraw(prog, { user, coll, collateral: 1n, reserve: rand(), reserveState: rs, refreshes: [] });
    expect(wd[wd.length - 1].keys.length).toBe(idlAccounts('wsm_withdraw'));
    expect((await wsmClaim(prog, { user })).keys.length).toBe(idlAccounts('wsm_claim'));
    const epoch = { key: rand(), closureId: 20261009, closureType: 2 } as EpochView;
    const cover = await wsmAutoCover(prog, { payer: rand(), user, ticker: 'SPYx', epoch, usdcReserve: rand(), usdcState: rs, collateralReserve: rand(), feeAccount: rand(), refreshes: [] });
    expect(cover.ixs[cover.ixs.length - 1].keys.length).toBe(idlAccounts('wsm_auto_cover'));
  });
  it('the exits read no config, vault, loss, policy or epoch (INV-17), and claim reads nothing of the market', async () => {
    const rs = reserveState();
    const coll = rand();
    const rep = (await wsmRepay(prog, { user, amount: 1n, usdcReserve: rand(), usdcState: rs, refreshes: [] }))[0];
    const wd = (await wsmWithdraw(prog, { user, coll, collateral: 1n, reserve: rand(), reserveState: rs, refreshes: [] }))[0];
    const claim = await wsmClaim(prog, { user });
    const forbidden = [pdas.config(), pdas.vault(), pdas.vaultUsdc(), pdas.shares()].map((k) => k.toBase58());
    for (const ix of [rep, wd, claim]) for (const f of forbidden) expect(names(ix).has(f), `${f}`).toBe(false);
    // repay reads no calendar either; withdraw reads it only for the freeze guard (a missing or unusable one fails open).
    expect(names(rep).has(pdas.calendar().toBase58())).toBe(false);
    expect(names(claim).has(wsmPdas.market().toBase58())).toBe(false);
  });
  it('never mixes Jupiter with klend', async () => {
    const rs = reserveState();
    const jup = new PublicKey('jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi');
    const bad = { programId: jup, keys: [], data: Buffer.alloc(0) } as any;
    const refresh = { programId: KLEND, keys: [], data: Buffer.alloc(0) } as any;
    await expect(wsmBorrow(prog, { user, amount: 1n, usdcReserve: rand(), usdcState: rs, refreshes: [refresh, bad] })).rejects.toThrow(/Jupiter/);
  });
});

describe('status', () => {
  const ep = (closureId: number, bell: number, settleAfter: number, type = 2): EpochView => ({ key: rand(), ticker: 'SPYx', closureId, closureType: type, state: 0, saleOpen: bell - 5 * 86400, bell, close: bell + 900, open: settleAfter - 300, settleAfter } as EpochView);
  it('is open until the freeze starts, frozen through the weekend, and open again after the settlement window', () => {
    const e = [ep(20261009, 1_000_000, 1_240_000)];
    const freeze = 4 * 3600;
    expect(weekendStatus(e, 'SPYx', 1_000_000 - freeze - 1, freeze).phase).toBe('open');
    expect(weekendStatus(e, 'SPYx', 1_000_000 - freeze, freeze).phase).toBe('frozen');
    expect(weekendStatus(e, 'SPYx', 1_239_999, freeze).phase).toBe('frozen');
    expect(weekendStatus(e, 'SPYx', 1_240_000, freeze).phase).toBe('open');
    expect(weekendStatus([ep(1, 100, 200, 1)], 'SPYx', 150, freeze).closureId).toBeNull(); // overnights are not covered
  });
  it('quotes the add-on as a yearly rate on the covered debt, rounded up', () => {
    expect(addonAprBps(1_000_000n, 6_100_000_000n)).toBe(86n); // 0.85% a year
    expect(addonAprBps(0n, 5n)).toBe(0n);
    expect(addonAprBps(1n, 0n)).toBe(0n);
  });
});
