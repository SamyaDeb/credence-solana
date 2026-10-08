// End-to-end happy path against a running fork (scripts/demo-app.sh starts the fork, loads the data and serves the
// app; `pnpm test:e2e` reuses that server, or starts `next dev` against an already running fork).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  timeout: 240_000,
  expect: { timeout: 60_000 },
  workers: 1,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: process.env.APP_URL ?? 'http://localhost:3000', viewport: { width: 1440, height: 900 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: 'pnpm dev', url: `${process.env.APP_URL ?? 'http://localhost:3000'}/api/fork/status`, reuseExistingServer: true, timeout: 120_000 },
});
