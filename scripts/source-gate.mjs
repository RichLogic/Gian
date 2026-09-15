import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadValidatedCatalog } from './test-catalog.mjs';
import { buildAffectedPlan } from './test-selection.mjs';
import { discoverChangedFiles } from './run-affected-tests.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scopes = ['unit', 'integration', 'system'];
const forbidden = new Set(['electron', 'browser', 'packaged-app', 'real-provider', 'credentials', 'quota', 'network', 'user-visible-os', 'production-data', 'fixed-production-port']);
export function assertHeadlessTests(entries) {
  for (const entry of entries) {
    if (!scopes.includes(entry.scope) || entry.runner === 'playwright'
      || entry.sideEffects?.some(effect => forbidden.has(effect))) {
      throw new Error(`Source gate cannot execute interactive/external test: ${entry.path}`);
    }
  }
}
export function requiresFullSuite(paths) {
  return paths.some(path => /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*|test\/|\.github\/|packages\/(shared|proxy-protocol|proxy-catalog-contract)\/|packages\/host\/migrations\/)/.test(path)
    || /^scripts\/(run-tests|test-catalog|run-affected-tests|test-selection|source-gate|run-verification)/.test(path));
}
export function main(args = process.argv.slice(2)) {
  const [lane, base, mode] = args;
  if (!['policy', ...scopes].includes(lane)) throw new Error('Expected policy/unit/integration/system');
  if (!base) throw new Error('An explicit diff base is required');
  const changed = discoverChangedFiles(base, 'HEAD', root);
  const plan = changed.length ? buildAffectedPlan(changed, 'merge') : { runnableTests: [], checks: [], fallbackFull: false };
  const full = mode === 'full' || plan.fallbackFull || requiresFullSuite(changed);
  const entries = full ? loadValidatedCatalog().entries.filter(entry => scopes.includes(entry.scope)) : plan.runnableTests;
  assertHeadlessTests(entries);
  function run(command, argv) {
    const result = spawnSync(command, argv, { cwd: root, stdio: 'inherit', env: { ...process.env, TRACEABILITY_BASE: base } });
    if (result.error || result.status !== 0) throw result.error ?? new Error(`${command} failed: ${result.status}`);
  }
  if (lane === 'policy') {
    const checks = new Set(['quality:test-catalog', 'quality:test-selection', 'quality:versions', 'quality:operations:strict', 'quality:traceability', ...plan.checks.map(check => check.id)]);
    checks.delete('typecheck');
    for (const check of checks) run('pnpm', [check]);
  } else {
    const selected = entries.filter(entry => entry.scope === lane);
    console.log(`${lane}: ${full ? 'full' : 'affected'}, ${selected.length} files`);
    if (selected.length) run(process.execPath, ['scripts/run-tests.mjs', '--scope', lane, ...selected.flatMap(entry => ['--file', entry.path])]);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
