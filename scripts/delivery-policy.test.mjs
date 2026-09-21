import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { assertExecutionAllowed } from './execution-policy.mjs';
import { assertHeadlessTests, requiresFullSuite, sourcePolicyChecks } from './source-gate.mjs';

test('source policy keeps executable quality gates without requiring a retired ledger', () => {
  const checks = sourcePolicyChecks(['quality:traceability', 'typecheck', 'quality:docs']);
  assert.equal(checks.includes('quality:traceability'), false);
  assert.equal(checks.includes('typecheck'), false);
  for (const id of ['quality:test-catalog', 'quality:test-selection',
    'quality:versions', 'quality:operations:strict', 'quality:docs']) {
    assert.ok(checks.includes(id), id);
  }
});
import { assertSourceCertificate, assertPublicSource, assertDesktopAcceptance, isPublicPath, DESKTOP_CHECKS, DESKTOP_PLAN } from './delivery-certificate.mjs';
import { allocatePorts, validatePorts } from './dev-ports.mjs';
import { assertDevOAuthConfiguration, assertDevSigningEntitlements, devPackageConfiguration, requireDevOAuthClientId } from './dev-package-config.mjs';

test('packaging is hosted CI only; interactive execution needs per-run consent', () => {
  for (const env of [{}, { CI: 'true' }, { GITHUB_ACTIONS: 'true' }, { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }, { GIAN_ALLOW_DESKTOP_E2E: '1' }]) {
    assert.throws(() => assertExecutionAllowed('package', env), /restricted/);
  }
  assert.doesNotThrow(() => assertExecutionAllowed('package', { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }));
  assert.throws(() => assertExecutionAllowed('desktop', {}), /explicit user permission/);
  assert.doesNotThrow(() => assertExecutionAllowed('desktop', { GIAN_ALLOW_DESKTOP_E2E: '1' }));
});

test('merge tests reject Desktop and external side effects even in system scope', () => {
  for (const effect of ['electron', 'browser', 'packaged-app', 'real-provider', 'credentials']) {
    assert.throws(() => assertHeadlessTests([{ scope: 'system', runner: 'node', path: 'test', sideEffects: [effect] }]), /cannot execute/);
  }
  assert.doesNotThrow(() => assertHeadlessTests([{ scope: 'system', runner: 'node', sideEffects: ['loopback-port', 'temporary-filesystem'] }]));
  assert.equal(requiresFullSuite(['packages/shared/src/model.ts']), true);
  assert.equal(requiresFullSuite(['pnpm-lock.yaml']), true);
  assert.equal(requiresFullSuite(['packages/web/src/views/AgentsView.tsx']), false);
});

test('ordinary local verification also requires selection and does not authorize Desktop or packaging', () => {
  for (const env of [{}, { CI: 'true' }, { GITHUB_ACTIONS: 'true' }, { GIAN_ALLOW_DESKTOP_E2E: '1' }]) {
    assert.throws(() => assertExecutionAllowed('verification', env), /Owner-selected/);
  }
  const selected = { GIAN_ALLOW_LOCAL_VERIFICATION: '1' };
  assert.doesNotThrow(() => assertExecutionAllowed('verification', selected));
  assert.throws(() => assertExecutionAllowed('desktop', selected), /explicit user permission/);
  assert.throws(() => assertExecutionAllowed('package', selected), /restricted/);
  assert.doesNotThrow(() => assertExecutionAllowed('verification', {
    GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted',
  }));
});

test('source certification requires exact full version-branch CI provenance and curated content', () => {
  const run = { id: 12, run_attempt: 1, head_sha: 'a'.repeat(40), conclusion: 'success', head_branch: 'release/0.6.2', event: 'push', path: '.github/workflows/ci.yml', repository: { full_name: 'RichLogic/Gian-Dev' } };
  const cert = { schema: 1, status: 'PASS', full: true, repository: run.repository.full_name, sha: run.head_sha, runId: 12, runAttempt: 1, manifest: [] };
  assert.doesNotThrow(() => assertSourceCertificate(cert, run, []));
  for (const patch of [{ full: false }, { sha: 'b'.repeat(40) }, { runId: 13 }, { runAttempt: 2 }, { runAttempt: undefined }]) assert.throws(() => assertSourceCertificate({ ...cert, ...patch }, run, []));
  assert.doesNotThrow(() => assertSourceCertificate(cert, { ...run, event: 'workflow_dispatch' }, []));
  assert.doesNotThrow(() => assertSourceCertificate(cert, { ...run, head_branch: 'release/12.30.456' }, []));
  for (const event of ['pull_request', 'pull_request_target', 'schedule']) {
    assert.throws(() => assertSourceCertificate(cert, { ...run, event }, []));
  }
  for (const head_branch of ['main', 'fix/sidechat', 'release/latest', 'release/0.6', 'release/v0.6.2', 'release/0.6.2/extra', 'release/0.6.2-rc1', undefined]) {
    assert.throws(() => assertSourceCertificate(cert, { ...run, head_branch }, []));
  }
  assert.throws(() => assertSourceCertificate(cert, run, [{ path: 'changed' }]));
  assert.equal(isPublicPath('docs/secret.md'), false);
  assert.equal(isPublicPath('AGENTS.md'), false);
  assert.equal(isPublicPath('packages/host/src/index.ts'), true);
});

