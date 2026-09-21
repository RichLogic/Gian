import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { PROTOCOL_NAME, PROTOCOL_V22, type RuntimeInstallPlanResult } from '@gian/proxy-protocol';
import { parseProxyPluginId } from '@gian/shared';

import { ProtocolV2Client } from '../src/proxy/protocol-v2-client.js';
import { RuntimeResolver } from '../src/runtime/resolver.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const OFFICIAL = [
  {
    name: 'claude',
    pluginId: 'claude',
    packageDir: 'cc-proxy',
    processScope: 'session' as const,
    command: 'claude',
    version: '2.1.159',
    runtimeId: 'claude',
    displayName: 'Claude Code',
  },
  {
    name: 'codex',
    pluginId: 'codex',
    packageDir: 'codex-proxy',
    processScope: 'shared' as const,
    command: 'codex',
    version: '0.146.0',
    runtimeId: 'codex',
    displayName: 'Codex CLI',
  },
  {
    name: 'kimi',
    pluginId: 'kimi',
    packageDir: 'kimi-proxy',
    processScope: 'shared' as const,
    command: 'kimi',
    version: '0.38.0',
    runtimeId: 'kimi',
    displayName: 'Kimi Code',
  },
  {
    name: 'grok',
    pluginId: 'grok',
    packageDir: 'grok-proxy',
    processScope: 'session' as const,
    command: 'grok',
    version: '1.0.4',
    runtimeId: 'grok',
    displayName: 'Grok CLI',
  },
  {
    name: 'dsh',
    pluginId: 'ai.deepseek.harness',
    packageDir: 'dsh-proxy',
    processScope: 'shared' as const,
    command: 'dsh',
    version: '0.1.1-rc.2',
    runtimeId: 'deepseek-harness',
    displayName: 'DeepSeek Harness',
  },
  {
    name: 'zcode',
    pluginId: 'com.zhipu.zcode',
    packageDir: 'zcode-proxy',
    processScope: 'shared' as const,
    command: 'zcode',
    version: '0.16.5',
    runtimeId: 'zcode',
    displayName: 'ZCode Runtime',
  },
] as const;

async function writeExecutable(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, source, { mode: 0o755 });
  await chmod(path, 0o755);
}

async function writeZcodeBuiltinConfig(entry: string): Promise<void> {
  // A usable standalone fixture needs the provider config next to its entry.
  // Keep this separate from the user's ~/.zcode/cli/config.json so tests can
  // independently exercise bootstrap readiness and missing user configuration.
  const provider = join(dirname(entry), 'provider');
  await mkdir(provider, { recursive: true });
  await writeFile(join(provider, 'zcode-builtin.json'), '{}\n');
}

async function pluginVersion(packageDir: string): Promise<string> {
  const pkg = JSON.parse(
    await readFile(join(repoRoot, 'packages', 'proxies', packageDir, 'package.json'), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

function listChildren(pid: number): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const child = spawn('ps', ['-axo', 'pid=,ppid='], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        resolve([]);
        return;
      }
      const pids: number[] = [];
      for (const line of stdout.split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(\d+)$/);
        if (match && Number(match[2]) === pid) pids.push(Number(match[1]));
      }
      resolve(pids);
    });
  });
}

function isolatedEnv(root: string, pathValue: string): Record<string, string> {
  return {
    HOME: root,
    PATH: pathValue,
    KIMI_CODE_HOME: join(root, '.kimi-code'),
  };
}

