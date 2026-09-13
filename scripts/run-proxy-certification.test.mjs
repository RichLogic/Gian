import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildArtifactCandidateTuple,
  parseProxyCertificationOptions,
  proxyCertificationPlan,
  validateRuntimeArtifactTuple,
} from './run-proxy-certification.mjs';
import { validateProxyReleaseCertificate } from './verify-proxy-release-certificate.mjs';
import { proxyDefinitions, shippingProxyIds } from './build-proxy-artifacts.mjs';

test('development certification is deterministic and never claims admission', () => {
  const options = parseProxyCertificationOptions([
    '--', '--stage', 'development',
    '--base', 'task-base',
  ]);
  assert.deepEqual(options.providers, shippingProxyIds);
  assert.deepEqual(
    proxyCertificationPlan(options).map(step => [step.id, step.lane]),
    [
      ['acceptance-catalog', 'catalog'],
      ['signed-catalog', 'catalog'],
      ['artifact-contract', 'proxy-artifacts'],
      ['affected-deterministic', 'deterministic'],
    ],
  );
});

test('nightly certification includes full deterministic and every-Proxy UI evidence', () => {
  const options = parseProxyCertificationOptions(['--stage', 'nightly']);
  const plan = proxyCertificationPlan(options);
  assert.deepEqual(plan.map(step => step.id), [
    'acceptance-catalog',
    'signed-catalog',
    'artifact-contract',
    'full-deterministic',
    'proxy-ui',
  ]);
  const ui = plan.find(step => step.id === 'proxy-ui');
  for (const provider of shippingProxyIds) {
    assert.ok(ui.args.includes(provider));
  }
  assert.equal(plan.some(step => step.lane === 'real-provider'), false);
});

test('artifact certification breaks the first-publication cycle without weakening Proxy evidence', () => {
  const options = parseProxyCertificationOptions([
    '--stage', 'artifacts',
    '--base', 'artifact-base',
  ]);
  const plan = proxyCertificationPlan(options);
  assert.deepEqual(plan.map(step => step.id), [
    'acceptance-catalog',
    'signed-catalog',
    'artifact-contract',
    'full-deterministic',
    'proxy-ui',
    'preview',
    'proxy-artifacts',
    'runtime-artifacts',
  ]);
  assert.equal(plan.some(step => step.id === 'package'), false);
  assert.equal(plan.some(step => step.lane === 'real-provider'), false);
});

test('release certification cannot omit preview, package, or Runtime artifact evidence', () => {
  const options = parseProxyCertificationOptions([
    '--stage', 'release',
    '--base', 'release-base',
  ]);
  const plan = proxyCertificationPlan(options);
  assert.deepEqual(plan.map(step => step.id), [
    'acceptance-catalog',
    'signed-catalog',
    'artifact-contract',
    'full-deterministic',
    'proxy-ui',
    'preview',
    'proxy-artifacts',
    'package',
    'runtime-artifacts',
  ]);
  assert.equal(plan.find(step => step.id === 'preview').authorizationEnvironment,
    'GIAN_ALLOW_ELECTRON_PREVIEW');
  assert.equal(plan.find(step => step.id === 'proxy-artifacts').authorizationEnvironment,
    'GIAN_ALLOW_PACKAGE');
  assert.equal(plan.find(step => step.id === 'package').authorizationEnvironment,
    'GIAN_ALLOW_PACKAGE');
  assert.equal(plan.some(step => step.lane === 'real-provider'), false);
  assert.ok(plan.at(-1).args.includes('scripts/verify-managed-runtime-candidates.mjs'));
});

