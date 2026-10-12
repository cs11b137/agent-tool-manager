import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end acceptance against the real stack: built UI served by `atm ui` (packages/cli/dist) → @atm/server → @atm/core,
 * with an isolated temp HOME. Requires `pnpm -r build` first. The server URL is discovered in global-setup.
 */
export default defineConfig({
  testDir: './e2e/real',
  outputDir: './test-results/real',
  globalSetup: './e2e/real/global-setup.ts',
  globalTeardown: './e2e/real/global-teardown.ts',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'zh-CN',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'real', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 } }],
});
