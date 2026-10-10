// Everything a host hands the widget is validated here before it is used: a position is a 32-byte base58 key (a string or
// our own PublicKey class), a lender is one of two words. Error messages never echo the input.
import { PublicKey } from '@solana/web3.js';
import { InputError, SingleCopyError } from './errors';

export type Lender = 'kamino' | 'jupiter';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function toPublicKey(v: unknown, what: string): PublicKey {
  if (v instanceof PublicKey) return v;
  if (typeof v === 'string') {
    if (!BASE58.test(v)) throw new InputError(`${what} must be a base58 Solana address`);
    try { return new PublicKey(v); } catch { throw new InputError(`${what} must be a base58 Solana address`); }
  }
  // Same shape, not our class: the signature of two bundled copies of @solana/web3.js.
  if (v && typeof v === 'object' && typeof (v as { toBase58?: unknown }).toBase58 === 'function') throw new SingleCopyError(`The ${what}`);
  throw new InputError(`${what} must be a base58 Solana address`);
}

export function parseLender(v: unknown): Lender {
  if (v === 'kamino' || v === 'jupiter') return v;
  throw new InputError('lender must be "kamino" or "jupiter"');
}
