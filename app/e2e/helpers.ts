// Shared steps for the e2e: a funded demo burner, fork steps through the app's own routes, and the Borrow card.
import { type Page, expect } from '@playwright/test';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes: number[]): string {
  let n = bytes.reduce((x, b) => x * 256n + BigInt(b), 0n);
  let s = '';
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = '1' + s; }
  return s;
}

/** Connects the demo burner on Faucet and funds it (10 SOL, 50,000 USDC); returns its public key. */
export async function burner(page: Page): Promise<string> {
  await page.goto('/app/faucet');
  await page.getByTestId('connect').click();
  await page.getByTestId('use-burner').click();
  await expect(page.getByTestId('wallet')).toBeVisible();
  await page.getByTestId('fund').click();
  await expect(page.getByTestId('faucet-msg')).toContainText('50,000');
  await expect(page.getByTestId('usdc')).toHaveText('50,000.00');
  // The burner's public key is the second half of its stored 64-byte secret key.
  const secret = await page.evaluate(() => JSON.parse(localStorage.getItem('credence.burner.v1') ?? '[]') as number[]);
  return base58(secret.slice(32));
}

/** One demo-mode keeper step through /api/demo/step, asserting it finished. */
export async function demoStep(page: Page, step: string, extra: Record<string, unknown> = {}) {
  const r = await page.request.post('/api/demo/step', { data: { step, ...extra }, timeout: 180_000 });
  const out = await r.text();
  expect(out, out).toContain('@@exit 0');
  return out;
}

/** Friday close → Monday open with `gap` → settle, from the Demo mode page; returns the payouts shown. */
export async function demoWeekend(page: Page, gap = '-0.08') {
  await page.goto('/app/demo');
  await page.getByTestId('demo-close').click();
  await expect(page.getByTestId('demo-log')).toContainText('close done', { timeout: 120_000 });
  await page.locator(`[data-gap="${gap}"]`).click();
  await page.getByTestId('demo-open').click();
  await expect(page.getByTestId('demo-log')).toContainText('open done', { timeout: 120_000 });
  await page.getByTestId('demo-settle').click();
  await expect(page.getByTestId('demo-log')).toContainText('settle done', { timeout: 120_000 });
  await expect(page.getByTestId('demo-log')).not.toContainText('FAIL');
  return (await page.getByTestId('demo-payout').allInnerTexts()).map((p) => Number(p.replace(/,/g, '')));
}

/** Buys gap cover on the first position card of Borrow; returns the quoted and the paid premium. */
export async function buyCover(page: Page) {
  const card = page.getByTestId('position').first();
  await expect(card.getByTestId('premium')).toHaveText(/USDC/);
  const quoted = await card.getByTestId('premium').innerText();
  await card.getByTestId('buy').click();
  await expect(card.getByTestId('policy-result')).toBeVisible({ timeout: 120_000 });
  return { card, quoted, paid: await card.getByTestId('policy-premium').innerText() };
}

export const amount = (s: string) => Number(s.replace(/,/g, '').match(/[\d.]+/)![0]);
