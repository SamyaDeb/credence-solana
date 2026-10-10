// The security headers of the public build: CSP, framing, referrer. Checked on the config's own builder; the built site is
// checked again in e2e (public.spec.ts).
import { describe, expect, it } from 'vitest';
import { securityHeaders } from '../security-headers';

const get = (hs: { key: string; value: string }[], k: string) => hs.find((h) => h.key === k)?.value;

describe('security headers', () => {
  const pub = securityHeaders(true);
  it('the public build forbids framing two ways, sets a referrer policy and a CSP that allows only itself', () => {
    expect(get(pub, 'X-Frame-Options')).toBe('DENY');
    expect(get(pub, 'Referrer-Policy')).toBeTruthy();
    expect(get(pub, 'X-Content-Type-Options')).toBe('nosniff');
    const csp = get(pub, 'Content-Security-Policy')!;
    for (const d of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'", "connect-src 'self'"]) expect(csp, d).toContain(d);
    expect(csp).not.toMatch(/\*|https?:|unsafe-eval/);
  });
  it('unsafe-eval is for dev only', () => {
    expect(get(securityHeaders(true, true), 'Content-Security-Policy')).toContain("'unsafe-eval'");
  });
  it('the fork build keeps the framing and referrer headers but no CSP (it talks to a local RPC)', () => {
    const fork = securityHeaders(false);
    expect(get(fork, 'X-Frame-Options')).toBe('DENY');
    expect(get(fork, 'Content-Security-Policy')).toBeUndefined();
  });
});
