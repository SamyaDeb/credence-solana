// C4b end to end on the fork: connect the burner -> the gap line and risk -> buy -> the policy appears -> run the demo
// weekend -> the settlement shows. The app (APP_URL) creates the position and runs the weekend; the host page embeds the widget.
import { type Page, expect, test } from '@playwright/test';

const HOST = `http://127.0.0.1:${process.env.HOST_PORT ?? '3006'}`;
const RPC = `http://127.0.0.1:${process.env.FORK_PORT ?? '8899'}`;

/** Connects the app's demo burner on Faucet and funds it (10 SOL, 50,000 USDC); returns its 64-byte secret. */
async function burner(page: Page): Promise<number[]> {
  await page.goto('/app/faucet');
  await page.getByTestId('connect').click();
  await page.getByTestId('use-burner').click();
  await expect(page.getByTestId('wallet')).toBeVisible();
  await page.getByTestId('fund').click();
  await expect(page.getByTestId('faucet-msg')).toContainText('50,000');
  return page.evaluate(() => JSON.parse(localStorage.getItem('credence.burner.v1') ?? '[]') as number[]);
}

/** Friday close -> Monday open at -8% -> settle, from the app's Demo mode page. */
async function demoWeekend(page: Page) {
  await page.goto('/app/demo');
  await page.getByTestId('demo-close').click();
  await expect(page.getByTestId('demo-log')).toContainText('close done', { timeout: 120_000 });
  await page.locator('[data-gap="-0.08"]').click();
  await page.getByTestId('demo-open').click();
  await expect(page.getByTestId('demo-log')).toContainText('open done', { timeout: 120_000 });
  await page.getByTestId('demo-settle').click();
  await expect(page.getByTestId('demo-log')).toContainText('settle done', { timeout: 120_000 });
  await expect(page.getByTestId('demo-log')).not.toContainText('FAIL');
}

test('the widget on the fork: gap line, risk, buy, policy, settlement', async ({ page, context }) => {
  const secret = await burner(page);
  await page.getByTestId('demo-create').click();
  await expect(page.getByTestId('create-log')).toContainText('create done', { timeout: 180_000 });
  await page.goto('/app/protect');
  await page.getByTestId('protect-mine').first().click();
  await page.waitForURL(/position=/);
  const position = new URL(page.url()).searchParams.get('position') ?? '';
  expect(position).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

  const host = await context.newPage();
  const url = `${HOST}/?position=${position}&lender=kamino&rpc=${encodeURIComponent(RPC)}#burner=${encodeURIComponent(JSON.stringify(secret))}`;
  await host.goto(url);

  // The gap line and the risk table, from the SDK and the program.
  await expect(host.getByText('Credence gap protection')).toBeVisible();
  await expect(host.getByTestId('gap-line')).toBeVisible({ timeout: 120_000 });
  await expect(host.getByTestId('gap-frozen')).toBeVisible();
  await expect(host.getByTestId('risk-table')).toBeVisible();
  await expect(host.getByTestId('d-over-c')).toHaveText(/\d+\.\d\d%/);
  await expect(host.getByTestId('repay--800')).toContainText('USDC');

  // The quote is the program's; the button waits for it, then builds, simulates and asks the wallet.
  await expect(host.getByTestId('premium')).toContainText('USDC');
  await host.getByRole('button', { name: 'Buy cover' }).click();
  await expect(host.getByTestId('bought')).toContainText('compute units', { timeout: 180_000 });
  await expect(host.getByTestId('policy-state')).toHaveText('active', { timeout: 90_000 });
  await expect(host.getByTestId('bought')).toBeVisible(); // A-163: the confirmation survives the reload that follows the buy
  await expect(host.getByRole('list', { name: 'Policy events' })).toContainText('CoverBought', { timeout: 90_000 });

  // Run the demo weekend, then the widget shows the settlement.
  await demoWeekend(page);
  await host.reload();
  await expect(host.getByTestId('policy-state')).toHaveText('settled', { timeout: 120_000 });
  await expect(host.getByTestId('policy-payout')).toContainText('USDC');
  await expect(host.getByRole('list', { name: 'Policy events' })).toContainText('PolicySettled', { timeout: 90_000 });
});
