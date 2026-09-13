import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseProxyCertificationOptions,
  proxyCertificationPlan,
  validateCandidateTuple,
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
    'real-provider',
  ]);
  assert.equal(plan.some(step => step.id === 'package'), false);
  assert.equal(plan.at(-1).authorizationEnvironment, 'GIAN_ALLOW_REAL_AGENT_TURN');
});

test('release certification cannot omit preview, package, or real Provider evidence', () => {
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
    'real-provider',
  ]);
  assert.equal(plan.find(step => step.id === 'preview').authorizationEnvironment,
    'GIAN_ALLOW_ELECTRON_PREVIEW');
  assert.equal(plan.find(step => step.id === 'proxy-artifacts').authorizationEnvironment,
    'GIAN_ALLOW_PACKAGE');
  assert.equal(plan.find(step => step.id === 'package').authorizationEnvironment,
    'GIAN_ALLOW_PACKAGE');
  assert.equal(plan.at(-1).authorizationEnvironment, 'GIAN_ALLOW_REAL_AGENT_TURN');
  assert.ok(plan.at(-1).args.includes('--artifact-dir'));
  for (const provider of shippingProxyIds) {
    assert.ok(plan.at(-1).args.includes(provider));
  }
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

test('release candidate binding requires the exact fresh packaged Proxy and verified CLI tuple', () => {
  const certificate = {
    revision: 'candidate-sha',
    realEvidenceMaxAgeHours: 72,
    candidatePackages: [{
      provider: 'codex',
      proxyVersion: '0.2.10',
      runtime: { verifiedCliVersions: ['0.146.0'] },
    }],
  };
  const validRun = {
    revision: 'candidate-sha',
    completedAt: new Date().toISOString(),
    candidateTuple: [{
      provider: 'codex',
      proxy: {
        source: 'packaged-artifact',
        proxyVersion: '0.2.10',
        sha256: 'a'.repeat(64),
      },
      cli: { version: '0.146.0', verified: true, sha256: 'b'.repeat(64), size: 123 },
    }],
  };
  assert.deepEqual(validateCandidateTuple(certificate, validRun).issues, []);

  const invalid = structuredClone(validRun);
  invalid.revision = 'other-sha';
  invalid.completedAt = '2025-01-01T00:00:00.000Z';
  invalid.candidateTuple[0].proxy.source = 'workspace-dist';
  invalid.candidateTuple[0].cli.verified = false;
  const issues = validateCandidateTuple(certificate, invalid).issues.join('\n');
  assert.match(issues, /revision/);
  assert.match(issues, /older than 72h/);
  assert.match(issues, /packaged Proxy artifact/);
  assert.match(issues, /not verified/);
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
    /differs from the real Provider candidate/,
  );
});

test('Proxy publication accepts a fresh full-shipping artifact certificate for the exact revision', () => {
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
    schemaVersion: 1,
    certificateId: `artifacts-${'c'.repeat(40)}`,
    stage: 'artifacts',
    admissionEligible: false,
    artifactPublicationEligible: true,
    qualified: true,
    status: 'PASS',
    revision: 'release-sha',
    dirty: false,
    shippingProxyIds: [...shippingProxyIds],
    providers: [...shippingProxyIds],
    realEvidenceMaxAgeHours: 72,
    completedAt: new Date().toISOString(),
    steps: [
      'acceptance-catalog',
      'signed-catalog',
      'artifact-contract',
      'full-deterministic',
      'proxy-ui',
      'preview',
      'proxy-artifacts',
      'real-provider',
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
        version: candidate.runtime.verifiedCliVersions[0],
        verified: true,
        sha256: 'b'.repeat(64),
        size: 123,
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
    revision: 'release-sha',
    provider: candidatePackages[0].provider,
    version: candidatePackages[0].proxyVersion,
  }), []);

  const forged = structuredClone(certificate);
  forged.providers.pop();
  forged.steps.find(step => step.id === 'real-provider').status = 'BLOCKED';
  forged.candidateTuple.find(tuple => tuple.provider === candidatePackages[0].provider).cli.verified = false;
  const issues = validateProxyReleaseCertificate(forged, {
    revision: 'other-sha',
    provider: candidatePackages[0].provider,
    version: '0.2.11',
  }).join('\n');
  assert.match(issues, /revision/);
  assert.match(issues, /complete shipping Proxy set/);
  assert.match(issues, /real-provider/);
  assert.match(issues, /non-PASS step/);
  assert.match(issues, /CLI tuple/);
  assert.match(issues, /certificate version/);
});