test('certification rejects ambiguous stages, missing bases, and hidden Proxies', () => {
  assert.throws(() => parseProxyCertificationOptions([]), /--stage must be/);
  assert.throws(
    () => parseProxyCertificationOptions(['--stage', 'development']),
    /--base is required/,
  );
  assert.throws(
    () => parseProxyCertificationOptions(['--stage', 'release', '--base', 'x', '--provider', 'grok']),
    /only accepts shipping Proxies: grok/,
  );
  assert.throws(
    () => parseProxyCertificationOptions([
      '--stage', 'release', '--base', 'x', '--provider', shippingProxyIds[0],
    ]),
    /complete shipping Proxy set/,
  );
});

test('release candidate binding derives the exact packaged Proxy and managed Runtime tuple', async (t) => {
  const artifactDir = await mkdtemp(join(tmpdir(), 'gian-artifact-binding-'));
  t.after(() => rm(artifactDir, { recursive: true, force: true }));
  const archive = Buffer.from('codex proxy archive');
  const sha256 = createHash('sha256').update(archive).digest('hex');
  const certificate = {
    candidatePackages: [{
      provider: 'codex',
      pluginId: 'codex',
      processScope: 'shared',
      proxyVersion: '0.2.10',
      runtime: { verifiedCliVersions: ['0.146.0'] },
    }],
  };
  await Promise.all([
    writeFile(join(artifactDir, 'gian-proxy-codex-0.2.10-darwin-arm64.tar.gz'), archive),
    writeFile(join(artifactDir, 'gian-proxy-codex-0.2.10-darwin-arm64.tar.gz.sha256'), `${sha256}\n`),
    writeFile(join(artifactDir, 'gian-proxy-codex-0.2.10-darwin-arm64.tar.gz.manifest.json'), JSON.stringify({
      id: 'codex', pluginVersion: '0.2.10', process: { scope: 'shared' },
    })),
  ]);
  const runtimeManifest = {
    candidates: [{
      provider: 'codex',
      version: '0.146.0',
      entry: { sha256: 'b'.repeat(64), size: 123 },
    }],
  };
  const binding = await buildArtifactCandidateTuple(certificate, runtimeManifest, artifactDir);
  assert.deepEqual(binding.issues, []);
  assert.equal(binding.tuples[0].proxy.sha256, sha256);
  assert.equal(binding.tuples[0].cli.source, 'managed-runtime-artifact');
  assert.equal(binding.tuples[0].cli.sha256, 'b'.repeat(64));
});

test('artifact certificate binds the downloadable Runtime to the exact exercised entry', () => {
  const candidateTuple = shippingProxyIds.map(provider => ({
    provider,
    cli: { version: '1.2.3', sha256: 'a'.repeat(64), size: 12 },
  }));
  const runtimeProviders = shippingProxyIds.filter(provider => provider !== 'zcode');
  const manifest = {
    schemaVersion: 1,
    platform: 'darwin-arm64',
    candidates: runtimeProviders.map(provider => ({
      provider,
      version: '1.2.3',
      format: 'raw',
      entry: { sha256: 'a'.repeat(64), size: 12 },
      asset: { url: 'https://downloads.example.test/runtime', sha256: 'b'.repeat(64), size: 24 },
    })),
  };
  assert.deepEqual(validateRuntimeArtifactTuple({ candidateTuple }, manifest).issues, []);
  manifest.candidates[0].entry.sha256 = 'c'.repeat(64);
  assert.match(
    validateRuntimeArtifactTuple({ candidateTuple }, manifest).issues.join('\n'),
    /differs from the qualified artifact candidate/,
  );
});