test('official spawn.js bootstraps 2.2 without Runtime and without vendor children', { timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-official-entry-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });

  const bins = join(root, '.local', 'bin');
  await mkdir(bins, { recursive: true });
  for (const item of OFFICIAL) {
    if (item.name === 'zcode') continue;
    await writeExecutable(join(bins, item.command), `#!/bin/sh\necho ${item.command} ${item.version}\n`);
  }
  const zcode = join(root, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs');
  await writeExecutable(zcode, '#!/usr/bin/env node\nconsole.log("zcode 0.16.5");\n');
  await writeZcodeBuiltinConfig(zcode);
  await mkdir(join(root, '.zcode', 'cli'), { recursive: true });
  await writeFile(join(root, '.zcode', 'cli', 'config.json'), '{"ok":true}\n');
  await mkdir(join(root, '.kimi-code', 'bin'), { recursive: true });
  await writeExecutable(join(root, '.kimi-code', 'bin', 'kimi'), '#!/bin/sh\necho kimi 0.38.0\n');

  for (const item of OFFICIAL) {
    const entry = join(repoRoot, 'packages', 'proxies', item.packageDir, 'dist', 'src', 'cli', 'spawn.js');
    const version = await pluginVersion(item.packageDir);
    const dataDir = join(root, 'data', item.name);
    await mkdir(dataDir, { recursive: true });
    const client = new ProtocolV2Client({
      entry,
      pluginId: item.pluginId,
      pluginVersion: version,
      processScope: item.processScope,
      dataDir,
      hostVersion: '0.1.0',
      protocolVersions: [PROTOCOL_V22],
      runtimeBootstrap: true,
      env: isolatedEnv(root, bins),
    });
    t.after(() => client.shutdown().catch(() => client.forceKill()));
    const initialized = await client.initialize();
    assert.equal(initialized.protocol.name, PROTOCOL_NAME);
    assert.equal(initialized.protocol.version, PROTOCOL_V22);
    assert.equal(initialized.capabilities['runtime.discover'], 1);
    assert.equal(initialized.capabilities['runtime.probe'], 1);
    assert.equal(initialized.capabilities['runtime.install.plan'], 1);
    const layouts: Record<string, { format: 'raw' | 'tar.gz'; entryRelativePath: string }> = {
      claude: { format: 'raw', entryRelativePath: 'bin/claude' },
      codex: { format: 'tar.gz', entryRelativePath: 'bin/codex' },
      kimi: { format: 'tar.gz', entryRelativePath: 'kimi' },
      dsh: { format: 'tar.gz', entryRelativePath: 'node_modules/@deepseek-ai/dsh/lib/bin.js' },
      grok: { format: 'raw', entryRelativePath: 'bin/grok' },
    };
    const recipe = await client.request<RuntimeInstallPlanResult>('runtime.install.plan', {
      installerVersion: 1, runtimeId: item.runtimeId, version: item.version,
      artifactSha256: 'a'.repeat(64), platform: 'darwin-arm64',
      distribution: item.name === 'zcode'
        ? { kind: 'external-app', entryPath: zcode }
        : { kind: 'managed', ...layouts[item.name] },
    });
    assert.equal(recipe.runtimeId, item.runtimeId);
    assert.equal(recipe.version, item.version);
    assert.equal(recipe.operation.kind, item.name === 'zcode' ? 'external-app' : 'managed');
    const discovered = await client.request<{
      candidates: Array<{ path: string }>;
    }>('runtime.discover', {});
    assert.ok(discovered.candidates.length > 0, `${item.name} discovered no candidates`);
    const childrenDuringDiscover = await listChildren(client.processGroupId());
    assert.equal(childrenDuringDiscover.length, 0, `${item.name} started a vendor child during discover`);
    const probed = await client.request<{
      runtimeId: string;
      displayName: string;
      path: string;
      version: string;
      readinessIssue?: { code: string };
    }>('runtime.probe', { path: discovered.candidates[0]!.path });
    assert.equal(probed.runtimeId, item.runtimeId);
    assert.equal(probed.displayName, item.displayName);
    assert.equal(probed.version, item.version);
    assert.equal(probed.readinessIssue, undefined);
    await assert.rejects(
      () => client.request('session.create', {
        sessionId: 'should-not-create',
        workspace: { cwd: root, roots: [root] },
        config: {},
      }),
      /not available during Runtime bootstrap|METHOD_NOT_FOUND|Method not found/i,
    );
    await client.shutdown();
  }
});

