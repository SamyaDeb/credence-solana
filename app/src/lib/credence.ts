// The app's view of credence_core is @credence/sdk (packages/sdk): program client, PDAs, constants and the embedded IDL.
// This file only adds the app's own RPC setting. test/keeper-parity.test.ts checks the keeper derives the same addresses.
export * from '@credence/sdk';
export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? 'http://127.0.0.1:8899';
