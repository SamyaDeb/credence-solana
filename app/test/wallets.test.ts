// The connect dialog's wallet catalog: which known wallets count as already found, and the phone links.
import { describe, expect, it } from 'vitest';
import { KNOWN_WALLETS, isMobileBrowser, missingWallets } from '../src/lib/wallets';

describe('wallet catalog', () => {
  it('drops the wallets found in the browser, matching "X Wallet" to "X" and ignoring case', () => {
    const names = missingWallets(['Phantom', 'OKX Wallet', 'coinbase wallet']).map((k) => k.name);
    expect(names).not.toContain('Phantom');
    expect(names).not.toContain('OKX');
    expect(names).not.toContain('Coinbase');
    expect(names).toContain('Solflare');
  });
  it('phone links open this exact page inside the wallet app, URL-encoded', () => {
    const url = 'https://credence.example/app/borrow?x=1';
    const phantom = KNOWN_WALLETS.find((k) => k.name === 'Phantom')!;
    expect(phantom.browse!(url, 'https://credence.example')).toBe(
      'https://phantom.app/ul/browse/https%3A%2F%2Fcredence.example%2Fapp%2Fborrow%3Fx%3D1?ref=https%3A%2F%2Fcredence.example');
    for (const k of KNOWN_WALLETS) if (k.browse) expect(k.browse(url, 'https://credence.example')).toMatch(/^https:\/\//);
  });
  it('tells phones from desktops by user agent', () => {
    expect(isMobileBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(true);
    expect(isMobileBrowser('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile')).toBe(true);
    expect(isMobileBrowser('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126')).toBe(false);
  });
});
