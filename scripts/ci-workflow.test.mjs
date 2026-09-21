import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { isPublicPath } from './delivery-certificate.mjs';

const workflowUrl = new URL('../.github/workflows/ci.yml', import.meta.url);
const releaseWorkflowUrl = new URL('../.github/workflows/release.yml', import.meta.url);
const securityWorkflowUrl = new URL('../.github/workflows/security-audit.yml', import.meta.url);
const proxyCertificationWorkflowUrl = new URL('../.github/workflows/proxy-certification.yml', import.meta.url);
const proxyReleaseWorkflowUrl = new URL('../.github/workflows/proxy-release.yml', import.meta.url);
const previewSmokeSpecUrl = new URL('../test/e2e/specs/01-app-loads.spec.ts', import.meta.url);
const proxyUiSpecUrl = new URL('../test/e2e/specs/12-proxy-v2-mock.spec.ts', import.meta.url);
const proxyUiNavigationUrl = new URL('../test/e2e/fixtures/navigation.ts', import.meta.url);
const desktopPackageUrl = new URL('../packages/desktop/package.json', import.meta.url);
const privateCheckout = existsSync(new URL('../AGENTS.md', import.meta.url));
const privateOnly = { skip: privateCheckout ? false : 'curated public source omits private CI/E2E inputs' };
const versionBranches = "branches: ['release/[0-9]+.[0-9]+.[0-9]+']";
const versionJobGuard = "if: startsWith(github.ref, 'refs/heads/release/')";
const versionStepGuard = String.raw`run: '[[ "$GITHUB_REF" =~ ^refs/heads/release/[0-9]+\.[0-9]+\.[0-9]+$ ]]'`;

test('hosted workflows pin every source, release, and audit gate to Node 24', async () => {
  const [workflow, releaseWorkflow, securityWorkflow, proxyCertification, proxyRelease] = await Promise.all([
    privateCheckout ? readFile(workflowUrl, 'utf8') : Promise.resolve(null),
    readFile(releaseWorkflowUrl, 'utf8'),
    readFile(securityWorkflowUrl, 'utf8'),
    readFile(proxyCertificationWorkflowUrl, 'utf8'),
    readFile(proxyReleaseWorkflowUrl, 'utf8'),
  ]);

  for (const configuredWorkflow of [
    workflow,
    releaseWorkflow,
    securityWorkflow,
    proxyCertification,
    proxyRelease,
  ].filter(Boolean)) {
    assert.match(configuredWorkflow, /node-version: 24/);
    assert.doesNotMatch(configuredWorkflow, /node-version: 22/);
  }

  if (privateCheckout) {
    assert.doesNotMatch(workflow, /\n  pull_request:\n/);
    assert.ok(workflow.includes(versionBranches));
    assert.match(workflow, /fetch-depth: 0/);
    assert.match(workflow, /lane: \[policy, typecheck, build, unit, integration, system\]/);
    assert.match(workflow, /node scripts\/source-gate.mjs/);
    assert.match(workflow, /fail-fast: false/);
    assert.doesNotMatch(workflow, /test:e2e|quality:package|test:smoke/);
  }
});

