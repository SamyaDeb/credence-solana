import { defineConfig } from 'vitest/config';

// The SDK is linked from ../sdk (its own node_modules): resolve the three shared libraries once, from here, so there
// is one PublicKey class (the same rule a host must follow; test/single-copy.test.ts attacks it).
export default defineConfig({
  resolve: { dedupe: ['@solana/web3.js', '@anchor-lang/core', 'bn.js', 'react', 'react-dom'] },
  test: { include: ['test/**/*.test.{ts,tsx}'], environment: 'jsdom', setupFiles: ['./test/setup.ts'], testTimeout: 30_000, server: { deps: { inline: [/@credence\/sdk/] } } },
});
