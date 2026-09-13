import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { proxyDefinitions, shippingProxyIds } from './build-proxy-artifacts.mjs';
import {
  loadProxyRealAcceptanceCatalog,
  validateProxyRealAcceptanceCatalog,
} from './proxy-real-acceptance-catalog.mjs';
import { reviewedExternalRuntimeCandidates } from './proxy-release-metadata.mjs';

const execFileAsync = promisify(execFile);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stages = new Set(['development', 'nightly', 'artifacts', 'release']);
const previewAuthorization = 'GIAN_ALLOW_ELECTRON_PREVIEW';
const packageAuthorization = 'GIAN_ALLOW_PACKAGE';

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function timestampSlug() {
  return new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z');
}

function pnpmInvocation(args) {
  const pnpmEntry = process.env.npm_execpath;
  return pnpmEntry
    ? { command: process.execPath, args: [pnpmEntry, ...args] }
    : { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args };
}

function pnpmStep(id, lane, args, extra = {}) {
  return { id, lane, ...pnpmInvocation(args), required: true, ...extra };
}

function nodeStep(id, lane, args, extra = {}) {
  return { id, lane, command: process.execPath, args, required: true, ...extra };
}

export function parseProxyCertificationOptions(argv = []) {
  const options = {
    stage: null,
    base: null,
    output: `output/proxy-certification/run-${timestampSlug()}`,
    providers: [],
    plan: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--stage') options.stage = argv[++index];
    else if (arg === '--base') options.base = argv[++index];
    else if (arg === '--provider') options.providers.push(argv[++index]);
    else if (arg === '--output') options.output = argv[++index];
    else if (arg === '--plan') options.plan = true;
    else throw new Error(`Unknown Proxy certification argument ${arg}.`);
  }
  if (!stages.has(options.stage)) {
    throw new Error('--stage must be development, nightly, artifacts, or release.');
  }
  if ((options.stage === 'development' || options.stage === 'artifacts' || options.stage === 'release') && !options.base) {
    throw new Error(`--base is required for ${options.stage} certification.`);
  }
  if (!options.output) throw new Error('--output requires a value.');
  const selected = options.providers.length === 0 || options.providers.includes('all')
    ? [...shippingProxyIds]
    : [...new Set(options.providers)];
  const unknown = selected.filter(provider => !shippingProxyIds.includes(provider));
  if (unknown.length > 0) {
    throw new Error(`Certification only accepts shipping Proxies: ${unknown.join(', ')}.`);
  }
  if (
    (options.stage === 'artifacts' || options.stage === 'release')
    && (selected.length !== shippingProxyIds.length
      || shippingProxyIds.some(provider => !selected.includes(provider)))
  ) {
    throw new Error('Release certification must cover the complete shipping Proxy set.');
  }
  options.providers = selected;
  return options;
}

export function proxyCertificationPlan(options) {
  const steps = [nodeStep(
    'acceptance-catalog',
    'catalog',
    ['--test', 'scripts/proxy-real-acceptance-catalog.test.mjs'],
  ), pnpmStep(
    'signed-catalog',
    'catalog',
    ['catalog:verify'],
  ), nodeStep(
    'artifact-contract',
    'proxy-artifacts',
    ['--test', 'scripts/build-proxy-artifacts.test.mjs'],
  )];
  if (options.stage === 'development') {
    steps.push(pnpmStep(
      'affected-deterministic',
      'deterministic',
      ['verify:quick', '--', '--base', options.base],
    ));
    return steps;
  }

  steps.push(pnpmStep('full-deterministic', 'deterministic', ['test:all']));
  steps.push(pnpmStep(
    'proxy-ui',
    'ui',
    ['test:e2e:proxy-mock', '--', ...options.providers.flatMap(provider => ['--provider', provider])],
  ));
  if (options.stage === 'nightly') return steps;

  steps.push(pnpmStep(
    'preview',
    'preview',
    ['verify:preview', '--', '--base', options.base],
    { authorizationEnvironment: previewAuthorization },
  ));
  steps.push(pnpmStep(
    'proxy-artifacts',
    'proxy-artifacts',
    ['release:proxies'],
    { authorizationEnvironment: packageAuthorization },
  ));
  if (options.stage === 'release') {
    steps.push(pnpmStep(
      'package',
      'package',
      ['quality:package'],
      { authorizationEnvironment: packageAuthorization },
    ));
  }
  steps.push(nodeStep(
    'runtime-artifacts',
    'runtime-artifacts',
    ['scripts/verify-managed-runtime-candidates.mjs'],
  ));
  return steps;
}

