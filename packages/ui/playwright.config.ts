import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.ATM_E2E_PORT ?? 4179);

export default defineConfig({
  testDir: './e2e',
  // e2e/real runs against the real server: see playwright.real.config.ts
  testIgnore: ['**/real/**'],
  outputDir: './test-results',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    locale: 'zh-CN',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 } }],
  webServer: {
    // Mock fixtures are explicitly enabled only for this isolated browser test server.
    command: `node ./node_modules/vite/bin/vite.js --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    env: { VITE_ATM_MOCK: '1' },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
