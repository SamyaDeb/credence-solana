import { describe, expect, it } from 'vitest';
import { Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  CORE_ERRORS, CoreError, EVENT_NAMES, IDL, IDL_HASH, KLEND, MixedLenderError, ProgramError, TxError, assertNoJupiterWithKlend, checkProgram, coreErrorCode,
  decodeError, eventsNamed, hashIdl, parseEvents, redact, toError, touchesJupiter, withSlippage, IdlMismatchError, PROGRAM_ID, pdas,
} from '../src/index';

describe('errors', () => {
  it('maps every CoreError code of the IDL and no two share one', () => {
    expect(CORE_ERRORS.size).toBe(IDL.errors.length);
    expect(new Set(IDL.errors.map((e) => e.code)).size).toBe(IDL.errors.length);
    expect(coreErrorCode('FeedTooSoon')).toBe(CORE_ERRORS.get(coreErrorCode('FeedTooSoon'))!.code);
    expect(() => coreErrorCode('NoSuchError')).toThrow();
  });
  it('turns a Custom error of credence_core into a typed CoreError with its logs', () => {
    const code = coreErrorCode('NotPushAccount');
    const e = toError({ InstructionError: [1, { Custom: code }] }, ['Program log: x'], [KLEND, PROGRAM_ID]);
    expect(e).toBeInstanceOf(CoreError);
    expect((e as CoreError).errorName).toBe('NotPushAccount');
    expect((e as CoreError).logs).toEqual(['Program log: x']);
    expect(e.message).toMatch(/^CoreError::NotPushAccount \(\d+\)/);
  });
  it('CoreError and ProgramError are TxErrors, so callers that test instanceof TxError keep working (A-137)', () => {
    const c = toError({ InstructionError: [0, { Custom: coreErrorCode('Paused') }] }, [], [PROGRAM_ID]);
    expect(c).toBeInstanceOf(CoreError);
    expect(c).toBeInstanceOf(TxError);
    expect(toError({ InstructionError: [0, { Custom: 1 }] }, [], [KLEND])).toBeInstanceOf(TxError);
  });
  it('names klend errors as klend’s, and falls back to a TxError', () => {
    const k = toError({ InstructionError: [0, { Custom: 6004 }] }, ['Program log: AnchorError thrown in x'], [KLEND]);
    expect(k).toBeInstanceOf(ProgramError);
    expect(k.message).toMatch(/Kamino klend error 6004/);
    expect(toError({ InstructionError: [0, 'ComputationalBudgetExceeded'] }, ['Program x failed: exceeded'], [PROGRAM_ID])).toBeInstanceOf(TxError);
    expect(decodeError({ InstructionError: [0, { Custom: coreErrorCode('Paused') }] }, [], [PROGRAM_ID])).toMatch(/CoreError::Paused/);
  });
  it('never leaks an RPC key', () => {
    const e = new TxError('failed at https://mainnet.helius-rpc.com/?api-key=SECRET123 and key=abc');
    expect(e.message).not.toMatch(/SECRET123|abc/);
    expect(redact('http://127.0.0.1:8899/x')).toBe('http://127.0.0.1:8899/x');
  });
});

describe('events', () => {
  it('knows every event the program emits, including the C2 book events and the feed', () => {
    for (const n of ['CoverBought', 'ShieldAdvanced', 'PolicySettled', 'BookOpened', 'BookLegAdded', 'BookSealed', 'BookVoided', 'BookLegRemoved', 'BookLegSettled', 'BookRefundClaimed', 'GapFeedUpdated']) {
      expect(EVENT_NAMES, n).toContain(n);
    }
  });
  it('decodes a GapFeedUpdated from a "Program data:" log and ignores other programs’ logs', () => {
    // GapFeedUpdated { ticker [u8;8], closure_id u32, flags u32, slot u64, ts i64 }: discriminator from the IDL, then borsh.
    const ev = (IDL as unknown as { events: { name: string; discriminator: number[] }[] }).events.find((e) => e.name === 'GapFeedUpdated')!;
    const body = Buffer.alloc(8 + 4 + 4 + 8 + 8);
    Buffer.from('SPYx').copy(body, 0);
    body.writeUInt32LE(20261009, 8);
    body.writeUInt32LE(0x30000, 12);
    body.writeBigUInt64LE(7n, 16);
    body.writeBigInt64LE(99n, 24);
    const data = Buffer.concat([Buffer.from(ev.discriminator), body]);
    const logs = ['Program 11111111111111111111111111111111 invoke [1]', `Program data: ${Buffer.from(data).toString('base64')}`, 'Program log: other'];
    // The parser only reads data lines inside credence_core's invoke frame.
    const framed = [`Program ${PROGRAM_ID.toBase58()} invoke [1]`, logs[1], `Program ${PROGRAM_ID.toBase58()} success`];
    const evs = eventsNamed(framed, 'GapFeedUpdated');
    expect(evs).toHaveLength(1);
    expect(Number(evs[0].data.closureId)).toBe(20261009);
    expect(Number(evs[0].data.flags)).toBe(0x30000);
    expect(parseEvents(logs)).toHaveLength(0);
  });
});

