// The in-app Blink (C4a.1): the Protect my position Action rendered with Dialect's Blink client against the fork, signed
// by the demo burner, lands a Policy. The fork label is visible throughout.
import { expect, test } from '@playwright/test';
import { burner, demoStep } from './helpers';

// The fork's clock is real time: on a Friday evening or a weekend no epoch is on sale. Like Demo mode, move it with a
// surfpool cheatcode, here to 4 hours before the demo weekend's close (inside the sale window, before the bell).
const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8899';

test('Protect my position: the Blink buys gap protection on the fork with the burner', async ({ page }) => {
  test.setTimeout(300_000);
  await burner(page);
  const status = await demoStep(page, 'status');
  const close = (JSON.parse(status.match(/@@result (.*)/)![1]) as { close: number }).close;
  const tt = await page.request.post(RPC, { data: { jsonrpc: '2.0', id: 1, method: 'surfnet_timeTravel', params: [{ absoluteTimestamp: (close - 4 * 3600) * 1000 }] } });
  expect((await tt.json()).error).toBeUndefined();
  // The $50,000 SPYx demo position, created on the fork and given to the burner (Faucet).
  await page.getByTestId('demo-create').click();
  await expect(page.getByTestId('create-log')).toContainText('create done', { timeout: 180_000 });

  await page.goto('/app/protect');
  await expect(page.getByTestId('blink-fork-label')).toContainText('fork');
  await page.getByTestId('protect-mine').first().click();
  const blink = page.getByTestId('protect-blink');
  await expect(blink).toContainText('fork', { timeout: 60_000 });
  const full = blink.getByRole('button', { name: /Full debt/ });
  await expect(full).toBeVisible({ timeout: 90_000 });
  await expect(full).toContainText('USDC');
  await full.click();
  await expect(page.getByTestId('protect-sent')).toBeVisible({ timeout: 120_000 });
  await expect(page.getByTestId('protect-policy').first()).toContainText('active', { timeout: 60_000 });
});
