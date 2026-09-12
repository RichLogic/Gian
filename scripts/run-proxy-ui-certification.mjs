import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { shippingProxyIds } from './build-proxy-artifacts.mjs';

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = 'e2e/specs/12-proxy-v2-mock.spec.ts';

function timestampSlug() {
  return new Date().toISOString().replaceAll(':', '').replaceAll('-', '').replace(/\.\d{3}Z$/, 'Z');
}

export function parseProxyUiOptions(argv = []) {
  const providers = [];
  let output = `output/proxy-certification/ui-${timestampSlug()}`;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--provider') providers.push(argv[++index]);
    else if (arg === '--output') output = argv[++index];
    else throw new Error(`Unknown Proxy UI certification argument ${arg}.`);
  }
  const selected = providers.length === 0 || providers.includes('all')
    ? [...shippingProxyIds]
    : [...new Set(providers)];
  const unknown = selected.filter(provider => !shippingProxyIds.includes(provider));
  if (unknown.length > 0) {
    throw new Error(`Proxy UI certification only accepts shipping Proxies: ${unknown.join(', ')}.`);
  }
  if (!output) throw new Error('--output requires a value.');
  return { output, providers: selected };
}

export function proxyUiPlan(providers) {
  return providers.map(provider => ({
    provider,
    command: process.execPath,
    args: [
      'scripts/run-e2e.mjs',
      '--proxy-mock',
      '--proxy-provider',
      provider,
      spec,
    ],
  }));
}

function runStep(step, outputDir) {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  return new Promise((resolveRun, reject) => {
    const child = spawn(step.command, step.args, {
      cwd: rootDir,
      stdio: 'inherit',
      env: {
        ...process.env,
        PROXY_MOCK_SCREENSHOT_DIR: resolve(outputDir, step.provider, 'screenshots'),
      },
    });
    child.once('error', reject);
    child.once('close', (code, signal) => resolveRun({
      provider: step.provider,
      status: code === 0 ? 'PASS' : 'FAIL',
      exitCode: code,
      signal,
      startedAt,
      completedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
    }));
  });
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseProxyUiOptions(argv);
  const outputDir = resolve(rootDir, options.output);
  await mkdir(outputDir, { recursive: true });
  const report = {
    schemaVersion: 1,
    lane: 'proxy-ui',
    startedAt: new Date().toISOString(),
    shippingProxyIds: [...shippingProxyIds],
    providers: [],
  };
  for (const step of proxyUiPlan(options.providers)) {
    console.log(`[proxy-ui] ${step.provider}: ${step.command} ${step.args.join(' ')}`);
    const result = await runStep(step, outputDir);
    report.providers.push(result);
    if (result.status !== 'PASS') break;
  }
  report.completedAt = new Date().toISOString();
  report.status = report.providers.length === options.providers.length
    && report.providers.every(result => result.status === 'PASS')
    ? 'PASS'
    : 'FAIL';
  await writeFile(resolve(outputDir, 'results.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[proxy-ui] ${report.status}: ${outputDir}`);
  if (report.status !== 'PASS') process.exitCode = 1;
  return report;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