test('development CI is automatic only for version branches with no default-branch schedules', privateOnly, async () => {
  for (const name of ['ci', 'security-audit', 'remote']) {
    const source = await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    assert.ok(source.includes(`\n  push:\n    ${versionBranches}`), name);
    assert.doesNotMatch(source, /\n  pull_request(?:_target)?:/, name);
  }
  for (const name of ['ci', 'security-audit', 'remote', 'nightly-e2e', 'giandev-acceptance']) {
    const source = await readFile(new URL(`../.github/workflows/${name}.yml`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\n  schedule:|refs\/heads\/main/, name);
    assert.ok(source.includes(versionJobGuard), name);
    assert.ok(source.includes(versionStepGuard), name);
    const guardedJobs = source.split(versionJobGuard).length - 1;
    assert.equal(source.split(versionStepGuard).length - 1, guardedJobs, name);
    if (['nightly-e2e', 'giandev-acceptance'].includes(name)) {
      assert.doesNotMatch(source, /\n  (?:push|pull_request(?:_target)?):/, name);
    }
  }
});

test('manual version E2E retains isolated journeys and failure artifacts', privateOnly, async () => {
  const workflow = await readFile(new URL('../.github/workflows/nightly-e2e.yml', import.meta.url), 'utf8');

  assert.doesNotMatch(workflow, /\n  schedule:\n/);
  assert.match(workflow, /\n  workflow_dispatch:\n/);
  assert.match(workflow, /command: \['test:e2e', 'test:e2e:proxy-mock'\]/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /PLAYWRIGHT_CHANNEL: chromium/);
  assert.match(workflow, /uses: actions\/upload-artifact@v4[\s\S]*?if: always\(\)/);
  assert.match(workflow, /playwright-report\//);
  assert.match(workflow, /test-results\//);
});

test('Dev packages follow successful same-repository version CI without crossing version concurrency', privateOnly, async () => {
  const workflow = await readFile(new URL('../.github/workflows/dev-package.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes(versionBranches));
  assert.match(workflow, /workflows: \[CI\]/);
  assert.match(workflow, /types: \[completed\]/);
  assert.doesNotMatch(workflow, /\n  (?:push|pull_request|schedule):/);
  for (const required of [
    "github.repository == 'RichLogic/Gian-Dev'",
    "github.event.workflow_run.conclusion == 'success'",
    "(github.event.workflow_run.event == 'push' || github.event.workflow_run.event == 'workflow_dispatch')",
    "startsWith(github.event.workflow_run.head_branch, 'release/')",
    'github.event.workflow_run.head_repository.full_name == github.repository',
    'group: gian-dev-package-${{ github.event.workflow_run.head_branch }}',
    'SOURCE_BRANCH: ${{ github.event.workflow_run.head_branch }}',
    String.raw`run: '[[ "$SOURCE_BRANCH" =~ ^release/[0-9]+\.[0-9]+\.[0-9]+$ ]]'`,
    'ref: ${{ github.event.workflow_run.head_sha }}',
    'persist-credentials: false',
    'name: source-certificate-${{ github.event.workflow_run.head_sha }}-${{ github.event.workflow_run.run_attempt }}',
    'c.sha!==process.env.GIAN_BUILD_SHA',
    'String(c.runId)!==process.env.GIAN_SOURCE_RUN_ID',
    'String(c.runAttempt)!==process.env.GIAN_SOURCE_RUN_ATTEMPT',
    'c.status!=="PASS"',
    'c.repository!==process.env.GITHUB_REPOSITORY',
  ]) assert.ok(workflow.includes(required), required);
});

test('public certification fixtures retain their navigation contracts', async () => {
  for (const path of ['test/e2e/specs/01-app-loads.spec.ts', 'test/e2e/specs/12-proxy-v2-mock.spec.ts', 'test/e2e/fixtures/navigation.ts']) {
    assert.equal(isPublicPath(path), true);
  }
  const config = await readFile(new URL('../playwright.config.ts', import.meta.url), 'utf8');
  assert.match(config, /testDir: '\.'/);
  assert.match(config, /test\/e2e\/specs\/\*\*\/\*\.spec\.ts/);
  const [previewSmokeSpec, proxyUiSpec, proxyUiNavigation] = await Promise.all([
    readFile(previewSmokeSpecUrl, 'utf8'),
    readFile(proxyUiSpecUrl, 'utf8'),
    readFile(proxyUiNavigationUrl, 'utf8'),
  ]);
  assert.match(previewSmokeSpec, /App shell/);
  assert.match(previewSmokeSpec, /\.\.\/fixtures\/navigation\.js/);
  assert.match(proxyUiSpec, /GIAN_E2E_PROXY_MOCK/);
  assert.match(proxyUiSpec, /\.\.\/fixtures\/navigation\.js/);
  assert.match(proxyUiNavigation, /export async function openNewSession/);
});

test('Proxy publication consumes a qualified macOS ARM64 certificate and never tag-builds', async () => {
  const [certification, release] = await Promise.all([
    readFile(proxyCertificationWorkflowUrl, 'utf8'),
    readFile(proxyReleaseWorkflowUrl, 'utf8'),
  ]);
  assert.match(certification, /runs-on: macos-15/);
  assert.match(certification, /runner\.environment/);
  assert.match(certification, /test "\$\(uname -m\)" = arm64/);
  assert.doesNotMatch(certification, /self-hosted/);
  assert.doesNotMatch(certification, /GIAN_ALLOW_REAL_AGENT_TURN/);
  assert.match(certification, /pnpm verify:proxy --/);
  assert.match(certification, /--stage artifacts/);
  assert.match(certification, /build-managed-runtime-candidates\.mjs/);
  assert.match(certification, /GIAN_RUNNER_ENVIRONMENT: \$\{\{ runner\.environment \}\}/);
  assert.match(certification, /artifacts\/proxies/);
  assert.match(release, /workflow_dispatch:/);
  assert.doesNotMatch(release, /push:\s*[\s\S]*tags:/);
  assert.match(release, /scripts\/proxy-release-metadata\.mjs/);
  assert.match(release, /scripts\/verify-proxy-release-certificate\.mjs/);
  assert.match(release, /pnpm install --frozen-lockfile/);
  assert.match(release, /--run-id/);
  assert.match(release, /--run-attempt/);
  assert.match(release, /--repository/);
  assert.match(release, /An authorized maintainer must create/);
  assert.match(release, /validate_existing_release/);
  assert.match(release, /for ATTEMPT in 1 2 3/);
  assert.match(release, /RUNTIME="\$\(jq -c --arg provider/);
  assert.doesNotMatch(release, /jq -ce --arg provider "\$\{PROVIDER\}" '\[\.candidates/);
  assert.doesNotMatch(release, /--target/);
  assert.doesNotMatch(release, /git push origin "refs\/tags\/\$\{TAG\}"/);
  assert.doesNotMatch(release, /build-proxy-artifacts\.mjs/);
  // Proxy bundles share the App releases feed: every publish must re-pin the
  // newest full App release as /releases/latest or electron-updater 404s.
  assert.match(release, /Restore the App latest-release marker/);
  assert.match(release, /gh release edit "\$\{APP_TAG\}" --latest/);
  assert.match(release, /releases\/latest' --jq '.tag_name'/);
});

test('release installs dependencies after public source admission and before the version gate', async () => {
  const workflow = await readFile(releaseWorkflowUrl, 'utf8');
  const signingJob = workflow.slice(workflow.indexOf('  macos-arm64:'));
  const source = signingJob.indexOf('node scripts/delivery-certificate.mjs verify-public-source');
  const install = signingJob.indexOf('pnpm install --frozen-lockfile');
  const version = signingJob.indexOf('node scripts/check-version-consistency.mjs --release-ref');
  const signing = signingJob.indexOf('security import');
  const build = signingJob.indexOf('run: pnpm --filter @gian/desktop make:mac:release');
  assert.ok(source >= 0 && source < install, 'certify source before installing dependencies');
  assert.ok(install < version, 'version validation imports esbuild through Proxy metadata');
  assert.ok(version < signing && signing < build, 'reject version drift before signing and building');
});

test('public release checks its own exact revision before unlocking the signing job', async () => {
  const workflow = await readFile(releaseWorkflowUrl, 'utf8');
  const source = workflow.slice(workflow.indexOf('  source:'), workflow.indexOf('  macos-arm64:'));
  const signing = workflow.slice(workflow.indexOf('  macos-arm64:'));
  assert.doesNotMatch(workflow, /GIAN_DEV_READ_TOKEN|source_run_id|RichLogic\/Gian-Dev|verify-source/);
  assert.match(source, /lane: \[policy, typecheck, build, unit, integration, system\]/);
  assert.match(source, /node scripts\/source-gate\.mjs "\$LANE" HEAD full/);
  assert.match(source, /pnpm "\$LANE"/);
  assert.match(source, /github\.repository == 'RichLogic\/Gian' && github\.ref == 'refs\/heads\/main'/);
  assert.doesNotMatch(source, /secrets\.|environment:|contents: write|continue-on-error/);
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(signing, /needs: source/);
  assert.match(signing, /environment: production/);
  assert.match(signing, /permissions:\n      contents: write/);
  assert.doesNotMatch(signing.split('steps:')[0], /always\(\)|continue-on-error/);
  assert.doesNotMatch(workflow, /checkout@v6\n\s+with:\n\s+ref:/);
});

test('release and desktop packaging fail closed before expensive builds', async () => {
  const [releaseWorkflow, desktopPackageText] = await Promise.all([
    readFile(releaseWorkflowUrl, 'utf8'),
    readFile(desktopPackageUrl, 'utf8'),
  ]);
  const desktopPackage = JSON.parse(desktopPackageText);

  assert.match(releaseWorkflow, /delivery-certificate.mjs verify-public-source/);
  assert.match(releaseWorkflow, /workflow_dispatch:/);
  assert.match(releaseWorkflow, /environment: production/);
  assert.doesNotMatch(releaseWorkflow, /push:\s*tags:|pnpm test:all|pnpm quality:package/);
  for (const secret of [
    'CSC_LINK',
    'CSC_KEY_PASSWORD',
    'APPLE_API_KEY_BASE64',
    'APPLE_API_KEY_ID',
    'APPLE_API_ISSUER',
  ]) assert.match(releaseWorkflow, new RegExp(`secrets\\.${secret}`));
  assert.match(releaseWorkflow, /timeout-minutes: 120/);
  assert.match(releaseWorkflow, /security create-keychain/);
  assert.match(releaseWorkflow, /security import/);
  assert.match(releaseWorkflow, /security set-key-partition-list/);
  assert.match(
    releaseWorkflow,
    /security set-key-partition-list[\s\S]*?-k "\$\{KEYCHAIN_PASSWORD\}"/,
  );
  assert.doesNotMatch(
    releaseWorkflow,
    /security set-key-partition-list[\s\S]{0,240}?CSC_KEY_PASSWORD/,
  );
  assert.match(releaseWorkflow, /CSC_KEYCHAIN=\$\{KEYCHAIN_PATH\}/);
  assert.match(releaseWorkflow, /security delete-keychain/);
  assert.match(releaseWorkflow, /make:mac:release/);
  assert.match(releaseWorkflow, /codesign --verify --deep --strict/);
  assert.match(releaseWorkflow, /runtime\/node\)"\n\s*echo "\$\{NODE_ENTITLEMENTS\}" \| grep -q 'com\.apple\.security\.cs\.disable-library-validation'/);
  assert.match(releaseWorkflow, /Contents\/MacOS\/Gian\)"[\s\S]{0,200}?unexpectedly carries disable-library-validation/);
  assert.match(releaseWorkflow, /xcrun stapler validate/);
  assert.match(releaseWorkflow, /spctl --assess --type execute/);
  assert.match(releaseWorkflow, /Gian-\$\{VERSION\}-arm64\.dmg\.blockmap/);
  assert.match(releaseWorkflow, /Gian-\$\{VERSION\}-arm64\.zip\.blockmap/);
  assert.match(releaseWorkflow, /latest-mac\.yml/);
  assert.match(releaseWorkflow, /--draft/);
  assert.match(releaseWorkflow, /--github-release-json/);
  assert.doesNotMatch(releaseWorkflow, /--draft=false|--clobber/);
  const promotion = await readFile(new URL('../.github/workflows/release-promote.yml', import.meta.url), 'utf8');
  assert.match(promotion, /verify-acceptance/);
  assert.match(promotion, /--draft=false --latest/);
  assert.doesNotMatch(promotion, /make:mac|electron-builder/);
  assert.doesNotMatch(releaseWorkflow, /--prerelease/);
  assert.equal(
    desktopPackage.scripts['bundle:build'].split(' && ')[0],
    'node ../../scripts/prepare-desktop-runtime.mjs',
  );
});
