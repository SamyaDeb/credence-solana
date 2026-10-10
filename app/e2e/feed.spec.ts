// The Gap Oracle feed on the Risk page (C3): one on-chain GapFeed per asset, all eight xStocks (and the Jupiter aliases),
// and a permissionless "Crank" that sends update_gap_feed from the connected wallet and updates the feed account.
import { expect, test } from '@playwright/test';
import { chainFeed, E2E_PDAS } from './chain';
import { burner } from './helpers';

const ALL = ['SPYx', 'QQQx', 'NVDAx', 'TSLAx', 'GOOGLx', 'AAPLx', 'MSTRx', 'HOODx'];

test('the Oracle page shows a feed row for all eight assets', async ({ page }) => {
  await page.goto('/app/risk');
  await expect(page.getByTestId('feed')).toBeVisible({ timeout: 90_000 });
  for (const t of ALL) {
    const row = page.getByTestId(`feed-row-${t}`);
    await expect(row).toBeVisible({ timeout: 90_000 });
    // σ and the three probabilities come from the asset's scenario set whatever the inputs are.
    await expect(page.getByTestId(`feed-p-${t}`)).toContainText(/\d+\.\d+% · \d+\.\d+% · \d+\.\d+%/);
    await expect(page.getByTestId(`feed-flags-${t}`)).toBeVisible();
  }
  // The Jupiter aliases that exist are listed too.
  await expect(page.getByTestId('feed-row-SPYx.J')).toBeVisible();
});

test('crank now updates the feed account', async ({ page }) => {
  await burner(page);
  await page.goto('/app/risk');
  const crank = page.getByTestId('feed-crank-SPYx');
  await expect(crank).toBeVisible({ timeout: 90_000 });
  const before = await chainFeed(E2E_PDAS.feedSPYx);
  expect(before.updates).toBeGreaterThan(0); // the keeper's setup pass created and cranked it
  // The program rate-limits a feed to one update per min_update_slots: wait for the slot.
  await expect.poll(async () => { const f = await chainFeed(E2E_PDAS.feedSPYx); return f.slot - f.lastUpdateSlot; }, { timeout: 180_000, intervals: [2_000] }).toBeGreaterThanOrEqual(155);
  await crank.click();
  await expect(page.getByTestId('feed-cranked')).toContainText('update_gap_feed SPYx', { timeout: 90_000 });
  const after = await chainFeed(E2E_PDAS.feedSPYx);
  expect(after.updates).toBe(before.updates + 1);
  expect(after.lastUpdateSlot).toBeGreaterThan(before.lastUpdateSlot);
});

test('cranking twice in a row is refused by the program’s rate limit, with its error', async ({ page }) => {
  await burner(page);
  await page.goto('/app/risk');
  const crank = page.getByTestId('feed-crank-QQQx');
  await expect(crank).toBeVisible({ timeout: 90_000 });
  await expect.poll(async () => (await page.getByTestId('feed-row-QQQx').innerText()).length > 0).toBe(true);
  await crank.click();
  await expect(page.getByTestId('feed-cranked').or(page.getByText(/FeedTooSoon|updated less than/))).toBeVisible({ timeout: 90_000 });
  await crank.click();
  await expect(page.getByText(/FeedTooSoon|updated less than min_update_slots/)).toBeVisible({ timeout: 90_000 });
});
