import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { proxyDefinitions, shippingProxyIds } from './build-proxy-artifacts.mjs';
import { reviewedExternalRuntimeCandidates } from './proxy-release-metadata.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const artifactRequiredStepIds = [
  'protocol-build',
  'acceptance-catalog',
  'signed-catalog',
  'artifact-contract',
  'full-deterministic',
  'proxy-ui',
  'preview',
  'proxy-artifacts',
  'runtime-artifacts',
  'candidate-binding',
];

function sameMembers(actual, expected) {
  return actual.length === expected.length
    && actual.every(value => expected.includes(value));
}

function candidateByProvider(items = []) {
  return new Map(items.map(item => [item.provider, item]));
}

export function validateProxyReleaseCertificate(
  certificate,
  {
    revision,
    provider = null,
    version = null,
    runId = null,
    runAttempt = null,
    repository = null,
    now = Date.now(),
  } = {},
) {
  const issues = [];
  if (certificate?.schemaVersion !== 2) issues.push('certificate schemaVersion must be 2');
  if (certificate?.evidenceModel !== 'hosted-artifact-qualification-v1') {
    issues.push('certificate evidence model is not hosted artifact qualification');
  }
  if (!/^(?:artifacts|release)-[a-f0-9]{40}-[0-9]+-[0-9]+$/u.test(certificate?.certificateId ?? '')) {
    issues.push('certificate has no valid immutable certificateId');
  }
  if (certificate?.stage !== 'artifacts' && certificate?.stage !== 'release') {
    issues.push('certificate stage must be artifacts or release');
  }
  if (certificate?.artifactPublicationEligible !== true) {
    issues.push('certificate is not eligible for artifact publication');
  }
  if (certificate?.qualified !== true) issues.push('certificate is not qualified');
  if (certificate?.status !== 'PASS') issues.push('certificate status is not PASS');
  if (certificate?.dirty !== false) issues.push('certificate revision was dirty');
  if (!revision || certificate?.revision !== revision) {
    issues.push(`certificate revision ${String(certificate?.revision)} != ${String(revision)}`);
  }
  if (certificate?.runner?.environment !== 'github-hosted'
    || certificate?.runner?.os !== 'macOS'
    || certificate?.runner?.arch !== 'ARM64'
    || !/^[0-9]+$/u.test(certificate?.runner?.runId ?? '')
    || !/^[0-9]+$/u.test(certificate?.runner?.runAttempt ?? '')
    || typeof certificate?.runner?.repository !== 'string'
    || certificate.runner.repository.length === 0) {
    issues.push('certificate was not issued by a GitHub-hosted macOS ARM64 run');
  }
  const expectedCertificateId = `${certificate?.stage}-${certificate?.revision}-${certificate?.runner?.runId}-${certificate?.runner?.runAttempt}`;
  if (certificate?.certificateId !== expectedCertificateId) {
    issues.push('certificateId does not bind its revision and GitHub run provenance');
  }
  if (runId !== null && certificate?.runner?.runId !== String(runId)) {
    issues.push(`certificate run ${String(certificate?.runner?.runId)} != ${String(runId)}`);
  }
  if (runAttempt !== null && certificate?.runner?.runAttempt !== String(runAttempt)) {
    issues.push(`certificate run attempt ${String(certificate?.runner?.runAttempt)} != ${String(runAttempt)}`);
  }
  if (repository !== null && certificate?.runner?.repository !== repository) {
    issues.push(`certificate repository ${String(certificate?.runner?.repository)} != ${repository}`);
  }
  if (!Array.isArray(certificate?.shippingProxyIds)
    || !sameMembers(certificate.shippingProxyIds, shippingProxyIds)) {
    issues.push('certificate shipping Proxy set does not match the current shipping set');
  }
  if (!Array.isArray(certificate?.providers)
    || !sameMembers(certificate.providers, shippingProxyIds)) {
    issues.push('Release certificate must cover the complete shipping Proxy set');
  }

  const completedAt = Date.parse(certificate?.completedAt ?? '');
  const maxAgeHours = certificate?.certificateMaxAgeHours;
  const ageMs = now - completedAt;
  if (!Number.isFinite(completedAt)
    || !Number.isFinite(maxAgeHours)
    || maxAgeHours <= 0
    || ageMs < 0
    || ageMs > maxAgeHours * 60 * 60 * 1_000) {
    issues.push('certificate is future-dated, expired, or has no valid evidence age limit');
  }

  const steps = Array.isArray(certificate?.steps) ? certificate.steps : [];
  const requiredStepIds = certificate?.stage === 'release'
    ? [...artifactRequiredStepIds, 'package']
    : artifactRequiredStepIds;
  for (const id of requiredStepIds) {
    const matches = steps.filter(step => step?.id === id);
    if (matches.length !== 1 || matches[0]?.status !== 'PASS') {
      issues.push(`required Release step ${id} is absent, duplicated, or not PASS`);
    }
  }
  if (steps.some(step => step?.status !== 'PASS')) {
    issues.push('certificate contains a non-PASS step');
  }

  const packages = candidateByProvider(certificate?.candidatePackages);
  const tuples = candidateByProvider(certificate?.candidateTuple);
  const runtimeArtifacts = candidateByProvider(certificate?.runtimeArtifacts);
  for (const id of shippingProxyIds) {
    const definition = proxyDefinitions.find(candidate => candidate.id === id);
    const packageCandidate = packages.get(id);
    const tuple = tuples.get(id);
    if (!packageCandidate || !definition) {
      issues.push(`${id} has no candidate package metadata`);
      continue;
    }
    if (packageCandidate.packageName !== definition.packageName
      || packageCandidate.processScope !== definition.manifest.process.scope) {
      issues.push(`${id} candidate package identity does not match the shipping definition`);
    }
    if (!tuple) {
      issues.push(`${id} has no qualified candidate tuple`);
      continue;
    }
    if (tuple.proxy?.source !== 'packaged-artifact'
      || tuple.proxy?.proxyVersion !== packageCandidate.proxyVersion
      || !/^[a-f0-9]{64}$/u.test(tuple.proxy?.sha256 ?? '')) {
      issues.push(`${id} Proxy tuple is not an exact packaged candidate`);
    }
    if (tuple.cli?.verified !== true
      || !packageCandidate.runtime?.verifiedCliVersions?.includes(tuple.cli?.version)) {
      issues.push(`${id} CLI tuple is not a verified version`);
    }
    if (!/^[a-f0-9]{64}$/u.test(tuple.cli?.sha256 ?? '')
      || !Number.isSafeInteger(tuple.cli?.size)
      || tuple.cli.size <= 0) {
      issues.push(`${id} CLI tuple has no exact artifact identity`);
    }
    if (definition.pluginId === 'com.zhipu.zcode') {
      const reviewed = reviewedExternalRuntimeCandidates[id];
      if (!reviewed
        || tuple.cli?.source !== 'reviewed-external-app'
        || tuple.cli?.version !== reviewed.version
        || tuple.cli?.sha256 !== reviewed.sha256
        || tuple.cli?.size !== reviewed.size) {
        issues.push(`${id} external-App Runtime is not the reviewed compatibility candidate`);
      }
    } else {
      const runtime = runtimeArtifacts.get(id);
      if (tuple.cli?.source !== 'managed-runtime-artifact'
        || !runtime
        || runtime.version !== tuple.cli?.version
        || runtime.entry?.sha256 !== tuple.cli?.sha256
        || runtime.entry?.size !== tuple.cli?.size
        || !['raw', 'tar.gz'].includes(runtime.format)
        || !/^[a-f0-9]{64}$/u.test(runtime.asset?.sha256 ?? '')
        || !Number.isSafeInteger(runtime.asset?.size)
        || runtime.asset.size <= 0) {
        issues.push(`${id} managed Runtime artifact is not bound to the qualified CLI tuple`);
      }
    }
  }

  if (provider) {
    if (!shippingProxyIds.includes(provider)) issues.push(`${provider} is not a shipping Proxy`);
    const selected = packages.get(provider);
    if (!selected) issues.push(`${provider} is absent from candidatePackages`);
    else if (version && selected.proxyVersion !== version) {
      issues.push(`${provider} certificate version ${selected.proxyVersion} != ${version}`);
    }
  }
  return issues;
}

