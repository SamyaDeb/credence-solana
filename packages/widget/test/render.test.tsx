// c4b_no_js_math, golden half: what the tables show is the SDK’s value, formatted — nothing recomputed.
import { render, screen, cleanup } from '@testing-library/react';
import { WAD, riskView, wadPct } from '@credence/sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { RiskTable, fmtUsdc } from '../src';

afterEach(cleanup);
const z = new Int16Array(Array.from({ length: 2000 }, (_, i) => i - 1000));

describe('RiskTable shows riskView’s numbers', () => {
  const r = riskView({ coveredValue: 10_000_000_000n, debt: 9_500_000_000n }, z, WAD / 50n);
  it('D/C′, the probability and the −5/−8/−12 repayments, to the unit', () => {
    render(<RiskTable risk={r} />);
    expect(screen.getByTestId('d-over-c')).toHaveTextContent(wadPct(r.debtOverCoveredWad!));
    expect(screen.getByTestId('p-liq')).toHaveTextContent(`${r.pays.count} of ${r.pays.n}`);
    expect(screen.getByTestId('repay--500')).toHaveTextContent(fmtUsdc(r.repay[0].amount));
    expect(screen.getByTestId('repay--800')).toHaveTextContent('300.00');
    expect(screen.getByTestId('repay--1200')).toHaveTextContent('700.00');
  });
});