test('independent public release rejects empty source and every private path category', () => {
  assert.doesNotThrow(() => assertPublicSource([{ path: 'package.json' }, { path: 'packages/host/src/index.ts' }]));
  assert.throws(() => assertPublicSource([]), /empty or contains internal files/);
  for (const path of ['AGENTS.md', 'docs/secret.md', 'e2e/specs/private.spec.ts', '.ai/STATE.md', '.github/workflows/ci.yml']) {
    assert.throws(() => assertPublicSource([{ path: 'package.json' }, { path }]), /internal files/);
  }
});

test('Dev packaging overrides production identity, signatures and feeds without losing native resources', () => {
  const config = devPackageConfiguration({ appId: 'com.gian.desktop', forceCodeSigning: true, publish: [{ provider: 'github' }], mac: { notarize: true, binaries: ['Contents/Resources/runtime/node'] } }, 'a'.repeat(40), '/tmp/icon.icns', '0.6.0-beta1');
  assert.equal(config.appId, 'com.gian.desktop.dev');
  assert.equal(config.productName, 'GianDev');
  assert.equal(config.publish, null);
  assert.equal(config.forceCodeSigning, false);
  assert.equal(config.mac.identity, '-');
  assert.equal(config.mac.notarize, false);
  assert.equal(config.mac.icon, '/tmp/icon.icns');
  assert.equal(config.extraMetadata.gianReleaseChannel, 'dev');
  assert.equal(config.artifactName, `GianDev-0.6.0-beta1-${'a'.repeat(12)}-\${arch}.\${ext}`);
  assert.deepEqual(config.mac.binaries, ['Contents/Resources/runtime/node']);
  assert.throws(() => devPackageConfiguration({}, 'main', '/tmp/icon.icns', '0.6.0-beta1'));
  assert.throws(() => devPackageConfiguration({}, 'a'.repeat(40), '/tmp/icon.icns'));
});

test('ad-hoc Dev signing uses a Dev-only library-validation exception for the app and helpers', () => {
  const base = { mac: { hardenedRuntime: true, entitlements: 'resources/entitlements.mac.plist', entitlementsInherit: 'resources/entitlements.mac.inherit.plist' } };
  const config = devPackageConfiguration(base, 'a'.repeat(40), '/tmp/icon.icns', '0.6.0-beta3');
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.entitlements, 'resources/entitlements.dev.plist');
  assert.equal(config.mac.entitlementsInherit, config.mac.entitlements);
  const dev = readFileSync(new URL(`../packages/desktop/${config.mac.entitlements}`, import.meta.url), 'utf8');
  assert.match(dev, /<key>com\.apple\.security\.cs\.disable-library-validation<\/key>\s*<true\s*\/>/);
  assert.match(dev, /<key>com\.apple\.security\.cs\.allow-jit<\/key>\s*<true\s*\/>/);
  for (const path of [base.mac.entitlements, base.mac.entitlementsInherit]) {
    const stable = readFileSync(new URL(`../packages/desktop/${path}`, import.meta.url), 'utf8');
    assert.doesNotMatch(stable, /disable-library-validation/);
  }
  assert.equal(base.mac.entitlements, 'resources/entitlements.mac.plist');
});

