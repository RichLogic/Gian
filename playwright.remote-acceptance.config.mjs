import { defineConfig, devices } from '@playwright/test';
import { assertExecutionAllowed } from './scripts/execution-policy.mjs';

assertExecutionAllowed('desktop');
const origin = new URL(process.env.GIAN_REMOTE_ACCEPTANCE_URL ?? 'https://gian-remote.fun');
if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
  throw new Error('Remote acceptance requires a credential-free HTTPS origin.');
}
if (!/^[a-f0-9]{40}$/.test(process.env.GIAN_REMOTE_ACCEPTANCE_BUILD ?? '')) {
  throw new Error('Pin GIAN_REMOTE_ACCEPTANCE_BUILD to the deployed Remote revision.');
}

export default defineConfig({
  testDir: './test/e2e/specs',
  testMatch: 'remote-deployed.spec.ts',
  workers: 1,
  retries: 0,
  timeout: 30_000,
  globalTimeout: 180_000,
  forbidOnly: true,
  outputDir: 'output/acceptance/remote-ui-results',
  reporter: [['list'], ['json', { outputFile: 'output/acceptance/remote-ui.json' }]],
  use: { ...devices['Desktop Chrome'], baseURL: origin.origin, locale: 'en-US',
    screenshot: 'only-on-failure', trace: 'off' },
  // Deliberately no webServer: use the deployed service, never start Remote.
});
