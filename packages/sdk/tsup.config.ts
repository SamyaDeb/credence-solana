import { defineConfig } from 'tsup';

// ESM + CJS + types. The IDL (src/idl.json, synced from `anchor build`) is bundled, so a package consumer needs nothing
// from the repo. Node-only code (the book-quote helper spawn) is a separate entry so a browser bundle never sees it.
export default defineConfig({
  entry: { index: 'src/index.ts', node: 'src/node.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: false,
  target: 'es2022',
  external: ['@anchor-lang/core', '@solana/web3.js', '@kamino-finance/klend-sdk', 'bn.js'],
});
