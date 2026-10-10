import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  // The SDK is linked from ../packages/sdk (its own node_modules): inline it and resolve the shared libraries from the
  // app, so there is one PublicKey class.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    dedupe: ['@solana/web3.js', '@anchor-lang/core', 'bn.js'],
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 60_000, server: { deps: { inline: [/server-only/, /@credence\/sdk/] } } },
});
