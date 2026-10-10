// Weekend-safe market (D1): the page shows the market's loan limits next to Kamino's, the add-on is the program's quote, and a
// user opens an account, deposits SPYx and borrows through the wrapper. Then the keeper's freeze pass covers the account; inside
// the freeze and with Credence paused the exits (repay, withdraw) still work and borrowing does not.
// This spec runs last (the freeze step moves the fork's clock to the next Friday).
import { expect, test } from '@playwright/test';
import { burner, demoStep } from './helpers';

const usd = (s: string) => Number(s.replace(/[$,]/g, ''));

test('limits next to Kamino’s, an account that borrows more than Kamino would allow, the freeze, and exits while paused', async ({ page }) => {
  test.setTimeout(900_000);
  await demoStep(page, 'wsm-setup');
  await burner(page);
  await page.goto('/app/weekend-safe');

  // The limits: the proposed ones next to Kamino's live reserve.
  await expect(page.getByTestId('wsm-kamino-ltv')).toHaveText('73%');
  await expect(page.getByTestId('wsm-kamino-lt')).toHaveText('75%');
  await expect(page.getByTestId('wsm-ltv')).toHaveText('80%');
  await expect(page.getByTestId('wsm-lt')).toHaveText('85%');
  await expect(page.getByTestId('wsm-paused')).toHaveText('Credence active');
  await expect(page.getByTestId('wsm-weekend')).toContainText('open');

  // The add-on for a stated example is the program's quote (simulated), shown as a yearly rate.
  await expect(page.getByTestId('wsm-addon')).toHaveText(/^\d+\.\d{2}%$/, { timeout: 60_000 });

  // Open, get SPYx (a fork cheatcode), deposit, borrow.
  await page.getByTestId('wsm-open').click();
  await expect(page.getByTestId('wsm-get-spyx')).toBeVisible({ timeout: 120_000 });
  await page.getByTestId('wsm-get-spyx').click();
  await expect(page.getByTestId('wsm-msg')).toContainText('100 SPYx');
  await page.getByTestId('wsm-dep-amount').fill('10');
  await page.getByTestId('wsm-deposit').click();
  await expect(page.getByTestId('wsm-collateral')).toHaveText(/\$[1-9]/, { timeout: 120_000 });
  const collateral = usd(await page.getByTestId('wsm-collateral').innerText());
  // 78% of the collateral: above Kamino’s own 73% limit, inside this market’s 80%.
  const borrow = Math.floor(collateral * 0.78);
  await page.getByTestId('wsm-bor-amount').fill(String(borrow));
  await page.getByTestId('wsm-borrow').click();
  await expect(page.getByTestId('wsm-debt')).toHaveText(/\$[1-9]/, { timeout: 120_000 });
  expect(usd(await page.getByTestId('wsm-debt').innerText())).toBeGreaterThan(collateral * 0.73);
  const dcp = Number(await page.getByTestId('wsm-dcp').innerText());
  expect(dcp).toBeGreaterThan(0.85);
  expect(dcp).toBeLessThan(0.945);
  await expect(page.getByTestId('wsm-status')).toContainText('covers on Friday');
  // With a debt on the account the add-on shown is this account's.
  await expect(page.getByTestId('wsm-addon')).toHaveText(/^\d+\.\d{2}%$/, { timeout: 60_000 });

  // Friday, inside the freeze: the keeper's pass covers the account (borrows the premium onto its debt).
  const debtBefore = usd(await page.getByTestId('wsm-debt').innerText());
  await demoStep(page, 'wsm-freeze');
  await page.reload();
  await expect(page.getByTestId('wsm-weekend')).toContainText('frozen', { timeout: 60_000 });
  await expect(page.getByTestId('wsm-status')).toContainText('covered', { timeout: 60_000 });
  await expect(page.getByTestId('wsm-borrow')).toBeDisabled();
  await expect(page.getByTestId('wsm-borrow-note')).toContainText('freeze');
  expect(usd(await page.getByTestId('wsm-debt').innerText())).toBeGreaterThan(debtBefore); // the premium is on the debt

  // Credence paused by the guardian: the exits stay on the page and work; opening and borrowing do not.
  await demoStep(page, 'wsm-pause');
  await page.reload();
  await expect(page.getByTestId('wsm-paused')).toContainText('paused');
  await expect(page.getByTestId('wsm-borrow')).toBeDisabled();
  await expect(page.getByTestId('wsm-exit-note')).toContainText('never depend on Credence');
  await expect(page.getByTestId('wsm-repay')).toBeEnabled();
  await expect(page.getByTestId('wsm-withdraw')).toBeEnabled();
  const debtNow = usd(await page.getByTestId('wsm-debt').innerText());
  await page.getByTestId('wsm-rep-amount').fill('500');
  await page.getByTestId('wsm-repay').click();
  await expect(async () => { expect(usd(await page.getByTestId('wsm-debt').innerText())).toBeLessThan(debtNow - 400); }).toPass({ timeout: 120_000 });
  // Mid-weekend, paused, policy active: repay everything and take the collateral back.
  await page.getByTestId('wsm-repay-all').click();
  await expect(page.getByTestId('wsm-debt')).toHaveText('$0.00', { timeout: 120_000 });
  await page.getByTestId('wsm-withdraw').click();
  await expect(page.getByTestId('wsm-reopen')).toBeVisible({ timeout: 120_000 }); // klend closed the emptied obligation
  await demoStep(page, 'wsm-unpause');
});
