// Kamino from the app: a burner given SPYx (fork cheatcode) deposits it, borrows USDC, repays and withdraws through
// klend-sdk's v2 instructions with the refreshes, each transaction shown with its signature and CU, and the obligation
// read back from the fork after each step.
import { type Page, expect, test } from '@playwright/test';
import { burner } from './helpers';

async function act(page: Page, tile: string, value: string) {
  await page.getByTestId(tile).first().click();
  const d = page.locator('dialog[open]');
  await d.getByTestId(`${tile}-amount`).fill(value);
  await d.getByTestId(`${tile}-confirm`).click();
  await expect(d.locator('.cx-hint.is-good')).toBeVisible({ timeout: 120_000 });
  await expect(d.getByTestId(`${tile}-error`)).toHaveCount(0);
  const sent = d.getByTestId(`${tile}-sent`);
  await expect(sent.getByTestId('signature').last()).toHaveText(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  await expect(sent.getByTestId('cu').last()).toHaveText(/[\d,]+ CU/);
  await d.getByRole('button', { name: 'Close' }).click();
}

test('Kamino round trip: deposit SPYx, borrow, repay, withdraw', async ({ page }) => {
  await burner(page);
  await page.getByTestId('xstock-amount').fill('20');
  await page.getByTestId('get-xstock').click();
  await expect(page.getByTestId('faucet-msg')).toContainText('SPYx balance set to 20');

  await page.goto('/app/borrow');
  await act(page, 'new-deposit', '20');
  const card = page.getByTestId('position').first();
  await expect(card).toBeVisible();
  await act(page, 'borrow', '5000');
  await expect(page.getByTestId('total-debt')).toHaveText(/^5,00\d$/);
  await expect(page.getByTestId('usdc')).toHaveText('55,000.00');
  await act(page, 'repay', '2000');
  await expect(page.getByTestId('total-debt')).toHaveText(/^3,00\d$/);
  await act(page, 'withdraw', '1');
  // 19 SPYx left as collateral: the Borrow tile's room shrinks, and the wallet holds 1 SPYx again.
  await page.goto('/app/account');
  await expect(page.getByTestId('usdc')).toHaveText('53,000.00');
  await expect(page.getByTestId('balance-SPYx')).toHaveText('1.0000 SPYx');
  await expect(page.getByTestId('account-paid')).toHaveText('0.00');
});
