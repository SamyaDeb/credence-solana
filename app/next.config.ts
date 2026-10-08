import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

const config: NextConfig = {
  reactStrictMode: true,
  // The repo root, so server routes can read data/ and spawn the keeper.
  turbopack: { root: fileURLToPath(new URL('..', import.meta.url)) },
  outputFileTracingRoot: fileURLToPath(new URL('..', import.meta.url)),
};
export default config;
