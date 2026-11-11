import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const production = process.env.KOIFORGE_E2E_PRODUCTION === '1';

export default defineConfig({
  testDir: './tests', testMatch: ['freshness.spec.ts', 'missions.spec.ts', 'semantic-model.spec.ts', 'object-workspace.spec.ts', 'projects.spec.ts', 'dataflows.spec.ts', 'dataflow-dependencies.spec.ts', 'orders.spec.ts', 'routines.spec.ts', 'cases.spec.ts', 'product-navigation.spec.ts', 'saas-access.spec.ts'], workers: 1,
  reporter: 'list', outputDir: 'test-results-freshness',
  use: { baseURL: 'http://127.0.0.1:5191', headless: true,
    launchOptions: { executablePath: process.env.CHROMIUM_PATH ?? '/usr/bin/chromium' },
    screenshot: 'only-on-failure', trace: 'off' },
  webServer: [
    { command: '../../apps/control-plane-api/node_modules/.bin/tsx ../../apps/control-plane-api/test/support/browser-fixture.ts',
      url: 'http://127.0.0.1:3191/health', timeout: 30000 },
    { command: production
        ? './node_modules/.bin/vite build --outDir ../../.koiforge/e2e-console && ./node_modules/.bin/vite preview --outDir ../../.koiforge/e2e-console --host 127.0.0.1 --port 5191 --strictPort'
        : './node_modules/.bin/vite --host 127.0.0.1 --port 5191 --strictPort',
      cwd: fileURLToPath(new URL('../../apps/console-web/', import.meta.url)),
      env: { VITE_API_BASE_URL: 'http://127.0.0.1:3191' },
      url: 'http://127.0.0.1:5191', timeout: production ? 60000 : 30000 },
  ],
});
