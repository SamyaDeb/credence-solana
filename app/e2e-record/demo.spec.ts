// The demo video's shots in order (recorded at 1440×810, scaled to 1920×1080), against a fresh scripts/demo-app.sh fork. Every number on screen comes
// from the fork, a data/ file or a transaction. Each shot is marked `keep` (real time, paced for the voice-over) or `fast`
// (waiting on transactions: scripts/cut-demo.mjs speeds it up to at most `max` seconds). The marks are written to
// docs/video/raw/segments.json; the shot list and voice-over are in docs/video/demo-script.md.
import { writeFileSync } from 'node:fs';
import { type Locator, type Page, expect, test } from '@playwright/test';

type Seg = { label: string; kind: 'keep' | 'fast'; start: number; end: number; max?: number };

const hold = (page: Page, s: number) => page.waitForTimeout(s * 1000);
const show = async (l: Locator) => l.evaluate((e) => e.scrollIntoView({ behavior: 'smooth', block: 'center' }));
const nav = (page: Page, name: string) => page.locator('.cx-side').getByRole('link', { name, exact: true }).click();

// A title card in the same browser, so the whole video is one capture. Same palette as the app.
const card = (title: string, lines: string[], foot = '') => `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#f5f4fd;font-family:Inter,"Helvetica Neue",Arial,sans-serif;color:#2e335b}
  .w{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 110px;box-sizing:border-box}
  h1{font-size:58px;line-height:1.08;letter-spacing:-.02em;margin:0 0 28px;max-width:1150px}
  p{font-size:26px;line-height:1.45;margin:0 0 8px;color:#4a5080;max-width:1150px}
  .f{margin-top:36px;font-size:18px;color:#7a80aa;letter-spacing:.02em}
  b{color:#3b5bdb}
</style></head><body><div class="w"><h1>${title}</h1>${lines.map((l) => `<p>${l}</p>`).join('')}${foot ? `<div class="f">${foot}</div>` : ''}</div></body></html>`)}`;

test('demo video', async ({ page }) => {
  test.setTimeout(1_200_000);
  const t0 = Date.now();
  const segs: Seg[] = [];
  const mark = (label: string, kind: Seg['kind'], max?: number) => {
    const now = (Date.now() - t0) / 1000;
    if (segs.length) segs[segs.length - 1].end = now;
    segs.push({ label, kind, start: now, end: now, max });
  };

  // 0:00 Hook.
  mark('hook card', 'keep');
  await page.goto(card('Tokenized stocks trade 24/7.<br>The price their loans run on stops at Friday’s bell.',
    ['Kamino’s SPYx and NVDAx price did not move once from Friday’s close to Monday pre-market, <b>six weekends in a row</b>.',
      'Then the whole weekend’s move lands at once, and leveraged positions are liquidated before anyone can react.'],
    'Credence · weekend gap protection for tokenized-stock loans on Solana'));
  await hold(page, 9);

  // 0:09 Landing: the product in one line, the eight xStocks it covers.
  mark('landing', 'keep');
  await page.goto('/');
  await hold(page, 4);
  await page.mouse.wheel(0, 950);
  await hold(page, 4);

  // 0:17 Risk: the Gap Oracle (Kamino's frozen price vs the 24/7 xStock price) and S7, measured on mainnet.
  mark('gap oracle', 'keep');
  await page.goto('/app/risk');
  await expect(page.getByTestId('oracle-SPYx')).toBeVisible({ timeout: 60_000 });
  await show(page.getByTestId('oracle-SPYx'));
  await hold(page, 8);
  await show(page.getByTestId('s7'));
  await hold(page, 8);

  // 0:33 Markets: the eight covered xStocks, priced for the coming weekend by the program.
  mark('markets', 'keep');
  await nav(page, 'Markets');
  await expect(page.getByTestId('market-SPYx').getByTestId('market-price')).toHaveText(/\$/, { timeout: 60_000 });
  await hold(page, 6);

  // 0:39 A wallet and a near-threshold loan: burner, funds, then a $50,000 SPYx loan opened through klend on the fork.
  mark('faucet', 'fast', 3);
  await nav(page, 'Faucet');
  await page.getByTestId('connect').click();
  await page.getByTestId('use-burner').click();
  await page.getByTestId('fund').click();
  await expect(page.getByTestId('usdc')).toHaveText('50,000.00', { timeout: 120_000 });
  await nav(page, 'Demo mode');
  await page.getByTestId('demo-create').click();
  await expect(page.getByTestId('demo-log')).toContainText('create done', { timeout: 240_000 });

  // 0:42 Borrow: the position, what a Monday gap does to it, the premium and the chance it pays.
  mark('borrow risk', 'keep');
  await nav(page, 'Borrow');
  const pos = page.getByTestId('position').first();
  await expect(pos.getByTestId('loss-table')).toBeVisible({ timeout: 120_000 });
  await hold(page, 3);
  await show(pos.getByTestId('loss-table'));
  await hold(page, 8);
  await expect(pos.getByTestId('pay-odds').first()).toBeVisible({ timeout: 120_000 });
  await show(pos.getByTestId('premium'));
  await hold(page, 9);

  // 1:02 Buy in one transaction: klend refreshes, then buy_cover reads the obligation itself.
  mark('buy', 'fast', 3);
  await pos.getByTestId('buy').click();
  await expect(pos.getByTestId('policy-result')).toBeVisible({ timeout: 180_000 });
  mark('policy', 'keep');
  await show(pos.getByTestId('policy-result'));
  await hold(page, 6);

  // 1:11 The weekend, twice: two identical positions, A covered and B not.
  mark('twin intro', 'keep');
  await nav(page, 'Demo mode');
  await show(page.getByTestId('twin'));
  await hold(page, 5);
  await page.getByTestId('twin-run').click();
  mark('twin running', 'fast', 7);
  await expect(page.getByTestId('twin-A-outcome')).toBeVisible({ timeout: 420_000 });
  await expect(page.getByTestId('twin-error')).toHaveCount(0);

  // 1:23 Sunday night the Shield repays into A; Monday pre-market B is liquidated, A is not.
  mark('twin result', 'keep');
  await show(page.getByTestId('twin-A'));
  await hold(page, 12);
  await show(page.getByTestId('twin-A-outcome'));
  await hold(page, 8);
  await show(page.getByTestId('twin-advance'));
  await hold(page, 6);
  await show(page.getByTestId('twin-sale'));
  await hold(page, 8);
  await show(page.getByTestId('twin-simulated'));
  await hold(page, 5);

  // 2:02 Underwrite: LPs earn premiums, backstop P&L and Kamino's supply rate on idle cash; ten years of weekends.
  mark('underwrite', 'keep');
  await nav(page, 'Underwrite');
  await expect(page.getByTestId('vault')).toBeVisible({ timeout: 60_000 });
  await show(page.getByTestId('yield-split'));
  await hold(page, 7);
  await show(page.getByTestId('backtest'));
  await hold(page, 8);

  // 2:17 Curator: a vault manager covers a whole book of real positions for one premium.
  mark('curator load', 'fast', 2);
  await nav(page, 'Curator');
  await page.getByTestId('curator-market').selectOption('jl-SPYx');
  await page.getByTestId('curator-min-debt').fill('1000');
  await page.getByTestId('curator-target').selectOption('0.9');
  await expect(page.getByTestId('curator-book-premium')).toHaveText(/\$\d/, { timeout: 120_000 });
  mark('curator', 'keep');
  await show(page.getByTestId('curator-quote'));
  await hold(page, 9);

  // 2:28 Close: what is real, what is next.
  mark('end card', 'keep');
  await page.goto(card('Price the gap. Pay it. Prevent the liquidation.',
    ['Real Kamino and Jupiter Lend programs on a mainnet fork: <b>2,427 real positions, $9M of debt</b> eligible today.',
      'Gap Oracle · Gap Cover · Liquidation Shield · Monday Backstop · LP vault · curator books · Blink · SDK.',
      'Next: an external audit, then a capped mainnet launch with a curator design partner.'],
    'github.com/SamyaDeb/credence-solana · not live, not insurance · xStocks are not available to US persons'));
  await hold(page, 12);
  mark('end', 'keep');

  writeFileSync('../docs/video/raw/segments.json', JSON.stringify(segs.slice(0, -1), null, 1));
});
