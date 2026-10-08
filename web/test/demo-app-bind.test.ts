// Audit A-12: the app's server routes run fork cheatcodes and spawn keeper steps; scripts/demo-app.sh must serve it on
// 127.0.0.1 only (next binds every interface by default), so nobody else on the network can call them.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('demo-app.sh', () => {
  it('serves the app on 127.0.0.1 only', () => {
    const sh = readFileSync(new URL('../../scripts/demo-app.sh', import.meta.url), 'utf8');
    const starts = sh.split('\n').filter((l) => /pnpm -s (dev|start)\b/.test(l));
    expect(starts.length).toBe(2);
    for (const l of starts) expect(l).toContain('-H 127.0.0.1');
  });
});
