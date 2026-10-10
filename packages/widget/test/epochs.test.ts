// @vitest-environment node
// The cover status must survive the weekend: after settlement no epoch is on sale, but the policy of the last weekend is still shown.
import { PublicKey } from '@solana/web3.js';
import { EPOCH, type EpochView } from '@credence/sdk';
import { describe, expect, it } from 'vitest';
import { policyEpochs } from '../src/load';

const ep = (ticker: string, closureType: number, state: number, bell: number): EpochView =>
  ({ key: PublicKey.unique(), ticker, closureId: bell, closureType, state, saleOpen: bell - 100, bell } as EpochView);

describe('policyEpochs', () => {
  it('this asset’s weekend epochs in any state, newest first', () => {
    const settled = ep('SPYx', 2, EPOCH.SETTLED, 100), open = ep('SPYx', 2, EPOCH.OPEN, 300), closed = ep('SPYx', 2, EPOCH.CLOSED, 200);
    const other = ep('QQQx', 2, EPOCH.OPEN, 400), overnight = ep('SPYx', 1, EPOCH.OPEN, 500);
    expect(policyEpochs([settled, other, open, overnight, closed], 'SPYx')).toEqual([open, closed, settled]);
  });
});
