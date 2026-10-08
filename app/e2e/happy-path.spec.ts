// The judge's path (task 4.5): connect the demo burner, fund it, take a real mainnet position, buy gap protection
// with one click, run demo mode (Friday close → Monday open −8% → settle) and see the payout land in the position.
// Then: the Underwriters page shows exactly the vault's on-chain values.
import { expect, test } from '@playwright/test';
import { fixed, usdc } from '../src/lib/format';
import { chainVault } from './chain';

const REAL = 'p2D7cLwDgSXwwMxbnverJVAMACkTb8ruURGKBfsyuoQ'; // eligible near-threshold SPYx obligation from the mainnet scan

test('burner → real position → buy cover → demo weekend → payout', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('connect').click();
  await page.getByTestId('use-burner').click();
  await page.getByTestId('fund').click();
  await expect(page.getByTestId('usdc')).toHaveText('50,000.00');
  await expect(page.getByTestId('program-id')).toBeVisible();

  await page.getByTestId('real-positions').click();
  await page.getByTestId(`take-${REAL}`).click();
  const card = page.getByTestId('position').first();
  await expect(card.getByTestId('loss-table')).toBeVisible();
  await expect(card.getByTestId('premium')).toHaveText(/USDC/);
  const quoted = await card.getByTestId('premium').innerText();
  await card.getByTestId('buy').click();
  await expect(card.getByTestId('policy-result')).toBeVisible({ timeout: 90_000 });
  const premium = await card.getByTestId('policy-premium').innerText();
  // The premium paid is within max_premium = quote + 2% slippage + 0.01 USDC (the quote can move with the refresh).
  const num = (s: string) => Number(s.replace(/,/g, '').match(/[\d.]+/)![0]);
  expect(num(premium)).toBeGreaterThan(0);
  expect(num(premium)).toBeLessThanOrEqual(num(quoted) * 1.02 + 0.015);
  await expect(card.getByTestId('signature')).toHaveText(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);

  await page.locator('nav.tabs').getByRole('link', { name: 'Demo mode' }).click();
  await page.getByTestId('demo-close').click();
  await expect(page.getByTestId('demo-log')).toContainText('close done', { timeout: 90_000 });
  await page.getByTestId('demo-gap').selectOption('-0.08');
  await page.getByTestId('demo-open').click();
  await expect(page.getByTestId('demo-log')).toContainText('open done', { timeout: 90_000 });
  await page.getByTestId('demo-settle').click();
  await expect(page.getByTestId('demo-log')).toContainText('settle done', { timeout: 90_000 });
  await expect(page.getByTestId('demo-log')).toContainText('settle_policy');
  await expect(page.getByTestId('demo-log')).not.toContainText('FAIL');
  // A real position pays only what the gap requires (it may already be healthy enough after an earlier demo payout).
  const payouts = await page.getByTestId('demo-payout').allInnerTexts();
  expect(payouts.length).toBeGreaterThan(0);
  expect(payouts.every((p) => Number(p.replace(/,/g, '')) >= 0)).toBeTruthy();

  await page.locator('nav.tabs').getByRole('link', { name: 'My weekend risk' }).click();
  await expect(page.getByTestId('policies')).toContainText('settled');
});

test('bigger position created on the fork → cover → −8% weekend → payout over 1,000 USDC', async ({ page }) => {
  await page.goto('/demo');
  await page.getByTestId('connect').click();
  await page.getByTestId('use-burner').click();
  await page.getByTestId('fund').click();
  await expect(page.getByTestId('usdc')).toHaveText('50,000.00');
  await page.getByTestId('demo-create').click();
  await expect(page.getByTestId('demo-log')).toContainText('create done', { timeout: 120_000 });

  await page.locator('nav.tabs').getByRole('link', { name: 'My weekend risk' }).click();
  const card = page.getByTestId('position').first();
  await expect(card).toContainText('created on the fork');
  await expect(card.getByTestId('premium')).toHaveText(/USDC/);
  await card.getByTestId('buy').click();
  await expect(card.getByTestId('policy-result')).toBeVisible({ timeout: 90_000 });

  await page.locator('nav.tabs').getByRole('link', { name: 'Demo mode' }).click();
  await page.getByTestId('demo-close').click();
  await expect(page.getByTestId('demo-log')).toContainText('close done', { timeout: 90_000 });
  await page.getByTestId('demo-gap').selectOption('-0.08');
  await page.getByTestId('demo-open').click();
  await expect(page.getByTestId('demo-log')).toContainText('open done', { timeout: 90_000 });
  await page.getByTestId('demo-settle').click();
  await expect(page.getByTestId('demo-log')).toContainText('settle done', { timeout: 90_000 });
  await expect(page.getByTestId('demo-log')).not.toContainText('FAIL');
  const payouts = (await page.getByTestId('demo-payout').allInnerTexts()).map((p) => Number(p.replace(/,/g, '')));
  expect(Math.max(...payouts)).toBeGreaterThan(1_000);
});

test('Underwriters shows the vault exactly as stored', async ({ page }) => {
  await page.goto('/underwriters');
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
