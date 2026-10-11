// Solana wallets the connect dialog offers when they are not already in the browser. Wallets that are installed register
// themselves through the wallet standard and are listed from there; this catalog only supplies, for the well-known ones,
// where to get the wallet on a desktop and how to open this page inside the wallet's own browser on a phone (a phone
// browser has no extensions, so that, the Mobile Wallet Adapter on Android, or WalletConnect is how a phone connects).

export type KnownWallet = {
  /** The name the wallet registers under in the wallet standard (matched case-insensitively). */
  name: string;
  /** Where to install the wallet on a desktop. */
  install: string;
  /** A universal link that opens `url` in the wallet app's in-app browser (installs the app first if it is missing). */
  browse?: (url: string, ref: string) => string;
};

const enc = encodeURIComponent;

export const KNOWN_WALLETS: KnownWallet[] = [
  { name: 'Phantom', install: 'https://phantom.com/download', browse: (u, r) => `https://phantom.app/ul/browse/${enc(u)}?ref=${enc(r)}` },
  { name: 'Solflare', install: 'https://solflare.com/download', browse: (u, r) => `https://solflare.com/ul/v1/browse/${enc(u)}?ref=${enc(r)}` },
  { name: 'Backpack', install: 'https://backpack.app/download', browse: (u, r) => `https://backpack.app/ul/v1/browse/${enc(u)}?ref=${enc(r)}` },
  { name: 'OKX', install: 'https://www.okx.com/web3', browse: (u) => `https://www.okx.com/download?deeplink=${enc(`okx://wallet/dapp/url?dappUrl=${enc(u)}`)}` },
  { name: 'Coinbase', install: 'https://www.coinbase.com/wallet/downloads', browse: (u) => `https://go.cb-w.com/dapp?cb_url=${enc(u)}` },
  { name: 'Trust', install: 'https://trustwallet.com/download', browse: (u) => `https://link.trustwallet.com/open_url?coin_id=501&url=${enc(u)}` },
  { name: 'Magic Eden', install: 'https://wallet.magiceden.io/download' },
];

const sameName = (a: string, b: string) => a.toLowerCase().replace(/\s+wallet$/, '') === b.toLowerCase().replace(/\s+wallet$/, '');

/** The catalog entries that are not among the wallet names already found in the browser. */
export function missingWallets(found: string[]): KnownWallet[] {
  return KNOWN_WALLETS.filter((k) => !found.some((f) => sameName(f, k.name)));
}

/** A phone or tablet browser (no wallet extensions; wallets are apps). */
export function isMobileBrowser(ua = typeof navigator === 'undefined' ? '' : navigator.userAgent): boolean {
  return /android|iphone|ipad|ipod|mobile/i.test(ua) || (/macintosh/i.test(ua) && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
}

/** WalletConnect's project id (from cloud.reown.com). Without one WalletConnect is not offered. */
export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '';
