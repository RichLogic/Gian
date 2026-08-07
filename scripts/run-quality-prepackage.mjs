import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireQualityLock } from './quality-lock.mjs';
import { sanitizedTestEnv } from './run-tests.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PREPACKAGE_STEPS = [
  { id: 'typecheck', label: 'Type check', args: ['typecheck'] },
  { id: 'tests', label: 'Unit, integration, and contract tests', args: ['test'] },
  { id: 'build', label: 'Production build', args: ['build'] },
  { id: 'traceability', label: 'Traceability registry', args: ['quality:traceability'] },
  { id: 'e2e', label: 'Isolated browser journeys', args: ['test:e2e:run'] },
  {
    id: 'desktop',
    label: 'Isolated Electron shell smoke',
    args: ['--filter', '@gian/desktop', 'test:smoke:run'],
  },
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

function gitValue(args) {
  const result = spawnSync('git', args, {
    cwd: rootDir,
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : 'unknown';
}

function duration(startedAt) {
  return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

export function formatPrepackageSummary(results, logPath) {
  const lines = ['', 'Prepackage quality summary'];
  for (const result of results) {
    const suffix = result.duration ? ` (${result.duration})` : '';
    lines.push(`[${result.status}] ${result.label}${suffix}`);
  }
  const passed = results.every(result => result.status === 'PASS');
  lines.push('');
  lines.push(passed
    ? 'RESULT: PASS - the source tree is ready to package.'
    : 'RESULT: FAIL - do not package until the failed step is fixed.');
  lines.push('NOTE: the final packaged .app is a separate artifact check.');
  if (logPath) lines.push(`Detailed log: ${logPath}`);
  return lines.join('\n');
}

export function main() {
  const lock = acquireQualityLock({ command: 'quality:prepackage', rootDir });
  try {
    const env = sanitizedTestEnv();
    delete env.FORCE_COLOR;
    env.NO_COLOR = '1';
    const revision = gitValue(['rev-parse', '--short', 'HEAD']);
    const dirty = gitValue(['status', '--porcelain']) !== '';
    const results = [];
    let failed = false;
    const logDir = join(rootDir, 'output', 'quality');
    const timestamp = new Date().toISOString().replaceAll(':', '-');
    const logPath = join(logDir, `prepackage-${timestamp}.log`);

    mkdirSync(logDir, { recursive: true });
    writeFileSync(logPath, `Gian prepackage quality gate\nRevision: ${revision}\n`);

    console.log('Gian prepackage quality gate');
    console.log(`Revision: ${revision}${dirty ? ' (working tree has changes)' : ''}`);

    for (const step of PREPACKAGE_STEPS) {
      if (failed) {
        results.push({ ...step, status: 'SKIP' });
        continue;
      }

      console.log(`\n==> ${step.label}`);
      const startedAt = Date.now();
      const command = pnpmInvocation(step.args);
      const result = spawnSync(command.command, command.args, {
        cwd: rootDir,
        env,
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024,
      });
      const status = !result.error && result.status === 0 ? 'PASS' : 'FAIL';
      const elapsed = duration(startedAt);
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      appendFileSync(logPath, `\n==> ${step.label}\n${output}`);
      results.push({ ...step, status, duration: elapsed });
      console.log(`[${status}] ${step.label} (${elapsed})`);
      if (result.error) console.error(result.error);
      if (status === 'FAIL' && output) {
        console.error('\nLast output from the failed step:');
        console.error(output.trimEnd().split('\n').slice(-40).join('\n'));
      }
      failed = status === 'FAIL';
    }

    console.log(formatPrepackageSummary(results, logPath));
    return failed ? 1 : 0;
  } finally {
    lock.release();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = main();
}