test('ZCode readiness issues do not start a Session; Kimi store state stays advisory', { timeout: 30_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-official-ready-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, '.kimi-code', 'sessions'), { recursive: true });
  await writeFile(join(root, '.kimi-code', 'session_index.jsonl'), '{"id":"s1"}\n');
  const bins = join(root, '.local', 'bin');
  await mkdir(bins, { recursive: true });
  await writeExecutable(join(bins, 'kimi'), '#!/bin/sh\necho kimi 0.38.0\n');
  const zcode = join(root, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs');
  await writeExecutable(zcode, '#!/usr/bin/env node\nconsole.log("zcode 0.16.5");\n');

  for (const item of [
    OFFICIAL.find((entry) => entry.name === 'kimi')!,
    OFFICIAL.find((entry) => entry.name === 'zcode')!,
  ]) {
    const entry = join(repoRoot, 'packages', 'proxies', item.packageDir, 'dist', 'src', 'cli', 'spawn.js');
    const version = await pluginVersion(item.packageDir);
    const client = new ProtocolV2Client({
      entry,
      pluginId: item.pluginId,
      pluginVersion: version,
      processScope: item.processScope,
      dataDir: join(root, 'data', item.name),
      hostVersion: '0.1.0',
      protocolVersions: [PROTOCOL_V22],
      runtimeBootstrap: true,
      env: isolatedEnv(root, bins),
    });
    t.after(() => client.shutdown().catch(() => client.forceKill()));
    await client.initialize();
    const discovered = await client.request<{ candidates: Array<{ path: string }> }>('runtime.discover', {});
    const probed = await client.request<{ readinessIssue?: { code: string; repairable: boolean } }>(
      'runtime.probe',
      { path: discovered.candidates[0]!.path },
    );
    if (item.name === 'kimi') {
      // Since ADR-0080 Kimi session-store conditions are advisory: the probe
      // logs them but never reports a readinessIssue that would block a
      // Session. The CLI's own session/new or session/load verdict decides.
      assert.equal(probed.readinessIssue, undefined, 'kimi store state must not block Sessions');
    } else {
      assert.ok(probed.readinessIssue, `${item.name} should report readinessIssue`);
      assert.equal(probed.readinessIssue?.repairable, true);
    }
    await assert.rejects(
      () => client.request('session.create', {
        sessionId: 'nope',
        workspace: { cwd: root, roots: [root] },
        config: {},
      }),
      /not available during Runtime bootstrap|METHOD_NOT_FOUND/i,
    );
    await client.shutdown();
  }
});

test('ZCode readiness produces no Host lease; Kimi store state leases normally', { timeout: 40_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-official-lease-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const bins = join(root, '.local', 'bin');
  await mkdir(bins, { recursive: true });
  await mkdir(join(root, '.kimi-code', 'sessions'), { recursive: true });
  await writeFile(join(root, '.kimi-code', 'session_index.jsonl'), '{"id":"s1"}\n');
  const kimiBin = join(bins, 'kimi');
  await writeExecutable(kimiBin, '#!/bin/sh\necho kimi 0.38.0\n');
  const zcodeBin = join(root, 'Applications', 'ZCode.app', 'Contents', 'Resources', 'glm', 'zcode.cjs');
  await writeExecutable(zcodeBin, '#!/usr/bin/env node\nconsole.log("zcode 0.16.5");\n');
  await writeZcodeBuiltinConfig(zcodeBin);

  const resolver = new RuntimeResolver({
    dataDir: join(root, 'resolver'),
    updateLockDataDir: join(root, 'locks'),
    hostVersion: '0.1.0',
    bootstrapEnv: isolatedEnv(root, bins),
    homeDir: root,
  });

  const kimi = OFFICIAL.find((item) => item.name === 'kimi')!;
  const kimiResolved = await resolver.resolve({
    pluginId: parseProxyPluginId(kimi.pluginId),
    pluginVersion: await pluginVersion(kimi.packageDir),
    agentId: 'kimi',
    entryPath: join(repoRoot, 'packages', 'proxies', kimi.packageDir, 'dist', 'src', 'cli', 'spawn.js'),
    processScope: kimi.processScope,
    runtime: {
      kind: 'external',
      id: kimi.runtimeId,
      displayName: kimi.displayName,
      verifiedVersions: [],
    },
    selectedPath: kimiBin,
  });
  // Kimi session data without a verifiable same-home owner used to be a fatal
  // readinessIssue; since ADR-0080 it is advisory only, so the resolve leases
  // the runtime and the CLI's own session verdict decides.
  assert.equal(kimiResolved.readinessIssue, undefined);
  assert.ok(kimiResolved.lease, 'kimi resolve must lease despite advisory store conditions');
  assert.equal(kimiResolved.profile.path, kimiBin);
  await kimiResolved.lease?.release();

  const zcode = OFFICIAL.find((item) => item.name === 'zcode')!;
  const zcodeResolved = await resolver.resolve({
    pluginId: parseProxyPluginId(zcode.pluginId),
    pluginVersion: await pluginVersion(zcode.packageDir),
    agentId: 'zcode',
    entryPath: join(repoRoot, 'packages', 'proxies', zcode.packageDir, 'dist', 'src', 'cli', 'spawn.js'),
    processScope: zcode.processScope,
    runtime: {
      kind: 'external',
      id: zcode.runtimeId,
      displayName: zcode.displayName,
      verifiedVersions: [],
    },
    selectedPath: zcodeBin,
  });
  assert.equal(zcodeResolved.lease, null);
  assert.equal(zcodeResolved.readinessIssue?.code, 'zcode_cli_config_missing');
});

