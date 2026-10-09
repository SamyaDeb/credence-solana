// Audit A-49: the keeper's PYUSD sleeve target parses SLEEVE_TARGET_PYUSD safely: a malformed value must not throw
// (BigInt(NaN) did, failing the sleeve job every pass) and falls back to 0 (keep exactly the INV-14 need).
import { describe, expect, it } from 'vitest';
import { sleeveTarget } from '../../keeper/src/sleeve';

describe('sleeveTarget', () => {
  it('parses a number of PYUSD into base units', () => {
    expect(sleeveTarget('250000')).toBe(250_000_000_000n);
    expect(sleeveTarget(' 12.5 ')).toBe(12_500_000n);
  });
  it('treats missing, malformed or negative values as 0 instead of throwing', () => {
    for (const v of [undefined, '', '10k', 'abc', '-5', 'Infinity']) expect(sleeveTarget(v)).toBe(0n);
  });
});
