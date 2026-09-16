import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createRuntimeInstallPlanner,
  runtimeInstallPlanParamsSchema,
  runtimeInstallPlanResultSchema,
} from '../src/runtime-install.js';

const request = {
  installerVersion: 1 as const, runtimeId: 'deepseek-harness', version: '0.1.1-rc.2',
  artifactSha256: 'a'.repeat(64), platform: 'darwin-arm64' as const,
  distribution: { kind: 'managed' as const, format: 'tar.gz' as const, entryRelativePath: 'node_modules/dsh/bin.js' },
};

test('Proxy recipe owns layout and legacy candidates without executable commands', () => {
  const plan = createRuntimeInstallPlanner({
    runtimeId: 'deepseek-harness', kind: 'managed', format: 'tar.gz', entryRelativePath: 'node_modules/dsh/bin.js',
    legacyDirectories: version => [`deepseek-harness/runtimes/deepseek-harness/${version}`],
  })(request);
  assert.equal(plan.operation.kind, 'managed');
  if (plan.operation.kind !== 'managed') return;
  assert.equal(plan.operation.directory, `deepseek-harness/0.1.1-rc.2/${'a'.repeat(64)}`);
  // The flat runtimes/{runtimeId}/{version} layout is the parent of the new
  // content-addressed directory and must not be an automatic reuse candidate.
  assert.deepEqual(plan.operation.candidates, ['deepseek-harness/runtimes/deepseek-harness/0.1.1-rc.2']);
  for (const directory of ['../escape', '/outside', 'a/../b', 'a\\b', 'a//b', 'a:stream']) {
    assert.equal(runtimeInstallPlanResultSchema.safeParse({
      ...plan, operation: { ...plan.operation, directory },
    }).success, false, directory);
  }
  assert.equal(runtimeInstallPlanParamsSchema.safeParse({ ...request, command: 'curl | sh' }).success, false);
  assert.equal(runtimeInstallPlanParamsSchema.safeParse({ ...request, installerVersion: 2 }).success, false);
});

test('recipe refuses a different Runtime identity or uncertified extraction layout', () => {
  const plan = createRuntimeInstallPlanner({ runtimeId: 'claude', kind: 'managed', format: 'raw', entryRelativePath: 'bin/claude' });
  assert.throws(() => plan(request), /does not match/);
  assert.throws(() => plan({ ...request, runtimeId: 'claude' }), /layout/);
});

test('external-App recipe validates in place and never declares a download or migration', () => {
  const input = {
    ...request, runtimeId: 'zcode', version: '0.16.5',
    distribution: { kind: 'external-app' as const, entryPath: '/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs' },
  };
  const result = createRuntimeInstallPlanner({ runtimeId: 'zcode', kind: 'external-app' })(input);
  assert.deepEqual(result.operation, input.distribution);
});
