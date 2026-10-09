// The main user path: connect the demo burner, fund it, take a real mainnet position, buy gap cover in one click, run a
// demo weekend (Friday close → Monday open −8% → settle) and see the policy settled; then the $50,000 demo position
// paying over 1,000 USDC at −8%.
import { expect, test } from '@playwright/test';
import { amount, burner, buyCover, demoWeekend } from './helpers';

const REAL = 'p2D7cLwDgSXwwMxbnverJVAMACkTb8ruURGKBfsyuoQ'; // eligible near-threshold SPYx obligation from the mainnet scan

test('burner → real position → buy cover → demo weekend → settled into the position', async ({ page }) => {
  await burner(page);
  await page.goto('/app/borrow');
  await page.getByTestId('real-positions').click();
  await page.getByTestId(`take-${REAL}`).click();
  const card = page.getByTestId('position').first();
  await expect(card.getByTestId('loss-table')).toBeVisible();
  await expect(card).toContainText('real mainnet position, owner rewritten on the fork');
  const { quoted, paid } = await buyCover(page);
  // The premium paid is within max_premium = quote + 2% slippage + 0.01 USDC (the quote can move with the refresh).
  expect(amount(paid)).toBeGreaterThan(0);
  expect(amount(paid)).toBeLessThanOrEqual(amount(quoted) * 1.02 + 0.015);
  await expect(card.getByTestId('buy-sent').getByTestId('signature')).toHaveText(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
  await expect(card.getByTestId('buy-sent').getByTestId('cu')).toHaveText(/[\d,]+ CU/);

  const payouts = await demoWeekend(page);
  // A real position pays only what the gap requires (it may already be healthy after an earlier demo payout).
  expect(payouts.length).toBeGreaterThan(0);
  expect(payouts.every((p) => p >= 0)).toBeTruthy();
  await expect(page.getByTestId('demo-log')).toContainText('settle_policy');

  await page.goto('/app/borrow');
  await expect(page.getByTestId('policies')).toContainText('settled');
  await page.goto('/app/alerts');
  await expect(page.getByTestId('alert-payout').first()).toBeVisible();
});

test('the $50,000 demo position → cover → −8% weekend → payout over 1,000 USDC into it', async ({ page }) => {
  await burner(page);
  await page.goto('/app/demo');
  await page.getByTestId('demo-create').click();
  await expect(page.getByTestId('demo-log')).toContainText('create done', { timeout: 180_000 });
  await page.goto('/app/borrow');
  const card = page.getByTestId('position').first();
  await expect(card).toContainText('created on the fork');
  await expect(card.getByTestId('premium')).toHaveText(/USDC/);
  // The premium is shown with the model's chance of paying and the historical count.
  await expect(card.getByTestId('pay-odds').first()).toContainText(/Chance this pays anything this weekend: [\d.<]+%.* of \d+ market closures/);
  if (process.env.SHOTS) await card.screenshot({ path: '../docs/app/quote-with-odds.png' });
  await buyCover(page);
  const payouts = await demoWeekend(page);
  expect(Math.max(...payouts)).toBeGreaterThan(1_000);
  await page.goto('/app/account');
  await expect(page.getByTestId('account-paid')).toHaveText(/\d/);
  await expect.poll(async () => amount(await page.getByTestId('account-paid').innerText())).toBeGreaterThan(1_000);
});
