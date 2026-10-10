// Errors: the program's CoreError mapped by code from the embedded IDL, klend's numbers named as klend's, and
// simulation logs decoded to one readable line. `redact` keeps RPC keys out of every message.
import type { PublicKey } from '@solana/web3.js';
import { IDL, KLEND, PROGRAM_ID } from './core';
import { redact } from './redact';

export type CoreErrorInfo = { code: number; name: string; msg: string };
/** Every `CoreError` of the embedded IDL by code. */
export const CORE_ERRORS: ReadonlyMap<number, CoreErrorInfo> = new Map(IDL.errors.map((e) => [e.code, { code: e.code, name: e.name, msg: e.msg ?? e.name }]));
/** `CoreError` by name, e.g. `coreErrorCode('BookNotOpen')`. */
export const coreErrorCode = (name: string): number => {
  const e = IDL.errors.find((x) => x.name === name);
  if (!e) throw new Error(`no CoreError named ${name} in this program's IDL`);
  return e.code;
};

/** A refusal by credence_core, with its name, code and message, and the simulation logs when there are any. */
export class CoreError extends Error {
  constructor(readonly code: number, readonly errorName: string, message: string, readonly logs: string[] = []) {
    super(redact(`CoreError::${errorName} (${code}): ${message}`));
    this.name = 'CoreError';
  }
}
/** A refusal by klend (or another program) inside the same transaction. */
export class ProgramError extends Error {
  constructor(readonly program: string, readonly code: number, message: string, readonly logs: string[] = []) {
    super(redact(message));
    this.name = 'ProgramError';
  }
}
/** A failed simulation or transaction that is neither of the above (compute, signature, account, …). */
export class TxError extends Error {
  constructor(message: string, readonly logs: string[] = [], readonly stage: 'simulate' | 'send' = 'simulate') {
    super(redact(message));
    this.name = 'TxError';
  }
}

function customOf(err: unknown): { ix: number; code: number | null; raw?: string } | null {
  const e = err as { InstructionError?: [number, { Custom?: number } | string] } | null;
  if (e && Array.isArray(e.InstructionError)) {
    const [ix, inner] = e.InstructionError;
    if (inner && typeof inner === 'object' && typeof inner.Custom === 'number') return { ix, code: inner.Custom };
    return { ix, code: null, raw: JSON.stringify(inner) };
  }
  return null;
}

/** Turns a failed simulation or transaction into one readable line: the CoreError name and message for credence_core,
 * the klend error number otherwise, else the last program log. `ixPrograms[i]` is the program of instruction i. */
export function decodeError(err: unknown, logs: string[] | null | undefined, ixPrograms: PublicKey[] = []): string {
  const anchorLog = (logs ?? []).find((l) => l.includes('AnchorError'));
  const custom = customOf(err);
  if (custom && custom.code !== null) {
    const prog = ixPrograms[custom.ix];
    if (!prog || prog.equals(PROGRAM_ID)) {
      const e = CORE_ERRORS.get(custom.code);
      if (e) return `CoreError::${e.name} (${e.code}): ${e.msg}`;
    }
    if (prog?.equals(KLEND)) return `Kamino klend error ${custom.code} in instruction ${custom.ix}${anchorLog ? ` — ${anchorLog.replace(/^Program log: /, '')}` : ''}`;
    return `custom error ${custom.code} in instruction ${custom.ix}${prog ? ` (${prog.toBase58().slice(0, 8)}…)` : ''}`;
  }
  if (anchorLog) return anchorLog.replace(/^Program log: /, '');
  const last = [...(logs ?? [])].reverse().find((l) => /failed|Error/.test(l));
  return last ?? (custom ? `instruction ${custom.ix}: ${custom.raw ?? ''}` : JSON.stringify(err));
}

/** The typed error for a failed simulation or transaction: `CoreError`, `ProgramError` (klend) or `TxError`. */
export function toError(err: unknown, logs: string[] | null | undefined, ixPrograms: PublicKey[] = [], stage: 'simulate' | 'send' = 'simulate'): Error {
  const l = logs ?? [];
  const c = customOf(err);
  if (c && c.code !== null) {
    const prog = ixPrograms[c.ix];
    if (!prog || prog.equals(PROGRAM_ID)) {
      const e = CORE_ERRORS.get(c.code);
      if (e) return new CoreError(e.code, e.name, e.msg, l);
    }
    if (prog) return new ProgramError(prog.toBase58(), c.code, decodeError(err, logs, ixPrograms), l);
  }
  return new TxError(decodeError(err, logs, ixPrograms), l, stage);
}
