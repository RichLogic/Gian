import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireQualityLock, QUALITY_LOCK_ENV } from './quality-lock.mjs';
import { formatResourceMetrics } from './process-resource-monitor.mjs';
import { runLoggedCommand } from './run-logged-command.mjs';
import { sanitizedTestEnv } from './run-tests.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const steps = [
  { label: 'Source prepackage gate', args: ['quality:prepackage'] },
  { label: 'Unsigned macOS app package', args: ['desktop:pack'] },
  { label: 'Packaged app resources and lifecycle', args: ['quality:package:smoke'] },
];

function pnpmInvocation(args) {
  const pnpmEntry = process.env.npm_execpath;
  return pnpmEntry
    ? { command: process.execPath, args: [pnpmEntry, ...args] }
    : {
        command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
        args,
      };
}

function elapsed(startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

export function packageQualityEnvironment(source = process.env) {
  const env = sanitizedTestEnv(source);
  const githubClientId = source.GIAN_GITHUB_CLIENT_ID?.trim();
  if (githubClientId) env.GIAN_GITHUB_CLIENT_ID = githubClientId;
  const packagedSmokeGithubToken = source.GIAN_PACKAGED_SMOKE_GITHUB_TOKEN?.trim();
  if (packagedSmokeGithubToken) {
    env.GIAN_PACKAGED_SMOKE_GITHUB_TOKEN = packagedSmokeGithubToken;
  }
  delete env.FORCE_COLOR;
  env.NO_COLOR = '1';
  return env;
}

export async function main() {
  const lock = acquireQualityLock({ command: 'quality:package', rootDir });
  try {
    const env = packageQualityEnvironment();
    env[QUALITY_LOCK_ENV] = lock.token;

    const logDir = join(rootDir, 'output', 'quality');
    const timestamp = new Date().toISOString().replaceAll(':', '-');
    const logPath = join(logDir, `package-${timestamp}.log`);
    const reportPath = join(logDir, `package-${timestamp}.json`);
    const results = [];
    let failed = false;

    mkdirSync(logDir, { recursive: true });
    writeFileSync(logPath, 'Gian local package quality gate\n');
    console.log('Gian local package quality gate');

    for (const step of steps) {
      if (failed) {
        results.push({ ...step, status: 'SKIP' });
        continue;
      }

      console.log(`\n==> ${step.label}`);
      const startedAt = Date.now();
      const command = pnpmInvocation(step.args);
      appendFileSync(logPath, `\n==> ${step.label}\n`);
      const result = await runLoggedCommand(command.command, command.args, {
        collectResources: true,
        cwd: rootDir,
        env,
        logPath,
      });
      const status = !result.error && result.status === 0 ? 'PASS' : 'FAIL';
      const duration = elapsed(startedAt);
      results.push({ ...step, status, duration, resources: result.resources });
      console.log(`[${status}] ${step.label} (${duration}; ${formatResourceMetrics(result.resources)})`);
      if (result.error) console.error(result.error);
      failed = status === 'FAIL';
    }

    console.log('\nLocal package quality summary');
    for (const result of results) {
      const resource = result.resources ? `; ${formatResourceMetrics(result.resources)}` : '';
      console.log(`[${result.status}] ${result.label}${result.duration ? ` (${result.duration}${resource})` : ''}`);
    }
    console.log(failed
      ? '\nRESULT: FAIL - do not keep or distribute this package.'
      : '\nRESULT: PASS - the local .app package passed its artifact smoke.');
    console.log('NOTE: this command does not sign/notarize or run real Agent canaries.');
    console.log(`Detailed log: ${logPath}`);
    writeFileSync(reportPath, `${JSON.stringify({ results }, null, 2)}\n`);
    console.log(`Resource report: ${reportPath}`);
    return failed ? 1 : 0;
  } finally {
    lock.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