test('Proxy publication accepts a fresh full-shipping artifact certificate for the exact revision', () => {
  const revision = 'c'.repeat(40);
  const candidatePackages = proxyDefinitions
    .filter(definition => definition.shipping)
    .map(definition => ({
      provider: definition.id,
      pluginId: definition.pluginId,
      packageName: definition.packageName,
      proxyVersion: definition.pluginVersion,
      processScope: definition.manifest.process.scope,
      runtime: {
        verifiedCliVersions: [...(definition.manifest.runtime.verifiedVersions ?? [])],
      },
    }));
  const certificate = {
    schemaVersion: 2,
    evidenceModel: 'hosted-artifact-qualification-v1',
    certificateId: `artifacts-${'c'.repeat(40)}-123-1`,
    stage: 'artifacts',
    admissionEligible: false,
    artifactPublicationEligible: true,
    qualified: true,
    status: 'PASS',
    revision,
    dirty: false,
    shippingProxyIds: [...shippingProxyIds],
    providers: [...shippingProxyIds],
    certificateMaxAgeHours: 72,
    runner: {
      environment: 'github-hosted',
      os: 'macOS',
      arch: 'ARM64',
      repository: 'RichLogic/Gian',
      runId: '123',
      runAttempt: '1',
    },
    completedAt: new Date().toISOString(),
    steps: [
      'acceptance-catalog',
      'signed-catalog',
      'artifact-contract',
      'full-deterministic',
      'proxy-ui',
      'preview',
      'proxy-artifacts',
      'runtime-artifacts',
      'candidate-binding',
    ].map(id => ({ id, status: 'PASS' })),
    candidatePackages,
    candidateTuple: candidatePackages.map(candidate => ({
      provider: candidate.provider,
      proxy: {
        source: 'packaged-artifact',
        proxyVersion: candidate.proxyVersion,
        sha256: 'a'.repeat(64),
      },
      cli: {
        source: candidate.pluginId === 'com.zhipu.zcode'
          ? 'reviewed-external-app'
          : 'managed-runtime-artifact',
        version: candidate.runtime.verifiedCliVersions[0],
        verified: true,
        sha256: candidate.pluginId === 'com.zhipu.zcode'
          ? 'e9f1868c0fdb863537ed910ee3828b9be96b8c2fd805473f63b439e1113266b8'
          : 'b'.repeat(64),
        size: candidate.pluginId === 'com.zhipu.zcode' ? 12615227 : 123,
      },
    })),
    runtimeArtifacts: candidatePackages
      .filter(candidate => candidate.pluginId !== 'com.zhipu.zcode')
      .map(candidate => ({
        provider: candidate.provider,
        version: candidate.runtime.verifiedCliVersions[0],
        format: 'raw',
        entry: { sha256: 'b'.repeat(64), size: 123 },
        asset: { sha256: 'c'.repeat(64), size: 456 },
      })),
  };
  assert.deepEqual(validateProxyReleaseCertificate(certificate, {
    revision,
    provider: candidatePackages[0].provider,
    version: candidatePackages[0].proxyVersion,
    runId: '123',
    runAttempt: '1',
    repository: 'RichLogic/Gian',
  }), []);

  const forged = structuredClone(certificate);
  forged.providers.pop();
  forged.steps.find(step => step.id === 'runtime-artifacts').status = 'BLOCKED';
  forged.candidateTuple.find(tuple => tuple.provider === candidatePackages[0].provider).cli.verified = false;
  const issues = validateProxyReleaseCertificate(forged, {
    revision: 'other-sha',
    provider: candidatePackages[0].provider,
    version: '0.2.11',
  }).join('\n');
  assert.match(issues, /revision/);
  assert.match(issues, /complete shipping Proxy set/);
  assert.match(issues, /runtime-artifacts/);
  assert.match(issues, /non-PASS step/);
  assert.match(issues, /CLI tuple/);
  assert.match(issues, /certificate version/);

  const selfHosted = structuredClone(certificate);
  selfHosted.runner.environment = 'self-hosted';
  assert.match(
    validateProxyReleaseCertificate(selfHosted, { revision }).join('\n'),
    /GitHub-hosted macOS ARM64/,
  );
  assert.match(
    validateProxyReleaseCertificate(certificate, {
      revision,
      runId: '999',
      runAttempt: '2',
      repository: 'Other/Gian',
    }).join('\n'),
    /certificate run 123 != 999[\s\S]*run attempt 1 != 2[\s\S]*repository RichLogic\/Gian != Other\/Gian/,
  );
});
