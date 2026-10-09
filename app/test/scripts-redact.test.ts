// Audit A-73: the scripts print their top-level errors, and surfpool quotes its datasource URL (the RPC key in the
// query) in "Failed to fetch accounts from remote" errors: `demo.sh` and `demo-app.sh` wrote the key into their logs.
// Every script's top-level catch masks with the same redaction as the app and the keeper.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { redact as appRedact } from '@/lib/redact';

const DIR = new URL('../../scripts/src/', import.meta.url);

describe('scripts redaction', () => {
  it('matches the app', async () => {
    const { redact } = await import('../../scripts/src/lib/redact');
    for (const s of ['error sending request for url (https://mainnet.helius-rpc.com/?api-key=abc123-def)', 'http://127.0.0.1:8909']) {
      expect(redact(s)).toBe(appRedact(s));
    }
  });

  it('every top-level catch prints through redact', () => {
    for (const f of readdirSync(DIR).filter((x) => x.endsWith('.ts'))) {
      const src = readFileSync(new URL(f, DIR), 'utf8');
      expect(src, f).not.toMatch(/\.catch\(\(e\) => \{ console\.error\(e\);/);
    }
  });
});
