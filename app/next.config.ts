import { join } from 'node:path';
import type { NextConfig } from 'next';

// Server routes read ../data and spawn ../keeper at runtime (paths from process.cwd(), see lib/server/fork.ts). For a
// deploy (the public read-only mode), the data/ files the read routes need are traced into the functions; the keeper and
// the fork tools are not (they refuse to run there).
const DATA = ['../data/onchain/**/*', '../data/sigma/closure-gaps.json', '../data/sigma/sigma-floor.json', '../data/backtest/gap-cover-backtest.json',
  '../data/live/s7-history.json', '../data/positions/positions-*.json'];

// @credence/sdk is linked from ../packages/sdk (its own node_modules): make the app's copy of these the only one the
// SDK sees, so a PublicKey built in the app and one built in the SDK are the same class.
const ONE_COPY = ['@solana/web3.js', '@anchor-lang/core', 'bn.js'];

const config: NextConfig = {
  reactStrictMode: true,
  turbopack: { resolveAlias: Object.fromEntries(ONE_COPY.map((p) => [p, join(__dirname, 'node_modules', p)])) },
  webpack: (c) => {
    for (const p of ONE_COPY) c.resolve.alias[p] = join(__dirname, 'node_modules', p);
    return c;
  },
  // klend-sdk builds Kamino instructions in a server route (api/kamino/build); it runs from node_modules, unbundled.
  serverExternalPackages: ['@kamino-finance/klend-sdk'],
  outputFileTracingRoot: join(__dirname, '..'),
  outputFileTracingIncludes: {
    '/api/data/*': DATA, '/api/oracle/*': DATA, '/api/scan': DATA, '/api/positions/*': DATA,
    // C1 (audit A-74): the credit-unlock analysis, read by /api/unlock only.
    '/api/unlock': ['../data/unlock/unlock-*.json'],
  },
};
export default config;
