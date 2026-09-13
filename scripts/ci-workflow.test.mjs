import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);
const releaseWorkflowUrl = new URL('../.github/workflows/release.yml', import.meta.url);
const securityWorkflowUrl = new URL('../.github/workflows/security-audit.yml', import.meta.url);
const proxyCertificationWorkflowUrl = new URL('../.github/workflows/proxy-certification.yml', import.meta.url);
const proxyReleaseWorkflowUrl = new URL('../.github/workflows/proxy-release.yml', import.meta.url);
const desktopPackageUrl = new URL('../packages/desktop/package.json', import.meta.url);

test('hosted workflows pin every source, release, and audit gate to Node 24', async () => {
  const [workflow, releaseWorkflow, securityWorkflow, proxyCertification, proxyRelease] = await Promise.all([
    readFile(workflowUrl, 'utf8'),
    readFile(releaseWorkflowUrl, 'utf8'),
    readFile(securityWorkflowUrl, 'utf8'),
    readFile(proxyCertificationWorkflowUrl, 'utf8'),
    readFile(proxyReleaseWorkflowUrl, 'utf8'),
  ]);

  assert.match(workflow, /\n  pull_request:\n/);
  assert.match(workflow, /\n  push:\n[\s\S]*?      - main\n/);
  assert.match(workflow, /fetch-depth: 0/);
  for (const configuredWorkflow of [
    workflow,
    releaseWorkflow,
    securityWorkflow,
    proxyCertification,
    proxyRelease,
  ]) {
    assert.match(configuredWorkflow, /node-version: 24/);
    assert.doesNotMatch(configuredWorkflow, /node-version: 22/);
  }

  for (const command of [
    'pnpm quality:traceability',
    'pnpm typecheck',
    'pnpm test:all',
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
  assert.match(workflow, /run: pnpm test:e2e:proxy-mock/);
  assert.match(workflow, /PLAYWRIGHT_CHANNEL: chromium/);
  assert.match(workflow, /if: failure\(\)[\s\S]*?uses: actions\/upload-artifact@v4/);
  assert.match(workflow, /playwright-report\//);
  assert.match(workflow, /test-results\//);
});

test('Proxy publication consumes a qualified macOS ARM64 certificate and never tag-builds', async () => {
  const [certification, release] = await Promise.all([
    readFile(proxyCertificationWorkflowUrl, 'utf8'),
    readFile(proxyReleaseWorkflowUrl, 'utf8'),
  ]);
  assert.match(certification, /runs-on: \[self-hosted, macOS, ARM64, gian-proxy-certification\]/);
  assert.match(certification, /pnpm verify:proxy --/);
  assert.match(certification, /--stage artifacts/);
  assert.match(certification, /build-managed-runtime-candidates\.mjs/);
  assert.match(
    certification,
    /pnpm --filter @gian\/proxy-protocol build[\s\S]*pnpm --filter @gian\/proxy-catalog-contract build[\s\S]*pnpm --filter @gian\/host build/,
  );
  assert.match(certification, /artifacts\/proxies/);
  assert.match(release, /workflow_dispatch:/);
  assert.doesNotMatch(release, /push:\s*[\s\S]*tags:/);
  assert.match(release, /scripts\/proxy-release-metadata\.mjs/);
  assert.match(release, /scripts\/verify-proxy-release-certificate\.mjs/);
  assert.doesNotMatch(release, /build-proxy-artifacts\.mjs/);
});

test('release and desktop packaging fail closed before expensive builds', async () => {
  const [releaseWorkflow, desktopPackageText] = await Promise.all([
    readFile(releaseWorkflowUrl, 'utf8'),
    readFile(desktopPackageUrl, 'utf8'),
  ]);
  const desktopPackage = JSON.parse(desktopPackageText);

  assert.match(
    releaseWorkflow,
    /- name: Verify source[\s\S]*?pnpm quality:traceability[\s\S]*?pnpm typecheck[\s\S]*?pnpm test:all/,
  );
  for (const secret of [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'APPLE_API_KEY_BASE64',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
  ]) assert.match(releaseWorkflow, new RegExp(`secrets\\.${secret}`));
  assert.match(releaseWorkflow, /pnpm quality:package/);
  assert.match(releaseWorkflow, /make:mac:release/);
  assert.match(releaseWorkflow, /codesign --verify --deep --strict/);
  assert.match(releaseWorkflow, /xcrun stapler validate/);
  assert.match(releaseWorkflow, /spctl --assess --type execute/);
  assert.match(releaseWorkflow, /--latest/);
  assert.doesNotMatch(releaseWorkflow, /--prerelease/);
  assert.equal(
    desktopPackage.scripts['bundle:build'].split(' && ')[0],
    'node ../../scripts/prepare-desktop-runtime.mjs',
  );
});
