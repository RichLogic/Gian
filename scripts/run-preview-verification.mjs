import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatResourceMetrics } from './process-resource-monitor.mjs';
import { acquireQualityLock, QUALITY_LOCK_ENV } from './quality-lock.mjs';
import { runLoggedCommand } from './run-logged-command.mjs';
import { sanitizedTestEnv } from './run-tests.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export function parsePreviewOptions(argv) {
  let base;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') continue;
    if (arg === '--base') {
      base = argv[index + 1];
      if (!base) throw new Error('--base requires a value');
      index += 1;
    } else {
      throw new Error(`unknown preview argument: ${arg}`);
    }
  }
  if (!base) throw new Error('verify:preview requires --base <revision>');
  return { base };
}

export function previewSteps(base) {
  return [
    { id: 'affected', label: 'Affected quick regression', args: ['verify:quick', '--', '--base', base] },
    { id: 'build', label: 'Production build', args: ['build'] },
    {
      id: 'web-smoke',
      label: 'Isolated app-shell browser smoke',
      args: ['test:e2e:run', '--', 'e2e/specs/01-app-loads.spec.ts'],
    },
    {
      id: 'desktop-smoke',
      label: 'Isolated Electron shell smoke',
      args: ['--filter', '@gian/desktop', 'test:smoke:run'],
    },
  ];
}

function pnpmInvocation(args) {
  const pnpmEntry = process.env.npm_execpath;
  return pnpmEntry
    ? { command: process.execPath, args: [pnpmEntry, ...args] }
    : { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args };
}

export function formatPreviewSummary(results, logPath) {
  const lines = ['', 'Preview verification summary'];
  for (const result of results) {
    const detail = result.duration ? ` (${result.duration}; ${formatResourceMetrics(result.resources)})` : '';
    lines.push(`[${result.status}] ${result.label}${detail}`);
  }
  lines.push('');
  lines.push(results.every(result => result.status === 'PASS')
    ? 'RESULT: PASS - the branch is ready for GianDev Desktop preview.'
    : 'RESULT: FAIL - do not use this branch for Desktop acceptance.');
  lines.push('NOTE: preview does not replace test:all, full E2E, packaged smoke, or real Provider canaries.');
  if (logPath) lines.push(`Detailed log: ${logPath}`);
  return lines.join('\n');
}

export async function main(argv = process.argv.slice(2)) {
  const { base } = parsePreviewOptions(argv);
  const lock = acquireQualityLock({ command: 'verify:preview', rootDir });
  try {
    const env = sanitizedTestEnv();
    env[QUALITY_LOCK_ENV] = lock.token;
    delete env.FORCE_COLOR;
    env.NO_COLOR = '1';
    const logDir = join(rootDir, 'output', 'quality');
    const timestamp = new Date().toISOString().replaceAll(':', '-');
    const logPath = join(logDir, `preview-${timestamp}.log`);
    const reportPath = join(logDir, `preview-${timestamp}.json`);
    const results = [];
    let failed = false;

    mkdirSync(logDir, { recursive: true });
    writeFileSync(logPath, `Gian preview verification\nBase: ${base}\n`);
    console.log(`Gian preview verification (base ${base})`);

    for (const step of previewSteps(base)) {
      if (failed) {
        results.push({ ...step, status: 'SKIP' });
        continue;
      }
      console.log(`\n==> ${step.label}`);
      appendFileSync(logPath, `\n==> ${step.label}\n`);
      const startedAt = Date.now();
      const command = pnpmInvocation(step.args);
      const result = await runLoggedCommand(command.command, command.args, {
        collectResources: true,
        cwd: rootDir,
        env,
        logPath,
      });
      const status = !result.error && result.status === 0 ? 'PASS' : 'FAIL';
      const duration = `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
      results.push({ ...step, status, duration, resources: result.resources });
      console.log(`[${status}] ${step.label} (${duration}; ${formatResourceMetrics(result.resources)})`);
      if (result.error) console.error(result.error);
      failed = status === 'FAIL';
    }

    writeFileSync(reportPath, `${JSON.stringify({ base, results }, null, 2)}\n`);
    console.log(formatPreviewSummary(results, logPath));
    console.log(`Resource report: ${reportPath}`);
    return failed ? 1 : 0;
  } finally {
    lock.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
