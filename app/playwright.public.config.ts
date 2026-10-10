// The public read-only build (NEXT_PUBLIC_NETWORK=mainnet, `pnpm start`): no fork needed. APP_URL points at it.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e-public',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: [['list']],
  use: { baseURL: process.env.APP_URL ?? 'http://127.0.0.1:3005', screenshot: 'only-on-failure' },
});