export async function verifyPackagedProxyArtifacts(certificate, artifactDir) {
  const issues = [];
  const packages = candidateByProvider(certificate?.candidatePackages);
  const tuples = candidateByProvider(certificate?.candidateTuple);
  for (const provider of shippingProxyIds) {
    const packageCandidate = packages.get(provider);
    const tuple = tuples.get(provider);
    if (!packageCandidate || !tuple) continue;
    const assetName = `gian-proxy-${provider}-${packageCandidate.proxyVersion}-darwin-arm64.tar.gz`;
    const assetPath = resolve(artifactDir, assetName);
    try {
      const [asset, checksumText, manifestText] = await Promise.all([
        readFile(assetPath),
        readFile(`${assetPath}.sha256`, 'utf8'),
        readFile(`${assetPath}.manifest.json`, 'utf8'),
      ]);
      const sha256 = createHash('sha256').update(asset).digest('hex');
      const recorded = checksumText.trim().split(/\s+/u)[0];
      const manifest = JSON.parse(manifestText);
      if (sha256 !== tuple.proxy?.sha256 || recorded !== sha256) {
        issues.push(`${provider} downloaded artifact SHA-256 differs from certified evidence`);
      }
      if (manifest.id !== packageCandidate.pluginId
        || manifest.pluginVersion !== packageCandidate.proxyVersion
        || manifest.process?.scope !== packageCandidate.processScope) {
        issues.push(`${provider} downloaded manifest differs from certified package metadata`);
      }
    } catch (error) {
      issues.push(`${provider} packaged artifact is unreadable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return issues;
}

function parseArgs(argv) {
  const options = {
    certificate: null,
    artifactDir: null,
    revision: null,
    provider: null,
    version: null,
    runId: null,
    runAttempt: null,
    repository: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--certificate') options.certificate = argv[++index];
    else if (arg === '--artifact-dir') options.artifactDir = argv[++index];
    else if (arg === '--revision') options.revision = argv[++index];
    else if (arg === '--provider') options.provider = argv[++index];
    else if (arg === '--version') options.version = argv[++index];
    else if (arg === '--run-id') options.runId = argv[++index];
    else if (arg === '--run-attempt') options.runAttempt = argv[++index];
    else if (arg === '--repository') options.repository = argv[++index];
    else throw new Error(`Unknown certificate verification argument ${arg}.`);
  }
  for (const required of [
    'certificate',
    'artifactDir',
    'revision',
    'provider',
    'version',
    'runId',
    'runAttempt',
    'repository',
  ]) {
    if (!options[required]) throw new Error(`--${required.replace(/[A-Z]/gu, match => `-${match.toLowerCase()}`)} is required.`);
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const certificate = JSON.parse(await readFile(resolve(rootDir, options.certificate), 'utf8'));
  const issues = [
    ...validateProxyReleaseCertificate(certificate, options),
    ...await verifyPackagedProxyArtifacts(certificate, resolve(rootDir, options.artifactDir)),
  ];
  if (issues.length > 0) throw new Error(`Proxy Release certificate rejected:\n- ${issues.join('\n- ')}`);
  console.log(JSON.stringify({
    status: 'PASS',
    revision: options.revision,
    provider: options.provider,
    version: options.version,
    certificate: resolve(rootDir, options.certificate),
  }, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