test('Dev artifact admission rejects missing or false signed entitlements', () => {
  const entitlements = { 'com.apple.security.cs.allow-jit': true, 'com.apple.security.cs.disable-library-validation': true };
  assert.doesNotThrow(() => assertDevSigningEntitlements(entitlements));
  for (const key of Object.keys(entitlements)) {
    const missing = { ...entitlements };
    delete missing[key];
    assert.throws(() => assertDevSigningEntitlements(missing), /missing entitlement/);
    assert.throws(() => assertDevSigningEntitlements({ ...entitlements, [key]: false }), /missing entitlement/);
  }
  const smoke = readFileSync(new URL('./dev-package-smoke.mjs', import.meta.url), 'utf8');
  assert.ok(smoke.indexOf('assertDevSigningEntitlements(entitlements)') < smoke.indexOf('await _electron.launch'));
  assert.match(smoke, /--entitlements/);
  assert.match(smoke, /helpers\.map/);
  assert.match(smoke, /\[appPath, bundledNode,/);
  assert.match(smoke, /new Database\(':memory:'\)/);
  assert.ok(smoke.indexOf('execFileSync(bundledNode') < smoke.indexOf('await _electron.launch'));
});

test('Dev packaging rejects missing OAuth configuration before building and checks the embedded client', () => {
  const clientId = 'Ov23liFixtureClient';
  assert.equal(requireDevOAuthClientId(` ${clientId} `), clientId);
  for (const invalid of [undefined, null, '', '  ', 'short', 'id with spaces', 'x'.repeat(201)]) {
    assert.throws(() => requireDevOAuthClientId(invalid), /GIAN_GITHUB_CLIENT_ID/);
  }
  assert.doesNotThrow(() => assertDevOAuthConfiguration({ clientId }, clientId));
  assert.throws(() => assertDevOAuthConfiguration({ clientId: '' }, clientId), /GIAN_GITHUB_CLIENT_ID/);
  assert.throws(() => assertDevOAuthConfiguration({ clientId: 'OtherValidClient' }, clientId), /differs/);
  const builder = readFileSync(new URL('./build-dev-package.mjs', import.meta.url), 'utf8');
  const validation = builder.indexOf('requireDevOAuthClientId(process.env.GIAN_GITHUB_CLIENT_ID)');
  assert.ok(validation >= 0 && validation < builder.indexOf("run('pnpm', ['run', 'bundle:build'])"));
  const smoke = readFileSync(new URL('./dev-package-smoke.mjs', import.meta.url), 'utf8');
  const artifactValidation = smoke.indexOf('assertDevOAuthConfiguration(authConfig, expectedClientId)');
  assert.ok(artifactValidation >= 0 && artifactValidation < smoke.indexOf('await _electron.launch'));
});

test('Desktop evidence cannot qualify another build, stale result, missing test or replaced ZIP', () => {
  const assets = [{ name: 'Gian.zip', size: 1, sha256: 'a'.repeat(64) }];
  const build = { sha: 'a'.repeat(40), version: '0.6.0', runId: 1, assets };
  const receipt = { schema: 1, plan: DESKTOP_PLAN, status: 'PASS', sha: build.sha, version: build.version, buildRunId: 1, bundleId: 'com.gian.desktop', platform: 'darwin', arch: 'arm64', macos: '15', completedAt: new Date().toISOString(), checks: Object.fromEntries(DESKTOP_CHECKS.map(id => [id, 'PASS'])), assets };
  assert.doesNotThrow(() => assertDesktopAcceptance(receipt, build, assets));
  for (const patch of [{ buildRunId: 2 }, { completedAt: '2020-01-01' }, { checks: {} }, { assets: [] }]) assert.throws(() => assertDesktopAcceptance({ ...receipt, ...patch }, build, assets));
  assert.throws(() => assertDesktopAcceptance(receipt, build, []));
  assert.throws(() => assertDesktopAcceptance({ ...receipt, version: '0.6.1' }, { ...build, version: '0.6.1' }, assets), /auto-update/);
});

test('worktree allocation starts at 8992 and persists a distinct paired port', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gian-ports-test-'));
  try {
    const registry = join(root, 'registry');
    const available = async () => true;
    assert.deepEqual(await allocatePorts(join(root, 'one'), registry, available), { host: 8992, web: 5192 });
    assert.deepEqual(await allocatePorts(join(root, 'two'), registry, available), { host: 8993, web: 5193 });
    assert.deepEqual(await allocatePorts(join(root, 'one'), registry, available), { host: 8992, web: 5192 });
    assert.throws(() => validatePorts({ host: 8991, web: 5191 }));
    assert.throws(() => validatePorts({ host: 8992, web: 5191 }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