test('official spawn.js exact 2.2 session fixtures reach the real adapter', { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'gian-official-session-22-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(root, { recursive: true, force: true });
  });
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  const scenario = join(root, 'zcode-scenario.json');
  await writeFile(scenario, '{"behavior":{}}\n');
  const fixtures: Record<string, string> = {
    claude: join(repoRoot, 'packages', 'proxies', 'cc-proxy', 'test', 'fixtures', 'fake-claude-runtime.mjs'),
    codex: join(repoRoot, 'packages', 'proxies', 'codex-proxy', 'dist', 'test', 'fixtures', 'fake-codex-lifecycle-server.js'),
    kimi: join(repoRoot, 'packages', 'proxies', 'kimi-proxy', 'test', 'fixtures', 'fake-kimi-cli.mjs'),
    grok: join(repoRoot, 'packages', 'proxies', 'grok-proxy', 'test', 'fixtures', 'fake-grok-cli.mjs'),
    dsh: join(repoRoot, 'packages', 'proxies', 'dsh-proxy', 'test', 'fixtures', 'fake-dsh-bridge.mjs'),
    zcode: join(repoRoot, 'packages', 'proxies', 'zcode-proxy', 'test', 'fixtures', 'fake-app-server.mjs'),
  };
  await Promise.all(Object.values(fixtures).map((path) => chmod(path, 0o755)));

  for (const item of OFFICIAL) {
    const entry = join(repoRoot, 'packages', 'proxies', item.packageDir, 'dist', 'src', 'cli', 'spawn.js');
    const version = await pluginVersion(item.packageDir);
    const runtimeBin = fixtures[item.name]!;
    const client = new ProtocolV2Client({
      entry,
      pluginId: item.pluginId,
      pluginVersion: version,
      processScope: item.processScope,
      dataDir: join(root, 'session-data', item.name),
      hostVersion: '0.1.0',
      protocolVersions: [PROTOCOL_V22],
      runtimeBin,
      env: {
        ...isolatedEnv(root, [dirname(process.execPath), dirname(runtimeBin), '/usr/bin', '/bin'].join(':')),
        GIAN_DSH_HOST_ARGS: '[]',
        DSH_FAKE_SCRIPT: 'success',
        FAKE_SCENARIO: scenario,
        GIAN_ZCODE_DISABLE_INTERACTION: '1',
      },
    });
    t.after(() => client.shutdown().catch(() => client.forceKill()));
    const initialized = await client.initialize();
    assert.equal(initialized.protocol.version, PROTOCOL_V22, `${item.name} did not pin 2.2`);
    assert.equal(initialized.capabilities['runtime.discover'], 1);
    const catalog = await client.catalog() as { catalogRevision?: unknown };
    assert.ok(catalog, `${item.name} catalog.list failed`);
    const created = await client.request<{ session?: { id?: string } }>('session.create', {
      sessionId: `session-${item.name}`,
      workspace: { cwd: workspace, roots: [workspace] },
      config: {},
    });
    assert.ok(created.session, `${item.name} session.create did not reach the real adapter`);
    await client.shutdown();
    await client.waitUntilProcessGroupEmpty();
    assert.deepEqual(await listChildren(client.processGroupId()), []);
  }
});
