import type { NextConfig } from 'next';

// Server routes read ../data and spawn ../keeper at runtime (paths from process.cwd(), see lib/server/fork.ts); they
// are not bundled or traced.
const config: NextConfig = {
  reactStrictMode: true,
};
export default config;
