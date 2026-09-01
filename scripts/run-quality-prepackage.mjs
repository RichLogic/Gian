import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireQualityLock } from './quality-lock.mjs';
import { formatResourceMetrics } from './process-resource-monitor.mjs';
import { runLoggedCommand } from './run-logged-command.mjs';
import { sanitizedTestEnv } from './run-tests.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PREPACKAGE_STEPS = [
  { id: 'versions', label: 'Version and release consistency', args: ['quality:versions'] },
  { id: 'typecheck', label: 'Type check', args: ['typecheck'] },
  { id: 'tests', label: 'Unit, integration, system, and contract tests', args: ['test:all'] },
  { id: 'build', label: 'Production build', args: ['build'] },
  { id: 'traceability', label: 'Traceability registry', args: ['quality:traceability'] },
  { id: 'functional-evidence', label: 'Functional evidence crosswalk', args: ['quality:functional-evidence'] },
  { id: 'docs', label: 'Documentation links', args: ['quality:docs'] },
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
    const resource = result.resources ? `; ${formatResourceMetrics(result.resources)}` : '';
    const suffix = result.duration ? ` (${result.duration}${resource})` : '';
    const reason = result.reason ? `: ${result.reason}` : '';
    lines.push(`[${result.status}] ${result.label}${reason}${suffix}`);
  }
  const passed = results.every(result => result.status !== 'FAIL');
  lines.push('');
  lines.push(passed
    ? 'RESULT: PASS - the source tree is ready to package.'
    : 'RESULT: FAIL - do not package until the failed step is fixed.');
  lines.push('NOTE: the final packaged .app is a separate artifact check.');
  if (logPath) lines.push(`Detailed log: ${logPath}`);
  return lines.join('\n');
}

export function prepackageSkipReason(stepId, options) {
  if (stepId === 'e2e' && options.curatedSource && !options.e2eAvailable) {
    return 'curated public source omits internal e2e specs';
  }
  return null;
}

export async function main() {
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
    const reportPath = join(logDir, `prepackage-${timestamp}.json`);

    mkdirSync(logDir, { recursive: true });
    writeFileSync(logPath, `Gian prepackage quality gate\nRevision: ${revision}\n`);

    console.log('Gian prepackage quality gate');
    console.log(`Revision: ${revision}${dirty ? ' (working tree has changes)' : ''}`);
    const curatedSource = !existsSync(join(rootDir, 'AGENTS.md'));
    const e2eAvailable = existsSync(join(rootDir, 'e2e', 'specs'));

    for (const step of PREPACKAGE_STEPS) {
      if (failed) {
        results.push({ ...step, status: 'SKIP' });
        continue;
      }
      const reason = prepackageSkipReason(step.id, { curatedSource, e2eAvailable });
      if (reason) {
        const skipped = { ...step, status: 'SKIP', reason };
        results.push(skipped);
        console.log(`\n[SKIP] ${step.label}: ${reason}`);
        appendFileSync(logPath, `\n[SKIP] ${step.label}: ${reason}\n`);
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
      const elapsed = duration(startedAt);
      results.push({ ...step, status, duration: elapsed, resources: result.resources });
      console.log(`[${status}] ${step.label} (${elapsed}; ${formatResourceMetrics(result.resources)})`);
      if (result.error) console.error(result.error);
      failed = status === 'FAIL';
    }

    writeFileSync(reportPath, `${JSON.stringify({ revision, results }, null, 2)}\n`);
    console.log(formatPrepackageSummary(results, logPath));
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
