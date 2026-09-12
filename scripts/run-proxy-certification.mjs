import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { proxyDefinitions, shippingProxyIds } from './build-proxy-artifacts.mjs';
import {
  loadProxyRealAcceptanceCatalog,
  validateProxyRealAcceptanceCatalog,
} from './proxy-real-acceptance-catalog.mjs';

const execFileAsync = promisify(execFile);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stages = new Set(['development', 'nightly', 'release']);
const realTurnAuthorization = 'GIAN_ALLOW_REAL_AGENT_TURN';
const previewAuthorization = 'GIAN_ALLOW_ELECTRON_PREVIEW';
const packageAuthorization = 'GIAN_ALLOW_PACKAGE';

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
    throw new Error('--stage must be development, nightly, or release.');
  }
  if ((options.stage === 'development' || options.stage === 'release') && !options.base) {
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
    options.stage === 'release'
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
  steps.push(pnpmStep(
    'package',
    'package',
    ['quality:package'],
    { authorizationEnvironment: packageAuthorization },
  ));
  steps.push(nodeStep(
    'real-provider',
    'real-provider',
    [
      'scripts/run-proxy-real-acceptance.mjs',
      ...options.providers.flatMap(provider => ['--provider', provider]),
      '--output',
      resolve(options.output, 'real-provider'),
      '--artifact-dir',
      resolve('artifacts/proxies'),
    ],
    { authorizationEnvironment: realTurnAuthorization },
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

export function validateCandidateTuple(certificate, run) {
  const issues = [];
  if (run.revision !== certificate.revision) {
    issues.push(`real Provider evidence revision ${run.revision} != ${certificate.revision}`);
  }
  const completedAt = Date.parse(run.completedAt ?? '');
  const maxAgeMs = certificate.realEvidenceMaxAgeHours * 60 * 60 * 1_000;
  const ageMs = Date.now() - completedAt;
  if (!Number.isFinite(completedAt) || ageMs < 0 || ageMs > maxAgeMs) {
    issues.push(`real Provider evidence is missing, future-dated, or older than ${certificate.realEvidenceMaxAgeHours}h`);
  }
  const tuples = Array.isArray(run.candidateTuple) ? run.candidateTuple : [];
  const byProvider = new Map(tuples.map(tuple => [tuple.provider, tuple]));
  for (const expected of certificate.candidatePackages) {
    const tuple = byProvider.get(expected.provider);
    if (!tuple) {
      issues.push(`${expected.provider} has no candidate tuple`);
      continue;
    }
    if (tuple.proxy?.source !== 'packaged-artifact') {
      issues.push(`${expected.provider} real evidence did not use a packaged Proxy artifact`);
    }
    if (tuple.proxy?.proxyVersion !== expected.proxyVersion) {
      issues.push(`${expected.provider} Proxy version does not match ${expected.proxyVersion}`);
    }
    if (!/^[a-f0-9]{64}$/u.test(tuple.proxy?.sha256 ?? '')) {
      issues.push(`${expected.provider} Proxy artifact has no valid SHA-256`);
    }
    if (tuple.cli?.verified !== true
      || !expected.runtime.verifiedCliVersions.includes(tuple.cli?.version)) {
      issues.push(`${expected.provider} CLI ${String(tuple.cli?.version)} is not verified by this candidate`);
    }
    if (!/^[a-f0-9]{64}$/u.test(tuple.cli?.sha256 ?? '')
      || !Number.isSafeInteger(tuple.cli?.size)
      || tuple.cli.size <= 0) {
      issues.push(`${expected.provider} CLI candidate has no exact artifact identity`);
    }
  }
  return { tuples, issues };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseProxyCertificationOptions(argv);
  const catalog = validateProxyRealAcceptanceCatalog(await loadProxyRealAcceptanceCatalog());
  const plan = proxyCertificationPlan(options);
  if (options.plan) {
    console.log(JSON.stringify({
      stage: options.stage,
      admissionEligible: options.stage === 'release',
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
  const certificate = {
    schemaVersion: 1,
    certificateId: `release-${git.revision}`,
    stage: options.stage,
    admissionEligible: options.stage === 'release',
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
    realEvidenceMaxAgeHours: catalog.certification.realEvidenceMaxAgeHours,
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

  if (certificate.admissionEligible) {
    try {
      const realEvidencePath = resolve(outputDir, 'real-provider', 'results.json');
      const realRun = JSON.parse(await readFile(realEvidencePath, 'utf8'));
      const binding = validateCandidateTuple(certificate, realRun);
      certificate.candidateTuple = binding.tuples;
      certificate.realProviderEvidence = {
        path: realEvidencePath,
        startedAt: realRun.startedAt,
        completedAt: realRun.completedAt,
      };
      certificate.steps.push({
        id: 'candidate-binding',
        lane: 'certificate',
        status: binding.issues.length === 0 ? 'PASS' : 'FAIL',
        issues: binding.issues,
      });
    } catch (error) {
      certificate.steps.push({
        id: 'candidate-binding',
        lane: 'certificate',
        status: 'BLOCKED',
        reason: `Candidate tuple evidence unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  certificate.completedAt = new Date().toISOString();
  const hasFailure = certificate.steps.some(step => step.status === 'FAIL');
  const hasBlocked = certificate.steps.some(step => step.status === 'BLOCKED' || step.status === 'SKIP');
  certificate.status = hasFailure ? 'FAIL' : hasBlocked ? 'BLOCKED' : 'PASS';
  certificate.qualified = certificate.admissionEligible
    && certificate.status === 'PASS'
    && !certificate.dirty;
  if (certificate.status === 'PASS' && certificate.admissionEligible && certificate.dirty) {
    certificate.status = 'BLOCKED';
    certificate.blockedReason = 'Release certification requires a clean revision.';
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
