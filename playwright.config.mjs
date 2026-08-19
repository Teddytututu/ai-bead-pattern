import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './apps/demo',
  testMatch: '**/*.e2e.mjs',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4174',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node scripts/serve-demo.mjs',
    env: { PORT: '4174' },
    url: 'http://127.0.0.1:4174/apps/demo/',
    reuseExistingServer: true,
    timeout: 10_000,
  },
})
