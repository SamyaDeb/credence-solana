// Every listed xStock in the app (W16): the Markets page shows a card per covered asset, each priced by the program's
// own quote_cover on its calibrated (or pooled) scenario set, and Risk's scan counts them.
import { expect, test } from '@playwright/test';

const ALL = ['SPYx', 'QQQx', 'NVDAx', 'TSLAx', 'GOOGLx', 'AAPLx', 'MSTRx', 'HOODx'];

test('Markets lists all eight xStocks, each with a premium', async ({ page }) => {
  await page.goto('/app/markets');
  for (const t of ALL) {
    const card = page.getByTestId(`market-${t}`);
    await expect(card).toBeVisible({ timeout: 90_000 });
    await expect(card).toContainText(/Cover [\d.,]+ USDC per \$1,000/, { timeout: 90_000 });
  }
});
