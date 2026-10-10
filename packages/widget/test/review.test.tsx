// Regression tests for the code review of the widget (audit A-162 to A-171), each failing before its fix.
import { render, cleanup, screen } from '@testing-library/react';
import { PublicKey } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';
import { CredenceProtect, GapLine, fmtUsdc, type ProtectState } from '../src';
import { FORK_GENESIS, fakeConn, spyWallet } from './fakes';

afterEach(cleanup);
const POSITION = '11111111111111111111111111111112';

describe('A-162: GapLine calls the same hooks on every render', () => {
  it('a state without a feed, then the same instance with one, does not crash', () => {
    const base = { ticker: 'SPYx', now: 1_000_000, feedProblems: [] } as unknown as ProtectState;
    const feed = { impliedGapFair: 12_300_000_000_000_000n, impliedGapLender: 0n, lenderFrozen: true, lenderSinceTs: 999_000 } as never;
    const { rerender } = render(<GapLine state={{ ...base, feed: null }} />);
    expect(() => rerender(<GapLine state={{ ...base, feed }} />)).not.toThrow();
    expect(screen.getByTestId('gap-fair')).toHaveTextContent('1.23%');
    expect(screen.getByRole('region', { name: /weekend gap/i })).toBeTruthy(); // aria-labelledby points at the heading
  });
});

describe('A-164: a host that passes fresh but equal props does not reload the widget', () => {
  it('a new PublicKey object and a new upkeep object with the same values load once', async () => {
    const conn = fakeConn({ genesis: FORK_GENESIS });
    const w = spyWallet();
    const el = () => <CredenceProtect connection={conn} wallet={w} position={new PublicKey(POSITION)} lender="kamino" upkeep={{ offline: async () => {} }} />;
    const { rerender } = render(el());
    await screen.findByRole('alert');
    const loads = conn.calls.filter((c) => c === 'getGenesisHash').length;
    rerender(el()); rerender(el());
    await new Promise((r) => setTimeout(r, 50));
    expect(conn.calls.filter((c) => c === 'getGenesisHash').length).toBe(loads);
  });
});

describe('A-168: the "at most" premium is never shown lower than the signed bound', () => {
  it('rounds up when asked, truncates by default', () => {
    expect(fmtUsdc(1_239_999n)).toBe('1.23');
    expect(fmtUsdc(1_239_999n, 'up')).toBe('1.24');
    expect(fmtUsdc(1_230_000n, 'up')).toBe('1.23');
    expect(fmtUsdc(999_999n, 'up')).toBe('1.00');
    expect(fmtUsdc(-1_000_001n, 'up')).toBe('-1.01');
  });
});
