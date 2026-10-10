// Program events from transaction logs: every event credence_core emits (CoverBought, ShieldAdvanced, PolicySettled,
// BookOpened, BookLegAdded, BookSealed, BookVoided, BookLegRemoved, BookLegSettled, BookRefundClaimed, GapFeedUpdated, …),
// decoded with the embedded IDL.
import { BorshCoder, EventParser } from '@anchor-lang/core';
import { IDL, PROGRAM_ID, camelKeys } from './core';

export type CredenceEvent = { name: string; data: Record<string, unknown> };

/** The names of every event in the embedded IDL. */
export const EVENT_NAMES: readonly string[] = ((IDL as unknown as { events?: { name: string }[] }).events ?? []).map((e) => e.name);

/** Decodes the events in `logs` (a transaction's `meta.logMessages` or a simulation's `logs`). Other programs' logs are skipped. */
export function parseEvents(logs: readonly string[]): CredenceEvent[] {
  const parser = new EventParser(PROGRAM_ID, new BorshCoder(IDL));
  return [...parser.parseLogs([...logs])].map((e) => ({ name: e.name, data: camelKeys(e.data as Record<string, unknown>) }));
}

/** Events with one of `names` only. */
export const eventsNamed = (logs: readonly string[], ...names: string[]) => parseEvents(logs).filter((e) => names.includes(e.name));
