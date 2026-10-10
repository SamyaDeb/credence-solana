// Widget e2e on the fork. Needs the Credence app + fork running (scripts/demo-app.sh with FORK_PORT=8949 PORT=3005 for the
// worktree): the app creates the demo position and runs the demo weekend; the sample host embeds the widget.
import { defineConfig } from '@playwright/test';

const APP = process.env.APP_URL ?? 'http://localhost:3005';
const HOST_PORT = process.env.HOST_PORT ?? '3006';
export default defineConfig({
  testDir: 'e2e',
  timeout: 420_000,
  expect: { timeout: 90_000 },
  workers: 1,
  reporter: [['list']],
  use: { baseURL: APP, viewport: { width: 1280, height: 900 }, screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  webServer: { command: `HOST_PORT=${HOST_PORT} APP_ORIGIN=${APP} pnpm dev`, url: `http://127.0.0.1:${HOST_PORT}`, reuseExistingServer: true, timeout: 60_000 },
});
