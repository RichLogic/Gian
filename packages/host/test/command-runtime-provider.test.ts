import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import test from 'node:test';
import { CommandRuntimeProvider } from '../src/runtime/command-provider.js';
import { DshRuntimeProvider } from '../src/runtime/dsh-provider.js';
import { CliRuntimeManager } from '../src/runtime/manager.js';

test('managed DSH keeps its npm launcher and finds the Host Node runtime', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'gian-dsh-provider-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });

  const runtimesRoot = join(directory, 'runtimes');
  const version = '9.8.7';
  const packageBin = join(
    runtimesRoot,
    version,
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
  const versionBin = join(runtimesRoot, version, 'node_modules', '.bin');
  const launcher = join(runtimesRoot, 'current', 'node_modules', '.bin', 'dsh');
  await mkdir(dirname(packageBin), { recursive: true });
  await mkdir(versionBin, { recursive: true });
  await writeFile(
    packageBin,
    '#!/usr/bin/env node\nprocess.stdout.write("9.8.7\\n");\n',
    'utf8',
  );
  await chmod(packageBin, 0o755);
  await symlink('../@deepseek-ai/dsh/lib/bin.js', join(versionBin, 'dsh'));
  await symlink(version, join(runtimesRoot, 'current'), 'dir');

  const provider = new DshRuntimeProvider({
    dataDir: directory,
    runtimesRoot,
    // Reproduce a Finder-launched packaged App: no Node directory is
    // contributed by the inherited discovery PATH.
    pathEnv: '/usr/bin:/bin',
  });
  const installed = await provider.inspectInstalled();

  assert.equal(installed.length, 1);
  assert.equal(installed[0]?.binaryPath, launcher);
  assert.equal(installed[0]?.source, 'managed');
  assert.equal(provider.managedEnv().PATH?.split(delimiter)[0], dirname(process.execPath));

  const probe = await provider.probe(installed[0]!);
  assert.equal(probe.version, version);
  assert.equal(probe.binaryPath, launcher);
});

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

  const runtimeManager = new CliRuntimeManager([provider], root);
  const lease = await runtimeManager.acquire('codex');
  assert.equal(lease.binaryPath, launcher);
  assert.equal(lease.version, '0.146.0');
  assert.equal(lease.env.PATH?.split(delimiter)[0], dirname(launcher));
  await lease.release();
});

test('active command runtime detects launcher and companion content changes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-command-runtime-snapshot-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const bin = join(root, 'bin');
  const launcher = join(bin, 'codex');
  const script = join(root, 'package', 'codex.js');
  const companion = join(bin, 'node');
  await mkdir(bin, { recursive: true });
  await mkdir(dirname(script), { recursive: true });
  await writeFile(script, '#!/bin/sh\nprintf "codex 1.0.0\\n"\n');
  await chmod(script, 0o755);
  await symlink(script, launcher);
  await writeFile(companion, 'node-runtime-v1');

  const provider = new CommandRuntimeProvider({
    id: 'codex',
    command: 'codex',
    configuredPath: () => launcher,
    officialPaths: () => [],
    pathEnv: () => '',
  });
  const runtimes = new CliRuntimeManager([provider], root);
  const lease = await runtimes.acquire('codex');
  assert.deepEqual(await runtimes.detectExternalChanges(), []);

  await writeFile(companion, 'node-runtime-v2');
  assert.deepEqual(await runtimes.detectExternalChanges(), ['codex']);
  await lease.release();
});
