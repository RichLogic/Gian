import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { CommandRuntimeProvider } from '../src/runtime/command-provider.js';
import { CliRuntimeManager } from '../src/runtime/manager.js';

test('command runtime keeps the launcher path and its companion runtime on PATH', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-command-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const launcher = join(root, 'bin', 'codex');
  const script = join(root, 'package', 'codex.js');
  await mkdir(dirname(launcher), { recursive: true });
  await mkdir(dirname(script), { recursive: true });
  await writeFile(script, '#!/usr/bin/env node\nconsole.log("codex-cli 0.146.0");\n');
  await chmod(script, 0o755);
  await symlink(script, launcher);
  await symlink(process.execPath, join(dirname(launcher), 'node'));

  const provider = new CommandRuntimeProvider({
    id: 'codex',
    command: 'codex',
    configuredPath: () => undefined,
    officialPaths: () => [launcher],
    pathEnv: () => '/usr/bin:/bin',
    env: { PATH: '/usr/bin:/bin' },
  });

  const installed = await provider.inspectInstalled();
  assert.equal(installed.length, 1);
  assert.equal(installed[0]?.binaryPath, launcher);

  const runtimeManager = new CliRuntimeManager([provider]);
  const lease = await runtimeManager.acquire('codex');
  assert.equal(lease.binaryPath, launcher);
  assert.equal(lease.version, '0.146.0');
  assert.equal(lease.env.PATH?.split(delimiter)[0], dirname(launcher));
  lease.release();
});
