// Response headers for every page and route (next.config.ts). Plain relative module so the config and the tests share it.
// The CSP is for the public read-only build (NEXT_PUBLIC_NETWORK=mainnet): everything the site loads is its own, the browser
// reads mainnet through the same-origin /api/rpc proxy, and nothing may frame it. Next's own bootstrap and the landing's
// first-paint class need inline scripts, so script-src carries 'unsafe-inline' (no nonce pipeline); there is no eval in production.
export type Header = { key: string; value: string };

export function csp(dev = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(mainnet: boolean, dev = false): Header[] {
  const h: Header[] = [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  ];
  if (mainnet) {
    h.push({ key: 'Content-Security-Policy', value: csp(dev) });
    h.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000' });
  }
  return h;
}
