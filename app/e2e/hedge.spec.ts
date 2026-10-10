// D3: Underwrite shows the hedge section: the plain-words trust disclosure always, and either "not enabled" (no HedgeConfig on
// the fork) or the caps exactly as stored (HedgeConfig read by byte offset in e2e/chain.ts, independent of the app's decoding).
import { expect, test } from '@playwright/test';
import { usdc } from '../src/lib/format';
import { chainHedgeConfig, chainVault } from './chain';

test('Underwrite shows the hedge disclosure and the caps as stored', async ({ page }) => {
  await page.goto('/app/underwrite');
  const sec = page.getByTestId('hedge');
  await expect(sec).toBeVisible();
  await expect(sec).toContainText('Testnet hedge, research');
  await expect(sec).toContainText('trust assumption');
  await expect(sec).toContainText('never raises the capacity');
  for (const banned of [/insurance/i, /risk-free/i, /\blive hedge/i]) await expect(sec).not.toContainText(banned);
  const cfg = await chainHedgeConfig();
  if (!cfg) {
    await expect(page.getByTestId('hedge-off')).toBeVisible();
    return;
  }
  const v = await chainVault();
  const cover = v.equity - v.inventoryCost;
  await expect(page.getByTestId('hedge-margin-cap')).toHaveText(`${usdc((cover * BigInt(cfg.marginCapBps)) / 10_000n)}USDC`);
  await expect(page.getByTestId('hedge-gain-cap')).toHaveText(`${usdc((cover * BigInt(cfg.pnlCapBps)) / 10_000n)}USDC`);
  await expect(page.getByTestId('hedge-delay')).toHaveText(`${cfg.delaySecs / 3600}h`);
});
