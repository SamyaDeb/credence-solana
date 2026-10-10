// The public site, in a browser: every page renders with no CSP violation or console error, fits 375 px without sideways
// scrolling, shows its as-of line, and the app cannot write. Screenshots go to docs/site.
import { type Page, expect, test } from '@playwright/test';

const PAGES = ['/', '/about', '/mainnet', '/unlock', '/proof', '/weekend', '/roadmap', '/disclosure'];
const SIZES = { desktop: { width: 1440, height: 900 }, phone: { width: 375, height: 812 } };

function watch(page: Page) {
  const bad: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') bad.push(`console: ${m.text().slice(0, 200)}`); });
  page.on('pageerror', (e) => bad.push(`pageerror: ${String(e).slice(0, 200)}`));
  // An aborted request is Next cancelling a link prefetch as the page settles; any other failure is a fault.
  page.on('requestfailed', (r) => { if (!/ERR_ABORTED/.test(r.failure()?.errorText ?? '')) bad.push(`failed: ${new URL(r.url()).pathname} ${r.failure()?.errorText}`); });
  page.on('request', (r) => { if (!r.url().startsWith(process.env.APP_URL ?? 'http://127.0.0.1:3005') && !r.url().startsWith('data:') && !r.url().startsWith('blob:')) bad.push(`third-party request: ${r.url().slice(0, 80)}`); });
  return bad;
}

for (const [label, viewport] of Object.entries(SIZES)) {
  for (const path of PAGES) {
    test(`${label} ${path}: no errors, no third-party requests, no sideways scroll`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const bad = watch(page);
      await page.addInitScript(() => document.addEventListener('securitypolicyviolation', (e) => (window as unknown as { __csp: string[] }).__csp = [...((window as unknown as { __csp?: string[] }).__csp ?? []), `${e.violatedDirective} ${e.blockedURI}`]));
      await page.goto(path, { waitUntil: 'networkidle' });
      await expect(page.locator('h1, h2').first()).toBeVisible();
      expect(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).toEqual([]);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(over, 'horizontal overflow of the page itself (tables scroll inside their own box)').toBeLessThanOrEqual(1);
      expect(bad).toEqual([]);
      if (path !== '/') await expect(page.getByRole('navigation', { name: 'Site' })).toBeVisible();
      await page.screenshot({ path: `../docs/site/${label}${path === '/' ? '-landing' : path.replace('/', '-')}.png`, fullPage: label === 'phone' ? false : true });
    });
  }
}

test('data pages carry an as-of line and the disclosures are on every page', async ({ page }) => {
  for (const path of ['/mainnet', '/unlock', '/proof', '/weekend']) {
    await page.goto(path);
    await expect(page.getByTestId('fresh').first()).toContainText(/as of \d{4}-\d\d-\d\d/);
    await expect(page.getByRole('note').first()).toContainText(/Not live, not insurance|Not for US persons|Computed off-chain/);
  }
  await page.goto('/unlock');
  await expect(page.getByTestId('unlock-caveat')).toContainText('What cover would allow, not measured demand.');
});

test('the app is read-only: write routes answer 403, the fork tools say so, nothing offers to sign', async ({ request, page }) => {
  for (const p of ['/api/fork/fund', '/api/demo/step', '/api/kamino/build', '/api/alerts/subscribe', '/api/book-quote']) {
    const r = await request.post(p, { data: {} });
    expect(r.status(), p).toBe(403);
  }
  const r = await request.post('/api/rpc', { data: { jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [] } });
  expect(JSON.stringify(await r.json())).toMatch(/not allowed/);
  await page.goto('/app/faucet');
  await expect(page.locator('body')).toContainText(/read-only/i);
  await expect(page.getByTestId('fund')).toHaveCount(0);
});

test('responses carry the security headers', async ({ request }) => {
  const h = (await request.get('/mainnet')).headers();
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['referrer-policy']).toBeTruthy();
  expect(h['x-powered-by']).toBeUndefined();
});
