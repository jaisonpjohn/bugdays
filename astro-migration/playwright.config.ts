import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 40_000,
  fullyParallel: true,
  workers: 2,
  use: { baseURL: 'http://127.0.0.1:4321', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], channel: 'chrome' } },
    { name: 'mobile', use: { ...devices['Pixel 7'], defaultBrowserType: 'chromium', channel: 'chrome' } },
  ],
  webServer: { command: 'npm run dev -- --host 127.0.0.1 --port 4321', url: 'http://127.0.0.1:4321', reuseExistingServer: !process.env.CI },
});
