// Raw capture of the demo video (task 5.3): the judge's path, recorded at 1440×810 and scaled to 1920×1080, with pauses for
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
    // The app is laid out for 1440 px: record at 1440×810 and scale the video to 1080p, so text reads 33% larger.
    viewport: { width: 1440, height: 810 },
    video: { mode: 'on', size: { width: 1920, height: 1080 } },
    colorScheme: 'light',
  },
});
