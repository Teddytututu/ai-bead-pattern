import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './apps/demo/tests/e2e',
  testMatch: '**/*.e2e.mjs',
  outputDir: './output/tests/playwright',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node apps/demo/server/serve.mjs',
    env: { PORT: '4174', AI_BEAD_E2E_FIXTURE: '1' },
    url: 'http://127.0.0.1:4174/apps/demo/',
    reuseExistingServer: false,
    timeout: 10_000,
  },
})
