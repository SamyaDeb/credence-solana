// Gap tokens (D2): RESEARCH PROTOTYPE, NOT OFFERED. The page says so; a user mints complete sets, merges some back, minting stops
// when Credence is paused while merge stays open, and after the weekend settles at −8% the series pays DOWN more than UP, the
// redemptions add up to the collateral and the account ends empty.
import { expect, test } from '@playwright/test';
import { burner, demoStep, demoWeekend } from './helpers';

const n = (s: string) => Number(s.replace(/[$,\sUSDC]/g, ''));

test('gap tokens: mint, merge, pause, settle at −8%, redeem; always labelled a research prototype', async ({ page }) => {
  test.setTimeout(900_000);
  await demoStep(page, 'gap-open');
  await burner(page);
  await page.goto('/app/gap-tokens');

  // The labelling: the banner, the geofence wording, the metadata of the figure.
  await expect(page.getByTestId('gap-banner')).toHaveText('Research prototype, not offered.');
  await expect(page.getByTestId('gap-geo')).toContainText('Not offered in the United States or to US persons');
  await expect(page.locator('h1')).toContainText('research prototype');
  await expect(page.getByTestId('gap-row').first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('gap-state')).toContainText('open');
  await expect(page.getByTestId('gap-curve')).toBeVisible();

  // Mint 100 sets with the burner's USDC: 100 DOWN + 100 UP, and the collateral holds the 100 USDC.
  await page.getByTestId('gap-amount').fill('100');
  await page.getByTestId('gap-mint').click();
  await expect(page.getByTestId('gap-hold-down')).toHaveText('100.000000', { timeout: 120_000 });
  await expect(page.getByTestId('gap-hold-up')).toHaveText('100.000000');
  await expect(page.getByTestId('gap-collateral')).toContainText('100.000000 USDC');
  // Merge 10 back at par.
  await page.getByTestId('gap-amount').fill('10');
  await page.getByTestId('gap-merge').click();
  await expect(page.getByTestId('gap-hold-sets')).toHaveText('90.000000', { timeout: 120_000 });
  await expect(page.getByTestId('gap-collateral')).toContainText('90.000000 USDC');

  // Paused: minting stops, merge and the note about exits stay.
  await demoStep(page, 'wsm-pause');
  await page.reload();
  await expect(page.getByTestId('gap-paused')).toContainText('paused');
  await expect(page.getByTestId('gap-mint')).toBeDisabled();
  await expect(page.getByTestId('gap-merge')).toBeEnabled();
  await expect(page.getByTestId('gap-exit-note')).toContainText('never depend on Credence');
  await demoStep(page, 'wsm-unpause');

  // The weekend settles at −8%: the series settles on the epoch's own prices (the keeper's settle pass), DOWN pays more.
  await demoWeekend(page, '-0.08');
  await page.goto('/app/gap-tokens');
  // The page opens on the soonest open series; the weekend that just settled is listed after it.
  const done = page.getByTestId('gap-row').filter({ hasText: 'settled' }).first();
  await expect(done).toBeVisible({ timeout: 90_000 });
  await done.getByRole('radio').check();
  await expect(page.getByTestId('gap-state')).toContainText('settled', { timeout: 90_000 });
  await expect(page.getByTestId('gap-result')).toHaveText('settled');
  const down = n(await page.getByTestId('gap-down-pays').innerText());
  const up = n(await page.getByTestId('gap-up-pays').innerText());
  expect(down + up).toBeCloseTo(1, 6);
  expect(down).toBeGreaterThan(0.5);
  await expect(page.getByTestId('gap-curve-marker')).toBeVisible();
  await expect(page.getByTestId('gap-mint')).toBeDisabled();

  // Redeem both sides: the payouts are the 90 USDC of collateral, nothing is left.
  await page.getByTestId('gap-redeem-down').click();
  await expect(page.getByTestId('gap-hold-down')).toHaveText('0.000000', { timeout: 120_000 });
  await page.getByTestId('gap-redeem-up').click();
  await expect(page.getByTestId('gap-hold-up')).toHaveText('0.000000', { timeout: 120_000 });
  await expect(page.getByTestId('gap-collateral')).toContainText('0.000000 USDC');
  await expect(page.getByTestId('gap-owed')).toContainText('0.000000 USDC');
});
