// Raw capture of the demo video (task 5.3, docs/video/demo-script.md): the judge's path at 1920×1080 with pauses for
// voice-over, real transactions on the running demo-app.sh fork. Not part of `pnpm test:e2e`.
// Usage (repo root): scripts/record-demo.sh   → docs/video/raw/demo-raw.webm
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e-record',
  timeout: 600_000,
  expect: { timeout: 90_000 },
  workers: 1,
  reporter: [['list']],
  outputDir: '../docs/video/raw/.playwright',
  use: {
    baseURL: process.env.APP_URL ?? 'http://localhost:3000',
    viewport: { width: 1920, height: 1080 },
    video: { mode: 'on', size: { width: 1920, height: 1080 } },
    colorScheme: 'dark',
  },
});
