// @vitest-environment node
// The bundle-size budget, measured on the built package (`pnpm build`) and enforced here. The widget ships only its own code:
// React, the SDK and the three single-copy libraries are peers. Budget = about 1.5x the size when first measured
// (6.6 KB gzip JS, 1.3 KB CSS, Oct 10): room for a few features, not for a dependency sneaking in.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const dist = (f: string) => readFileSync(join(process.cwd(), 'dist', f));
const gz = (b: Buffer) => gzipSync(b, { level: 9 }).length;
const BUDGET = { esm: 10 * 1024, cjs: 11 * 1024, css: 2 * 1024 };

describe('bundle size budget (gzip)', () => {
  it('ESM JS, CJS JS and the stylesheet are within budget', () => {
    expect(gz(dist('index.js')), 'index.js').toBeLessThanOrEqual(BUDGET.esm);
    expect(gz(dist('index.cjs')), 'index.cjs').toBeLessThanOrEqual(BUDGET.cjs);
    expect(gz(dist('style.css')), 'style.css').toBeLessThanOrEqual(BUDGET.css);
  });
  it('peers stay external: nothing of React, web3.js, anchor, bn.js or the SDK is bundled in', () => {
    const esm = dist('index.js').toString();
    for (const peer of ['react', 'react/jsx-runtime', '@credence/sdk', '@solana/web3.js']) expect(esm, peer).toContain(`from "${peer}"`);
    expect(esm).not.toMatch(/class PublicKey|BorshAccountsCoder|jsxDEV|createElement\(|__SECRET_INTERNALS/);
  });
  it('ships both module formats, types and the stylesheet', () => {
    for (const f of ['index.js', 'index.cjs', 'index.d.ts', 'index.d.cts', 'style.css']) expect(dist(f).length, f).toBeGreaterThan(100);
  });
});
