import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// ONE COPY of three libraries. @credence/sdk and @credence/widget are linked from this repo (each has its own node_modules),
// so without these aliases the SDK would load its own web3.js and a PublicKey made in the page would not be the SDK's class.
// A host that skips this gets SingleCopyError from the widget (test/guards.test.tsx, c4b_single_copy), not a silent failure.
const here = (p: string) => fileURLToPath(new URL(`./node_modules/${p}`, import.meta.url));
const ONE_COPY = ['@solana/web3.js', '@anchor-lang/core', 'bn.js', 'react', 'react-dom'];

export default defineConfig({
  plugins: [react()],
  resolve: { alias: Object.fromEntries(ONE_COPY.map((p) => [p, here(p)])), dedupe: ONE_COPY },
  define: { global: 'globalThis' },
  // The fork tooling lives in the Credence app (scripts/demo-app.sh serves it): the host reaches it same-origin through this
  // proxy. A real host would use its own backend; the widget only ever sees the two functions in main.tsx.
  server: { proxy: { '/fork': { target: process.env.APP_ORIGIN ?? 'http://127.0.0.1:3005', changeOrigin: true, rewrite: (p) => p.replace(/^\/fork/, '/api/fork') } } },
});
