import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CI = !!process.env['CI'];
const HOST_PORT = process.env['GIAN_HOST_PORT'] ?? process.env['GIAN_PORT'] ?? '8991';
const WEB_PORT = process.env['GIAN_WEB_PORT'] ?? '5191';
const DATA_DIR = process.env['GIAN_E2E_DATA_DIR'] ?? join(tmpdir(), `gian-e2e-${process.pid}`);
const HOST_BASE = `http://127.0.0.1:${HOST_PORT}`;
const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: './e2e/specs',
  retries: CI ? 1 : 0,
  reporter: CI ? 'github' : 'list',

  use: {
    baseURL: WEB_BASE,
    trace: 'on-first-retry',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        channel: process.env['PLAYWRIGHT_CHANNEL'] ?? 'chrome',
      },
    },
  ],

  webServer: [
    {
      name: 'host',
      command: `GIAN_DATA_DIR=${JSON.stringify(DATA_DIR)} GIAN_SKIP_PROXY_WARMUP=1 GIAN_PORT=${HOST_PORT} pnpm -F @gian/host start`,
      url: `${HOST_BASE}/health`,
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
    {
      name: 'web',
      command: `GIAN_HOST_PORT=${HOST_PORT} GIAN_PORT=${HOST_PORT} GIAN_WEB_PORT=${WEB_PORT} pnpm -F @gian/web preview`,
      url: WEB_BASE,
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
  ],
});
