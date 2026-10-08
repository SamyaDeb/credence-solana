// Underwrite shows the vault exactly as stored: each figure equals the Vault and share-mint accounts decoded by byte
// offset here (e2e/chain.ts), independent of the app's Anchor decoding.
import { expect, test } from '@playwright/test';
import { fixed, usdc } from '../src/lib/format';
import { chainVault } from './chain';

test('Underwrite shows the vault exactly as stored', async ({ page }) => {
  await page.goto('/app/underwrite');
  await expect(page.getByTestId('vault-equity')).toBeVisible();
  const v = await chainVault();
  expect(await page.getByTestId('vault-equity').innerText()).toBe(`${usdc(v.equity)}USDC`);
  expect(await page.getByTestId('vault-nav').innerText()).toBe(`${fixed(v.nav6, 6, 6)}USDC`);
  expect(await page.getByTestId('vault-unearned').innerText()).toBe(`${usdc(v.unearned)}USDC`);
  expect(await page.getByTestId('vault-earned').innerText()).toBe(`${usdc(v.earned)}USDC`);
  expect(await page.getByTestId('vault-reserved').innerText()).toBe(`${usdc(v.reserved)}USDC`);
  expect(await page.getByTestId('vault-payouts').innerText()).toBe(`${usdc(v.payouts)}USDC`);
  expect(await page.getByTestId('vault-live').innerText()).toBe(String(v.liveGroups));
});

test('Markets shows the three covered xStocks with live values and a quote', async ({ page }) => {
  await page.goto('/app/markets');
  for (const t of ['SPYx', 'QQQx', 'NVDAx']) {
    const row = page.getByTestId(`row-${t}`);
    await expect(row).toContainText(/\$\d[\d,]*\.\d{4}/);
    await expect(row.getByTestId('per1k')).toHaveText(/USDC|closed/);
  }
  await expect(page.getByTestId('usdc-apy')).toHaveText(/\d+\.\d\d%/);
});
