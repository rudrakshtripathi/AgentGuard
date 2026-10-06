import { defineConfig, devices } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- plain ESM helper shared with scripts/e2e.mjs
import { E2E, e2eEnv } from './e2e/env.mjs';

/**
 * E2E suite: the real demo flow in a real browser against an isolated stack.
 * Run via `npm run test:e2e` (scripts/e2e.mjs resets the e2e DB and builds the dashboard first).
 */
const env = e2eEnv() as Record<string, string>;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: `http://127.0.0.1:${E2E.webPort}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
  },
  webServer: [
    {
      command: 'npx tsx apps/api/src/server.ts',
      url: `http://127.0.0.1:${E2E.apiPort}/health`,
      env,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx next start apps/dashboard --port ${E2E.webPort} --hostname 127.0.0.1`,
      url: `http://127.0.0.1:${E2E.webPort}/login`,
      env,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
