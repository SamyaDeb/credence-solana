import { defineConfig } from 'tsup';

// ESM + CJS + types. Everything a host already has stays external (React, the SDK and the three single-copy libraries):
// the bundle is only this package's own code, which is what the size budget (scripts/size.mjs) measures.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: false,
  target: 'es2022',
  external: ['react', 'react-dom', 'react/jsx-runtime', '@credence/sdk', '@solana/web3.js', '@anchor-lang/core', 'bn.js'],
});
