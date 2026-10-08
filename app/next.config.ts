import { join } from 'node:path';
import type { NextConfig } from 'next';

// Server routes read ../data and spawn ../keeper at runtime (paths from process.cwd(), see lib/server/fork.ts). For a
// deploy (the public read-only mode), the data/ files the read routes need are traced into the functions; the keeper and
// the fork tools are not (they refuse to run there).
const DATA = ['../data/onchain/**/*', '../data/sigma/closure-gaps.json', '../data/sigma/sigma-floor.json', '../data/backtest/gap-cover-backtest.json',
  '../data/live/s7-history.json', '../data/positions/positions-*.json'];

const config: NextConfig = {
  reactStrictMode: true,
  // klend-sdk builds Kamino instructions in a server route (api/kamino/build); it runs from node_modules, unbundled.
  serverExternalPackages: ['@kamino-finance/klend-sdk'],
  outputFileTracingRoot: join(__dirname, '..'),
  outputFileTracingIncludes: { '/api/data/*': DATA, '/api/oracle/*': DATA, '/api/scan': DATA, '/api/positions/*': DATA },
};
export default config;
