import type { NextConfig } from 'next';

// Server routes read ../data and spawn ../keeper at runtime (paths from process.cwd(), see lib/server/fork.ts); they
// are not bundled or traced.
const config: NextConfig = {
  reactStrictMode: true,
  // klend-sdk builds Kamino instructions in a server route (api/kamino/build); it runs from node_modules, unbundled.
  serverExternalPackages: ['@kamino-finance/klend-sdk'],
};
export default config;