describe('guard: Jupiter Lend never shares a transaction with klend', () => {
  const ix = (programId: PublicKey, keys: PublicKey[] = [], data: Buffer = Buffer.alloc(8)) =>
    new TransactionInstruction({ programId, keys: keys.map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })), data });
  const disc = (name: string) => Buffer.from((IDL.instructions as unknown as { name: string; discriminator: number[] }[]).find((i) => i.name === name)!.discriminator);
  const jl = new PublicKey('jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi');

  it('refuses klend + Jupiter’s program, + a Jupiter account, + any *_jl instruction of credence_core', () => {
    const refresh = ix(KLEND);
    expect(() => assertNoJupiterWithKlend([refresh, ix(jl)])).toThrow(MixedLenderError);
    expect(() => assertNoJupiterWithKlend([refresh, ix(PROGRAM_ID, [jl])])).toThrow(MixedLenderError);
    for (const n of ['buy_cover_jl', 'add_book_leg_jl', 'settle_policy_jl', 'shield_advance_jl']) {
      expect(touchesJupiter(ix(PROGRAM_ID, [], disc(n))), n).toBe(true);
      expect(() => assertNoJupiterWithKlend([refresh, ix(PROGRAM_ID, [], disc(n))]), n).toThrow(MixedLenderError);
    }
  });
  it('allows klend with the Kamino buys, and Jupiter without klend', () => {
    const refresh = ix(KLEND);
    for (const n of ['buy_cover', 'buy_cover_multi', 'buy_cover_up', 'add_book_leg', 'release_book_leg']) {
      expect(() => assertNoJupiterWithKlend([refresh, ix(PROGRAM_ID, [], disc(n))]), n).not.toThrow();
    }
    expect(() => assertNoJupiterWithKlend([ix(PROGRAM_ID, [], disc('buy_cover_jl'))])).not.toThrow();
  });
  it('every instruction ending in _jl is covered by the discriminator list', () => {
    for (const i of IDL.instructions as unknown as { name: string; discriminator: number[] }[]) {
      if (/_jl$/.test(i.name)) expect(touchesJupiter(ix(PROGRAM_ID, [], Buffer.from(i.discriminator))), i.name).toBe(true);
    }
  });
});

describe('slippage', () => {
  it('rounds the bound up and rejects nonsense', () => {
    expect(withSlippage(1_000_000n, 100)).toBe(1_010_000n);
    expect(withSlippage(5_000_001n, 1)).toBe(5_000_502n);
    expect(withSlippage(7n, 0)).toBe(7n);
    expect(() => withSlippage(1n, -1)).toThrow(RangeError);
    expect(() => withSlippage(1n, 10_001)).toThrow(RangeError);
    expect(() => withSlippage(1n, 1.5)).toThrow(RangeError);
  });
});

describe('IDL version check', () => {
  it('the embedded hash is the hash of the embedded IDL', async () => {
    expect(await hashIdl(IDL)).toBe(IDL_HASH);
  });
  it('refuses a missing, non-executable or re-laid-out program and accepts a matching one', async () => {
    const conn = (program: unknown, config: unknown, idlAccount: unknown = null) => ({
      getAccountInfo: async (k: PublicKey) => (k.equals(PROGRAM_ID) ? program : k.equals(pdas.config()) ? config : idlAccount),
    }) as never;
    await expect(checkProgram(conn(null, null))).rejects.toBeInstanceOf(IdlMismatchError);
    await expect(checkProgram(conn({ executable: false }, null))).rejects.toThrow(/no executable program/);
    const { BorshAccountsCoder } = await import('@anchor-lang/core');
    const coder = new BorshAccountsCoder(IDL);
    const disc = Buffer.from(coder.accountDiscriminator('Config'));
    const size = coder.size('Config');
    const good = Buffer.concat([disc, Buffer.alloc(size - 8)]);
    await expect(checkProgram(conn({ executable: true }, { data: Buffer.concat([disc, Buffer.alloc(size - 9)]) }))).rejects.toThrow(/the program changed/);
    await expect(checkProgram(conn({ executable: true }, { data: Buffer.concat([Buffer.alloc(8), Buffer.alloc(size - 8)]) }))).rejects.toThrow(/discriminator/);
    const ok = await checkProgram(conn({ executable: true }, { data: good }));
    expect(ok.verified).toBe('layout');
    expect(ok.idlHash).toBe(IDL_HASH);
    await expect(checkProgram(conn({ executable: true }, { data: good }), { strict: true })).rejects.toThrow(/strict/);
  });
});

describe('sanity', () => {
  it('Keypair import works in this environment', () => expect(Keypair.generate().publicKey).toBeInstanceOf(PublicKey));
});
