import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests', testMatch: 'monitoring-dashboard.spec.ts', fullyParallel: false,
  reporter: 'list', timeout: 30_000,
  use: { baseURL: 'http://127.0.0.1:4178', headless: true, viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }, screenshot: 'only-on-failure' },
  webServer: { command: 'node ../../apps/console-web/node_modules/vite/bin/vite.js preview --host 127.0.0.1 --port 4178 --strictPort',
    cwd: '../../apps/console-web', url: 'http://127.0.0.1:4178', reuseExistingServer: false },
});
