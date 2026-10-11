// Response headers for every page and route (next.config.ts). Plain relative module so the config and the tests share it.
// The CSP is for the public read-only build (NEXT_PUBLIC_NETWORK=mainnet): everything the site loads is its own, the browser
// reads mainnet through the same-origin /api/rpc proxy, and nothing may frame it. Next's own bootstrap and the landing's
// first-paint class need inline scripts, so script-src carries 'unsafe-inline' (no nonce pipeline); there is no eval in production.
// Wallets: the Android Mobile Wallet Adapter reaches the wallet app over a websocket on localhost; WalletConnect, only when
// a project id is configured, needs Reown's relay, API, verify frame and fonts.
export type Header = { key: string; value: string };

const MWA = 'ws://localhost:*';
const WC = {
  connect: ['wss://relay.walletconnect.com', 'wss://relay.walletconnect.org', 'https://rpc.walletconnect.com', 'https://rpc.walletconnect.org',
    'https://pulse.walletconnect.org', 'https://api.web3modal.org', 'https://api.web3modal.com', 'https://verify.walletconnect.com', 'https://verify.walletconnect.org'],
  img: ['https://api.web3modal.org', 'https://api.web3modal.com', 'https://imagedelivery.net'],
  frame: ['https://verify.walletconnect.com', 'https://verify.walletconnect.org', 'https://secure.walletconnect.org'],
  font: ['https://fonts.reown.com'],
};

export function csp(dev = false, walletConnect = false): string {
  const wc = (k: keyof typeof WC) => (walletConnect ? ` ${WC[k].join(' ')}` : '');
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob:${wc('img')}`,
    `font-src 'self' data:${wc('font')}`,
    "media-src 'self' blob:",
    `connect-src 'self' ${MWA}${wc('connect')}`,
    `frame-src 'self'${wc('frame')}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders(mainnet: boolean, dev = false, walletConnect = false): Header[] {
  const h: Header[] = [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()' },
  ];
  if (mainnet) {
    h.push({ key: 'Content-Security-Policy', value: csp(dev, walletConnect) });
    h.push({ key: 'Strict-Transport-Security', value: 'max-age=31536000' });
  }
  return h;
}
