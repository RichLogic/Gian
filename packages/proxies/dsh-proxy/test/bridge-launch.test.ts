import assert from 'node:assert/strict';
import test from 'node:test';

import { parseArgs } from '../src/cli/bridge-launch.js';

const ENV_KEYS = [
  'GIAN_DSH_HOST_ARGS',
  'GIAN_DSH_HOST_ENTRY',
  'GIAN_RUNTIME_BIN',
  'DSH_HOST_ENTRY',
] as const;

function withEnv(
  env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  run: () => void,
): void {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, env);
  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('a .js bridge command is spawned via process.execPath with --expose-internals', () => {
  withEnv({ GIAN_RUNTIME_BIN: '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js' }, () => {
    const launch = parseArgs([]);
    assert.equal(launch.bridgeCommand, process.execPath);
    assert.deepEqual(launch.args.slice(0, 2), [
      '--expose-internals',
      '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ]);
  });
});

test('a non-.js bridge command keeps the direct spawn behavior', () => {
  withEnv({ GIAN_DSH_HOST_ENTRY: '/usr/local/bin/dsh-host' }, () => {
    const launch = parseArgs([]);
    assert.equal(launch.bridgeCommand, '/usr/local/bin/dsh-host');
    assert.deepEqual(launch.args, ['--profile', 'gian']);
  });
});

test('--profile gian injection is unchanged for a .js bridge command', () => {
  withEnv({ GIAN_RUNTIME_BIN: '/opt/dsh/lib/bin.js' }, () => {
    const launch = parseArgs([]);
    assert.deepEqual(launch.args.slice(2), ['--profile', 'gian']);
  });
});

test('an explicit --bridge= .js override is wrapped and skips --profile injection', () => {
  withEnv({}, () => {
    const launch = parseArgs(['--bridge=/tmp/fake-bridge.js', '--verbose', 'extra']);
    assert.equal(launch.bridgeCommand, process.execPath);
    assert.deepEqual(launch.args, ['--expose-internals', '/tmp/fake-bridge.js', 'extra']);
  });
});

test('GIAN_DSH_HOST_ENTRY wins over --bridge= and keeps direct spawn for binaries', () => {
  withEnv({ GIAN_DSH_HOST_ENTRY: '/usr/local/bin/dsh-host' }, () => {
    const launch = parseArgs(['--bridge=/tmp/fake-bridge.js', 'extra']);
    assert.equal(launch.bridgeCommand, '/usr/local/bin/dsh-host');
    assert.deepEqual(launch.args, ['extra']);
  });
});

test('GIAN_DSH_HOST_ARGS replaces the derived args but keeps the Node wrapper', () => {
  withEnv({
    GIAN_RUNTIME_BIN: '/opt/dsh/lib/bin.js',
    GIAN_DSH_HOST_ARGS: JSON.stringify(['--profile', 'custom', '--flag']),
  }, () => {
    const launch = parseArgs(['positional']);
    assert.equal(launch.bridgeCommand, process.execPath);
    assert.deepEqual(launch.args, [
      '--expose-internals',
      '/opt/dsh/lib/bin.js',
      '--profile',
      'custom',
      '--flag',
    ]);
  });
});

test('GIAN_DSH_HOST_ARGS rejects non-string-array JSON', () => {
  withEnv({
    GIAN_DSH_HOST_ENTRY: '/usr/local/bin/dsh-host',
    GIAN_DSH_HOST_ARGS: JSON.stringify({ profile: 'gian' }),
  }, () => {
    assert.throws(() => parseArgs([]), /GIAN_DSH_HOST_ARGS must be a JSON array of strings\./);
  });
});

test('parseArgs throws when no bridge command is configured', () => {
  withEnv({}, () => {
    assert.throws(() => parseArgs([]), /requires GIAN_DSH_HOST_ENTRY/);
  });
});