function redact(text) {
  return String(text)
    .replace(/(authorization|access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password)(["'\s:=]+)([^\s,"'}]+)/giu, '$1$2[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/giu, 'Bearer [redacted]');
}

function runStep(step, outputDir, environment = {}) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const chunks = [];
  return new Promise((resolveRun, reject) => {
    const child = spawn(step.command, step.args, {
      cwd: rootDir,
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const forward = (stream, target) => stream.on('data', chunk => {
      chunks.push(chunk);
      target.write(chunk);
    });
    forward(child.stdout, process.stdout);
    forward(child.stderr, process.stderr);
    child.once('error', reject);
    child.once('close', async (code, signal) => {
      const logPath = resolve(outputDir, `${step.id}.log`);
      await writeFile(logPath, redact(Buffer.concat(chunks).toString()), 'utf8');
      resolveRun({
        id: step.id,
        lane: step.lane,
        command: [step.command, ...step.args],
        status: code === 0 ? 'PASS' : 'FAIL',
        exitCode: code,
        signal,
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: Date.now() - started,
        logPath,
      });
    });
  });
}

async function revisionState() {
  const [{ stdout: revision }, { stdout: status }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }),
    execFileAsync('git', ['status', '--short'], { cwd: rootDir, encoding: 'utf8' }),
  ]);
  return { revision: revision.trim(), dirty: status.trim().length > 0 };
}

async function candidatePackages(providers) {
  return Promise.all(providers.map(async (provider) => {
    const definition = proxyDefinitions.find(candidate => candidate.id === provider);
    if (!definition) throw new Error(`Missing Proxy definition for ${provider}.`);
    const packageJson = JSON.parse(await readFile(
      resolve(rootDir, 'packages', 'proxies', definition.directory, 'package.json'),
      'utf8',
    ));
    return {
      provider,
      pluginId: definition.pluginId,
      packageName: definition.packageName,
      proxyVersion: packageJson.version,
      processScope: definition.manifest.process.scope,
      runtime: {
        id: definition.manifest.runtime.id ?? null,
        verifiedCliVersions: [...(definition.manifest.runtime.verifiedVersions ?? [])],
      },
    };
  }));
}

export async function buildArtifactCandidateTuple(
  certificate,
  runtimeManifest,
  artifactDir = resolve(rootDir, 'artifacts/proxies'),
) {
  const issues = [];
  const tuples = [];
  const runtimes = new Map((runtimeManifest?.candidates ?? []).map(candidate => [candidate.provider, candidate]));
  for (const expected of certificate.candidatePackages) {
    const definition = proxyDefinitions.find(candidate => candidate.id === expected.provider);
    if (!definition) {
      issues.push(`${expected.provider} has no shipping Proxy definition`);
      continue;
    }
    const assetName = `gian-proxy-${expected.provider}-${expected.proxyVersion}-darwin-arm64.tar.gz`;
    try {
      const [archive, checksum, manifestText] = await Promise.all([
        readFile(resolve(artifactDir, assetName)),
        readFile(resolve(artifactDir, `${assetName}.sha256`), 'utf8'),
        readFile(resolve(artifactDir, `${assetName}.manifest.json`), 'utf8'),
      ]);
      const proxySha256 = digest(archive);
      const manifest = JSON.parse(manifestText);
      if (checksum.trim().split(/\s+/u)[0] !== proxySha256) {
        issues.push(`${expected.provider} Proxy checksum sidecar differs from the packaged artifact`);
      }
      if (manifest.id !== expected.pluginId
        || manifest.pluginVersion !== expected.proxyVersion
        || manifest.process?.scope !== expected.processScope) {
        issues.push(`${expected.provider} packaged Manifest differs from candidate package metadata`);
      }
      const external = reviewedExternalRuntimeCandidates[expected.provider];
      const runtime = runtimes.get(expected.provider);
      const cli = external
        ? { ...external, verified: true }
        : runtime
          ? {
            source: 'managed-runtime-artifact',
            version: runtime.version,
            verified: true,
            sha256: runtime.entry?.sha256,
            size: runtime.entry?.size,
          }
          : null;
      if (!cli) issues.push(`${expected.provider} has no managed Runtime artifact candidate`);
      tuples.push({
        provider: expected.provider,
        proxy: {
          source: 'packaged-artifact',
          proxyVersion: expected.proxyVersion,
          sha256: proxySha256,
          size: archive.length,
        },
        cli,
      });
    } catch (error) {
      issues.push(`${expected.provider} packaged artifact is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { tuples, issues };
}

export function validateRuntimeArtifactTuple(certificate, runtimeManifest) {
  const issues = [];
  if (runtimeManifest?.schemaVersion !== 1 || runtimeManifest?.platform !== 'darwin-arm64') {
    return { candidates: [], issues: ['managed Runtime candidate manifest is invalid'] };
  }
  const candidates = Array.isArray(runtimeManifest.candidates) ? runtimeManifest.candidates : [];
  const artifacts = new Map(candidates.map(candidate => [candidate.provider, candidate]));
  const tuples = new Map((certificate.candidateTuple ?? []).map(tuple => [tuple.provider, tuple]));
  for (const provider of shippingProxyIds.filter(id => id !== 'zcode')) {
    const candidate = artifacts.get(provider);
    const tuple = tuples.get(provider);
    if (!candidate || !tuple) {
      issues.push(`${provider} has no managed Runtime artifact candidate`);
      continue;
    }
    if (candidate.version !== tuple.cli?.version
      || candidate.entry?.sha256 !== tuple.cli?.sha256
      || candidate.entry?.size !== tuple.cli?.size) {
      issues.push(`${provider} Runtime entry differs from the qualified artifact candidate`);
    }
    if (!['raw', 'tar.gz'].includes(candidate.format)
      || !/^[a-f0-9]{64}$/u.test(candidate.asset?.sha256 ?? '')
      || !Number.isSafeInteger(candidate.asset?.size)
      || candidate.asset.size <= 0
      || typeof candidate.asset?.url !== 'string'
      || !candidate.asset.url.startsWith('https://')) {
      issues.push(`${provider} Runtime artifact identity is invalid`);
    }
  }
  return { candidates, issues };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseProxyCertificationOptions(argv);
  const catalog = validateProxyRealAcceptanceCatalog(await loadProxyRealAcceptanceCatalog());
  const plan = proxyCertificationPlan(options);
  if (options.plan) {
    console.log(JSON.stringify({
      stage: options.stage,
      admissionEligible: options.stage === 'release',
      artifactPublicationEligible: options.stage === 'artifacts' || options.stage === 'release',
      shippingProxyIds,
      providers: options.providers,
      steps: plan.map(step => ({
        id: step.id,
        lane: step.lane,
        command: [step.command, ...step.args],
        authorizationEnvironment: step.authorizationEnvironment ?? null,
      })),
    }, null, 2));
    return null;
  }

  const outputDir = resolve(rootDir, options.output);
  await mkdir(outputDir, { recursive: true });
  const git = await revisionState();
  const githubRunId = process.env.GITHUB_RUN_ID?.trim() || null;
  const githubRunAttempt = process.env.GITHUB_RUN_ATTEMPT?.trim() || null;
  const runner = {
    environment: process.env.GIAN_RUNNER_ENVIRONMENT?.trim() || 'local',
    os: process.env.RUNNER_OS?.trim() || process.platform,
    arch: process.env.RUNNER_ARCH?.trim() || process.arch,
    repository: process.env.GITHUB_REPOSITORY?.trim() || null,
    runId: githubRunId,
    runAttempt: githubRunAttempt,
  };
  const certificate = {
    schemaVersion: 2,
    evidenceModel: 'hosted-artifact-qualification-v1',
    certificateId: `${options.stage}-${git.revision}-${githubRunId ?? 'local'}-${githubRunAttempt ?? '1'}`,
    stage: options.stage,
    admissionEligible: options.stage === 'release',
    artifactPublicationEligible: options.stage === 'artifacts' || options.stage === 'release',
    qualified: false,
    status: 'FAIL',
    revision: git.revision,
    dirty: git.dirty,
    base: options.base,
    catalogVersion: catalog.version,
    protocol: catalog.protocol,
    shippingProxyIds: [...shippingProxyIds],
    providers: [...options.providers],
    candidatePackages: await candidatePackages(options.providers),
    certificateMaxAgeHours: catalog.certification.artifactCertificateMaxAgeHours,
    runner,
    startedAt: new Date().toISOString(),
    steps: [],
  };

  let prerequisiteFailed = false;
  for (const step of plan) {
    if (prerequisiteFailed) {
      certificate.steps.push({ id: step.id, lane: step.lane, status: 'SKIP' });
      continue;
    }
    if (step.authorizationEnvironment && process.env[step.authorizationEnvironment] !== '1') {
      certificate.steps.push({
        id: step.id,
        lane: step.lane,
        status: 'BLOCKED',
        reason: `Missing explicit ${step.authorizationEnvironment}=1 authorization.`,
      });
      continue;
    }
    console.log(`[proxy-certification] ${step.id}: ${step.command} ${step.args.join(' ')}`);
    const result = await runStep(step, outputDir, {
      GIAN_ACCEPTANCE_REVISION: git.revision,
    });
    certificate.steps.push(result);
    if (result.status !== 'PASS') prerequisiteFailed = true;
  }

  if (certificate.artifactPublicationEligible) {
    try {
      const runtimeManifestPath = resolve(rootDir, 'artifacts/runtimes/runtime-candidates.json');
      const runtimeManifest = JSON.parse(await readFile(runtimeManifestPath, 'utf8'));
      const binding = await buildArtifactCandidateTuple(certificate, runtimeManifest);
      certificate.candidateTuple = binding.tuples;
      const runtimeBinding = validateRuntimeArtifactTuple(certificate, runtimeManifest);
      certificate.runtimeArtifacts = runtimeBinding.candidates;
      certificate.steps.push({
        id: 'candidate-binding',
        lane: 'certificate',
        status: binding.issues.length === 0 && runtimeBinding.issues.length === 0 ? 'PASS' : 'FAIL',
        issues: [...binding.issues, ...runtimeBinding.issues],
      });
    } catch (error) {
      certificate.steps.push({
        id: 'candidate-binding',
        lane: 'certificate',
        status: 'BLOCKED',
        reason: `Artifact candidate binding unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  certificate.completedAt = new Date().toISOString();
  const hasFailure = certificate.steps.some(step => step.status === 'FAIL');
  const hasBlocked = certificate.steps.some(step => step.status === 'BLOCKED' || step.status === 'SKIP');
  certificate.status = hasFailure ? 'FAIL' : hasBlocked ? 'BLOCKED' : 'PASS';
  certificate.qualified = certificate.artifactPublicationEligible
    && certificate.status === 'PASS'
    && !certificate.dirty
    && runner.environment === 'github-hosted'
    && runner.os === 'macOS'
    && runner.arch === 'ARM64';
  if (certificate.status === 'PASS' && certificate.artifactPublicationEligible && certificate.dirty) {
    certificate.status = 'BLOCKED';
    certificate.blockedReason = 'Release certification requires a clean revision.';
  }
  if (certificate.status === 'PASS'
    && certificate.artifactPublicationEligible
    && (runner.environment !== 'github-hosted' || runner.os !== 'macOS' || runner.arch !== 'ARM64')) {
    certificate.status = 'BLOCKED';
    certificate.blockedReason = 'Artifact publication requires a GitHub-hosted macOS ARM64 runner.';
  }
  const certificatePath = resolve(outputDir, 'certificate.json');
  await writeFile(certificatePath, `${JSON.stringify(certificate, null, 2)}\n`, 'utf8');
  console.log(`[proxy-certification] ${certificate.status}: ${certificatePath}`);
  if (certificate.status !== 'PASS') process.exitCode = 1;
  return certificate;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
