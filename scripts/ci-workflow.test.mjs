import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);
const releaseWorkflowUrl = new URL('../.github/workflows/release.yml', import.meta.url);
const desktopPackageUrl = new URL('../packages/desktop/package.json', import.meta.url);

test('hosted CI wires Node 22 source gates for PRs and main', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /\n  pull_request:\n/);
  assert.match(workflow, /\n  push:\n[\s\S]*?      - main\n/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /node-version: 22/);

  for (const command of [
    'pnpm quality:traceability',
    'pnpm typecheck',
    'pnpm test',
    'pnpm build',
  ]) {
    assert.match(workflow, new RegExp(command.replaceAll(':', '\\:')));
  }
});

test('nightly and manual CI run isolated E2E and retain failure artifacts', async () => {
  const workflow = await readFile(workflowUrl, 'utf8');

  assert.match(workflow, /\n  schedule:\n/);
  assert.match(workflow, /\n  workflow_dispatch:\n/);
  assert.match(
    workflow,
    /if: github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'/,
  );
  assert.match(workflow, /run: pnpm test:e2e/);
  assert.match(workflow, /PLAYWRIGHT_CHANNEL: chromium/);
  assert.match(workflow, /if: failure\(\)[\s\S]*?uses: actions\/upload-artifact@v4/);
  assert.match(workflow, /playwright-report\//);
  assert.match(workflow, /test-results\//);
});

test('release and desktop packaging fail closed before expensive builds', async () => {
  const [releaseWorkflow, desktopPackageText] = await Promise.all([
    readFile(releaseWorkflowUrl, 'utf8'),
    readFile(desktopPackageUrl, 'utf8'),
  ]);
  const desktopPackage = JSON.parse(desktopPackageText);

  assert.match(
    releaseWorkflow,
    /- name: Verify source[\s\S]*?pnpm quality:traceability[\s\S]*?pnpm typecheck[\s\S]*?pnpm test/,
  );
  assert.equal(
    desktopPackage.scripts['bundle:build'].split(' && ')[0],
    'node ../../scripts/prepare-desktop-runtime.mjs',
  );
});
