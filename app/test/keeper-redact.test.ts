// Audit A-17: the keeper prints its RPC URL at startup and error text from keeper steps; it must mask keys exactly as
// the app does (keys in the query or in the URL path), with one implementation per package kept identical.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { redact as appRedact } from '@/lib/redact';

const samples = [
  'https://mainnet.helius-rpc.com/?api-key=abc123-def',
  'error sending request for url (https://solana-mainnet.g.alchemy.com/v2/AlchemyKey123)',
  'https://young-dawn-123.solana-mainnet.quiknode.pro/QnToken456/',
  'http://127.0.0.1:8899',
];

describe('keeper redaction', () => {
  it('matches the app on every sample and hides every key', async () => {
    const { redact } = await import('../../keeper/src/redact');
    for (const s of samples) {
      expect(redact(s)).toBe(appRedact(s));
      expect(redact(s)).not.toMatch(/abc123|AlchemyKey123|QnToken456|young-dawn-123/);
    }
  });

  it('is the only masking in the keeper', () => {
    for (const f of ['index.ts', 'app-step.ts', 'create-position.ts']) {
      const src = readFileSync(new URL(`../../keeper/src/${f}`, import.meta.url), 'utf8');
      expect(src, f).not.toMatch(/api\[-_\]\?key/);
      expect(src, f).toContain("from './redact.js'");
    }
  });
});
