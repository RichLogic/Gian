import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CI = !!process.env['CI'];
const ISOLATED = process.env['GIAN_E2E_ISOLATED'] === '1';
const EXTERNAL_SERVERS = process.env['GIAN_E2E_EXTERNAL_SERVERS'] === '1';
const HOST_PORT = process.env['GIAN_HOST_PORT'] ?? process.env['GIAN_PORT'] ?? '8991';
const WEB_PORT = process.env['GIAN_WEB_PORT'] ?? '5191';
const DATA_DIR = process.env['GIAN_E2E_DATA_DIR'] ?? join(tmpdir(), `gian-e2e-${process.pid}`);
const HOST_BASE = `http://127.0.0.1:${HOST_PORT}`;
const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: './e2e/specs',
  // Bound the whole run as well as individual tests. This includes worker and
  // webServer teardown, so a stranded Host cannot leave a local quality gate
  // silent forever or consume the entire hosted job timeout.
  globalTimeout: CI ? 40 * 60_000 : 15 * 60_000,
  // All workers share one real Host/Web pair. Keep local and hosted release
  // runs below the point where browser layout/PTY handshakes starve each other
  // on high-core machines; this is still enough parallelism for the 56-case
  // suite without turning timing pressure into product failures.
  // On macOS, multiple TypeScript-config workers can retain fsevents handles
  // after every assertion finishes and delay the release gate until the
  // global timeout. Keep hosted Linux parallel; use one deterministic local
  // worker so teardown returns promptly.
  workers: CI ? 4 : 1,
  // Visual baselines are intentionally shared across developer macOS and
  // Linux CI. Individual assertions carry a small cross-platform pixel
  // tolerance for font rasterization while still catching layout drift.
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{-projectName}{ext}',
  retries: CI ? 1 : 0,
  reporter: CI
    ? [['github'], ['html', { open: 'never' }]]
    : 'list',

  use: {
    baseURL: WEB_BASE,
    screenshot: 'only-on-failure',
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
      // Run the real server process directly. A pnpm script wrapper does not
      // reliably forward Playwright's teardown signal to Host, which can
      // strand Proxy and PTY process groups after all browser tests pass.
      command: 'node dist/index.js',
      cwd: join(process.cwd(), 'packages', 'host'),
      url: `${HOST_BASE}/health`,
      reuseExistingServer: EXTERNAL_SERVERS || (!CI && !ISOLATED),
      timeout: 60_000,
    },
    {
      name: 'web',
      command: 'node node_modules/vite/bin/vite.js preview',
      cwd: join(process.cwd(), 'packages', 'web'),
      url: WEB_BASE,
      reuseExistingServer: EXTERNAL_SERVERS || (!CI && !ISOLATED),
      timeout: 60_000,
    },
  ],
});
