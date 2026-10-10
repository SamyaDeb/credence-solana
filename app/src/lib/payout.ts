// The payout rule lives in @credence/sdk (risk.ts, vector-tested against the Rust); the app re-exports it so there is one copy.
export { realizedPayout, gapped, payoutAtGap } from '@credence/sdk';
