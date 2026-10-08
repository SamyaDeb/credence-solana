// The demo video's shots in order, at 1920×1080. Each `hold` leaves time for the voice-over; `show` scrolls an element
// to the middle of the frame. Every number on screen comes from the fork, a data/ file or a transaction.
import { type Locator, type Page, expect, test } from '@playwright/test';

const hold = (page: Page, s: number) => page.waitForTimeout(s * 1000);
const show = async (l: Locator) => l.evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
const nav = (page: Page, name: string) => page.locator('.cx-side').getByRole('link', { name, exact: true }).click();

test('demo video', async ({ page }) => {
  // 0:00 Landing: the problem in one line.
  await page.goto('/');
  await hold(page, 5);
  await page.mouse.wheel(0, 900);
  await hold(page, 5);

  // 0:15 Risk: the Gap Oracle, the frozen weekend price and S7.
  await page.goto('/app/risk');
  await expect(page.getByTestId('oracle-SPYx')).toBeVisible();
  await hold(page, 8);
  await show(page.getByTestId('s7'));
  await hold(page, 8);

  // 0:35 Faucet: the demo burner, funded on the fork.
  await nav(page, 'Faucet');
  await page.getByTestId('connect').click();
  await page.getByTestId('use-burner').click();
  await page.getByTestId('fund').click();
  await expect(page.getByTestId('usdc')).toHaveText('50,000.00');
  await hold(page, 2);

  // 0:45 Demo mode: the $50,000 SPYx position at D/C′ 0.96.
  await nav(page, 'Demo mode');
  await page.getByTestId('demo-create').click();
  await expect(page.getByTestId('demo-log')).toContainText('create done', { timeout: 180_000 });
  await hold(page, 3);

  // 1:00 Borrow: the position, the Bell check and the loss table.
  await nav(page, 'Borrow');
  const card = page.getByTestId('position').first();
  await expect(card.getByTestId('loss-table')).toBeVisible();
  await hold(page, 6);
  await show(card.getByTestId('loss-table'));
  await hold(page, 9);

  // 1:20 The quote and the chance it pays; buy in one transaction.
  await expect(card.getByTestId('pay-odds').first()).toBeVisible();
  await show(card.getByTestId('premium'));
  await hold(page, 10);
  await card.getByTestId('buy').click();
  await expect(card.getByTestId('policy-result')).toBeVisible({ timeout: 120_000 });
  await show(card.getByTestId('policy-result'));
  await hold(page, 7);

  // 1:50 The weekend: Friday close → Monday −8% → settle into the position.
  await nav(page, 'Demo mode');
  await show(page.getByTestId('demo-close'));
  await hold(page, 2);
  await page.getByTestId('demo-close').click();
  await expect(page.getByTestId('demo-log')).toContainText('close done', { timeout: 120_000 });
  await hold(page, 3);
  await page.locator('[data-gap="-0.08"]').click();
  await page.getByTestId('demo-open').click();
  await expect(page.getByTestId('demo-log')).toContainText('open done', { timeout: 120_000 });
  await hold(page, 3);
  await page.getByTestId('demo-settle').click();
  await expect(page.getByTestId('demo-log')).toContainText('settle done', { timeout: 120_000 });
  await hold(page, 3);
  await show(page.getByTestId('before-after'));
  await hold(page, 9);
  await show(page.getByTestId('simulated'));
  await hold(page, 5);

  // 2:25 Underwrite: the vault from the chain and the backtest.
  await nav(page, 'Underwrite');
  await expect(page.getByTestId('vault')).toBeVisible();
  await hold(page, 6);
  await show(page.getByTestId('backtest'));
  await hold(page, 9);

  // 2:45 Markets: the three xStocks priced for the next weekend.
  await nav(page, 'Markets');
  await expect(page.getByTestId('row-SPYx')).toBeVisible();
  await hold(page, 6);
});
