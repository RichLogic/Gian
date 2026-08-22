import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAffectedPlan,
  checkSelectionMap,
  loadSelectionInputs,
  matchesSelectionPattern,
  validateSelectionMap,
} from './test-selection.mjs';

const inputs = loadSelectionInputs();

test('selection map is structurally valid and has no stale mappings', () => {
  assert.doesNotThrow(() => checkSelectionMap());
});

test('selection map permits explicitly optional curated-source patterns to be absent', () => {
  const rule = {
    id: 'curated-docs',
    patterns: ['README.md', 'docs/**/*.md'],
    optionalPatterns: ['docs/**/*.md'],
    modules: [],
    scopes: [],
    checks: [],
    reason: 'Internal documentation is omitted from the curated source repository.',
  };
  const map = {
    version: 1,
    stages: {
      quick: { runScopes: ['unit'] },
      merge: { runScopes: ['unit', 'system'] },
    },
    rules: [rule],
  };
  assert.doesNotThrow(() => validateSelectionMap(map, {
    entries: [],
    packageScripts: {},
    specialEntrypoints: [],
    repositoryPaths: ['README.md'],
  }));
});

test('selection glob supports package trees and root-only wildcards', () => {
  assert.equal(matchesSelectionPattern('docs/quality/a.md', 'docs/**/*.md'), true);
  assert.equal(matchesSelectionPattern('docs/a.md', 'docs/**/*.md'), true);
  assert.equal(matchesSelectionPattern('packages/host/src/index.ts', 'packages/host/**'), true);
  assert.equal(matchesSelectionPattern('docs/quality/a.txt', 'docs/**/*.md'), false);
});

test('a directly changed deterministic test selects only itself', () => {
  const path = 'packages/host/test/auth.test.ts';
  const plan = buildAffectedPlan([path], 'quick', inputs);
  assert.deepEqual(plan.runnableTests.map(entry => entry.path), [path]);
  assert.equal(plan.deferredTests.length, 0);
});

test('shared contract changes expand to dependent modules and defer System in quick', () => {
  const plan = buildAffectedPlan(['packages/shared/src/model.ts'], 'quick', inputs);
  const runnableModules = new Set(plan.runnableTests.map(entry => entry.module));
  assert.equal(runnableModules.has('shared'), true);
  assert.equal(runnableModules.has('host'), true);
  assert.equal(runnableModules.has('web'), true);
  assert.equal(runnableModules.has('cc-proxy'), true);
  assert.equal(plan.deferredTests.length > 0, true);
  assert.equal(plan.deferredTests.every(entry => entry.scope === 'system'), true);
});

test('step/request protocol changes select Trace Host/Web evidence and defer System in quick', () => {
  const plan = buildAffectedPlan(['packages/proxy-protocol/src/schemas.ts'], 'quick', inputs);
  const paths = new Set(plan.runnableTests.map(entry => entry.path));
  assert.equal(paths.has('packages/host/test/trace-step-request.test.ts'), true);
  assert.equal(paths.has('packages/web/test/trace-step-request.test.tsx'), true);
  assert.equal(plan.deferredTests.some(entry => entry.scope === 'system'), true);
  assert.equal(plan.checks.some(check => check.id === 'quality:operations:strict'), true);
});

test('migration changes require Host System and packaged smoke without running either in quick', () => {
  const plan = buildAffectedPlan(['packages/host/migrations/043_session_pinned.sql'], 'quick', inputs);
  assert.equal(plan.deferredTests.some(entry => entry.module === 'host' && entry.scope === 'system'), true);
  assert.equal(plan.deferredEntrypoints.some(entry => entry.id === 'packaged-app-smoke'), true);
  assert.equal(plan.runnableTests.some(entry => entry.module === 'host' && entry.scope === 'integration'), true);
});

test('Desktop changes report the Electron smoke as a deferred entrypoint', () => {
  const plan = buildAffectedPlan(['packages/desktop/src/main.ts'], 'quick', inputs);
  assert.equal(plan.deferredEntrypoints.some(entry => entry.id === 'desktop-electron-smoke'), true);
});

test('merge stage executes selected System tests', () => {
  const plan = buildAffectedPlan(['packages/host/src/workspace/git.ts'], 'merge', inputs);
  assert.equal(plan.runnableTests.some(entry => entry.scope === 'system'), true);
  assert.equal(plan.deferredTests.length, 0);
});

test('documentation-only changes select quality checks without product tests', () => {
  const plan = buildAffectedPlan(['docs/quality/test-selection-plan.md'], 'quick', inputs);
  assert.equal(plan.runnableTests.length, 0);
  assert.deepEqual(plan.checks.map(check => check.id), ['quality:traceability', 'quality:docs']);
});

test('Web changes include the strict UI operation gate', () => {
  const plan = buildAffectedPlan(['packages/web/src/App.tsx'], 'quick', inputs);
  assert.equal(plan.checks.some(check => check.id === 'quality:operations:strict'), true);
});

test('unknown paths fail closed to every deterministic catalog entry', () => {
  const plan = buildAffectedPlan(['unmapped/new-boundary.conf'], 'quick', inputs);
  const deterministicCount = inputs.entries.filter(entry => entry.scope !== 'e2e').length;
  assert.equal(plan.fallbackFull, true);
  assert.equal(plan.runnableTests.length + plan.deferredTests.length, deterministicCount);
  assert.equal(plan.checks.some(check => check.id === 'quality:test-catalog'), true);
});

test('a directly changed E2E spec is reported or safely falls back when curated out', () => {
  const path = 'e2e/specs/01-app-loads.spec.ts';
  const plan = buildAffectedPlan([path], 'quick', inputs);
  if (!inputs.entries.some(entry => entry.path === path)) {
    assert.equal(plan.fallbackFull, true);
    assert.equal(plan.deferredEntrypoints.length, 0);
    assert.equal(plan.runnableTests.length > 0, true);
    return;
  }
  assert.equal(plan.runnableTests.length, 0);
  assert.equal(plan.deferredEntrypoints[0].id, 'test:e2e');
});
