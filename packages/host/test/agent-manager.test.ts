import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import {
  AgentManager,
  parseIndependentProxyRelease,
  recommendedCliVersionFromManifest,
} from '../src/agents/manager.js';

const execFileAsync = promisify(execFile);

test('recommended CLI version prefers the installed Proxy manifest over the Host fallback', () => {
  assert.equal(recommendedCliVersionFromManifest(null, 'grok'), '1.0.4');
  assert.equal(recommendedCliVersionFromManifest({
    schemaVersion: 1,
    id: 'grok',
    version: '0.1.0',
    entry: 'proxy.mjs',
  }, 'grok'), '1.0.4');
  assert.equal(recommendedCliVersionFromManifest({
    schemaVersion: 2,
    id: 'grok',
    displayName: 'Grok Build',
    pluginVersion: '0.2.2',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.0 <3.0' },
    process: { scope: 'session' },
    runtime: {
      id: 'grok',
      displayName: 'Grok Build CLI',
      recommendedCliVersion: '1.0.4',
    },
  }, 'grok'), '1.0.4');
  assert.equal(recommendedCliVersionFromManifest({
    schemaVersion: 2,
    id: 'grok',
    displayName: 'Grok Build',
    pluginVersion: '0.2.2',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.0 <3.0' },
    process: { scope: 'session' },
    runtime: {
      id: 'grok',
      displayName: 'Grok Build CLI',
      recommendedCliVersion: '9.9.9',
    },
  }, 'grok'), '9.9.9');
});

test('independent Proxy releases select the highest stable plugin SemVer', () => {
  assert.deepEqual(parseIndependentProxyRelease([
    { tag_name: 'proxy-codex-v1.9.0', draft: false, prerelease: false },
    { tag_name: 'proxy-codex-v2.0.0-beta.1', draft: false, prerelease: true },
    { tag_name: 'proxy-codex-v4.0.0-beta.1', draft: false, prerelease: false },
    { tag_name: 'proxy-claude-v9.0.0', draft: false, prerelease: false },
    { tag_name: 'proxy-codex-v1.10.0', draft: false, prerelease: false },
    { tag_name: 'proxy-codex-v3.0.0', draft: true, prerelease: false },
  ], 'codex'), {
    tag: 'proxy-codex-v1.10.0',
    version: '1.10.0',
  });
});

async function executable(path: string, version: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`);
  await chmod(path, 0o755);
}

function selfTestingProxy(id: string): string {
  return `if (process.argv.includes('--self-test')) process.stdout.write('${JSON.stringify({
    schemaVersion: 1,
    id,
    ok: true,
  })}\\n');\n`;
}

function selfTestingProxyV2(id: string, pluginVersion: string): string {
  return `if (process.argv.includes('--self-test')) process.stdout.write('${JSON.stringify({
    schemaVersion: 2,
    id,
    pluginVersion,
    ok: true,
  })}\\n');\n`;
}

test('agent manager detects configured official CLIs and development proxies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bins = {
    claude: join(root, 'bin', 'claude'),
    codex: join(root, 'bin', 'codex'),
    kimi: join(root, 'bin', 'kimi'),
    grok: join(root, 'bin', 'grok'),
  };
  await Promise.all([
    executable(bins.claude, 'claude 2.1.220'),
    executable(bins.codex, 'codex-cli 0.146.0'),
    executable(bins.kimi, 'kimi 0.31.1'),
    executable(bins.grok, 'grok 0.1.42'),
  ]);
  const proxy = join(root, 'proxy.mjs');
  await writeFile(proxy, 'export {};\n');

  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: { claude: proxy, codex: proxy, kimi: proxy, grok: proxy, dsh: proxy },
    environmentCliPaths: bins,
    homeDir: join(root, 'home'),
    pathEnv: '',
  });

  const agents = await manager.list();
  assert.deepEqual(agents.map(agent => [agent.id, agent.ready, agent.cli.version]), [
    ['claude', true, '2.1.220'],
    ['codex', true, '0.146.0'],
    ['kimi', true, '0.31.1'],
    ['grok', true, '0.1.42'],
    ['dsh', false, null],
  ]);

  await executable(bins.codex, 'codex-cli 0.147.0');
  assert.equal((await manager.status('codex')).cli.version, '0.146.0');
  assert.equal((await manager.status('codex', true)).cli.version, '0.147.0');
  assert.equal((await manager.status('grok')).cli.recommendedVersion, '1.0.4');
});

test('managed Grok Proxy recommended CLI version comes from the plugin manifest', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-grok-recommended-cli-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const grok = join(root, 'bin', 'grok');
  await executable(grok, 'grok 1.0.4');

  const proxyDir = join(root, 'data', 'plugins', 'grok', '0.2.2');
  await mkdir(proxyDir, { recursive: true });
  await writeFile(join(proxyDir, 'proxy.mjs'), selfTestingProxyV2('grok', '0.2.2'));
  await writeFile(join(proxyDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 2,
    id: 'grok',
    displayName: 'Grok Build',
    pluginVersion: '0.2.2',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.0 <3.0' },
    process: { scope: 'session' },
    runtime: {
      id: 'grok',
      displayName: 'Grok Build CLI',
      recommendedCliVersion: '1.0.4',
    },
  }));
  await symlink('0.2.2', join(root, 'data', 'plugins', 'grok', 'current'), 'dir');

  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.4.5',
    managedProxies: true,
    independentProxyReleases: true,
    environmentCliPaths: { grok },
    homeDir: join(root, 'home'),
    pathEnv: '',
  });

  const status = await manager.status('grok');
  assert.equal(status.cli.version, '1.0.4');
  assert.equal(status.cli.recommendedVersion, '1.0.4');
});

test('fresh managed profile exposes onboarding before any Proxy is installed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-fresh-managed-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const manager = await AgentManager.create({
    dataDir,
    releaseVersion: '0.4.2',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
  });

  assert.deepEqual(await manager.proxyLaunchDescriptor('claude'), {
    entryPath: join(dataDir, 'plugins', 'claude', 'current', 'proxy.mjs'),
  });
  assert.equal((await manager.status('claude')).proxy.state, 'missing');

  await mkdir(join(dataDir, 'plugins', 'claude'), { recursive: true });
  await symlink('missing-version', join(dataDir, 'plugins', 'claude', 'current'));
  await assert.rejects(
    manager.proxyLaunchDescriptor('claude'),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );
});

test('agent manager validates and persists a user CLI path', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxy = join(root, 'proxy.mjs');
  const claude = join(root, 'custom', 'claude');
  await writeFile(proxy, 'export {};\n');
  await executable(claude, 'claude 2.1.220');
  const options = {
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: { claude: proxy, codex: proxy, kimi: proxy, grok: proxy, dsh: proxy },
    homeDir: join(root, 'home'),
    pathEnv: '',
  } as const;
  const manager = await AgentManager.create(options);

  const status = await manager.setCliPath('claude', claude);
  assert.equal(status.cli.state, 'ready');
  assert.equal(status.cli.source, 'override');

  const reloaded = await AgentManager.create(options);
  assert.equal(reloaded.configuredPath('claude'), claude);
  await assert.rejects(
    reloaded.setCliPath('claude', join(root, 'missing')),
    /not usable|ENOENT/i,
  );
  assert.equal(reloaded.configuredPath('claude'), claude);
});

test('agent manager migrates and persists Proxy-owned session defaults', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-defaults-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxy = join(root, 'proxy.mjs');
  await writeFile(proxy, 'export {};\n');
  const options = {
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: { claude: proxy, codex: proxy, kimi: proxy, grok: proxy, dsh: proxy },
    homeDir: join(root, 'home'),
    pathEnv: '',
    legacyProxyDefaults: {
      claude: { model: 'opus', thinking: 'high', mode: 'ask' },
    },
  } as const;

  const manager = await AgentManager.create(options);
  assert.deepEqual(manager.proxyDefaults('claude'), {
    model: 'opus',
    thinking: 'high',
    mode: 'ask',
  });
  await manager.setProxyDefaults('claude', { mode: 'auto', thinking: 'xhigh' });

  const reloaded = await AgentManager.create(options);
  assert.deepEqual(reloaded.proxyDefaults('claude'), {
    model: 'opus',
    thinking: 'xhigh',
    mode: 'auto',
  });
});

test('agent manager verifies and atomically activates a GitHub proxy archive', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-proxy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = join(root, 'fixture');
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'proxy.mjs'), selfTestingProxyV2('claude', '0.1.0'));
  await writeFile(join(packageDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 2,
    id: 'claude',
    displayName: 'Claude Code',
    pluginVersion: '0.1.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.0 <3.0' },
    process: { scope: 'session' },
  }));
  const archivePath = join(root, 'proxy.tar.gz');
  await execFileAsync('/usr/bin/tar', ['-czf', archivePath, '-C', packageDir, '.']);
  const archive = await readFile(archivePath);
  const checksum = createHash('sha256').update(archive).digest('hex');
  const checksumBody = Buffer.from(
    `${checksum}  gian-proxy-claude-0.1.0-darwin-arm64.tar.gz\n`,
  );
  const checksumDigest = createHash('sha256').update(checksumBody).digest('hex');

  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
    fetchImpl: async input => {
      const url = String(input);
      if (url.startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify({
          tag_name: 'v0.1.0',
          assets: [
            {
              name: 'gian-proxy-claude-0.1.0-darwin-arm64.tar.gz',
              digest: `sha256:${checksum}`,
            },
            {
              name: 'gian-proxy-claude-0.1.0-darwin-arm64.tar.gz.sha256',
              digest: `sha256:${checksumDigest}`,
            },
          ],
        }));
      }
      return url.endsWith('.sha256')
        ? new Response(checksumBody)
        : new Response(archive);
    },
    proxyActivationProbe: async () => undefined,
  });

  const result = await manager.installProxy('claude');
  assert.equal(result.agent.proxy.state, 'ready');
  assert.equal(result.agent.proxy.version, '0.1.0');
  assert.equal(
    await readlink(join(root, 'data', 'plugins', 'claude', 'current')),
    '0.1.0',
  );
});

test('agent manager activates the DSH alias with its reverse-domain manifest identity', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-proxy-v2-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageDir = join(root, 'fixture');
  await mkdir(packageDir, { recursive: true });
  await writeFile(
    join(packageDir, 'proxy.mjs'),
    selfTestingProxyV2('ai.deepseek.harness', '7.4.2'),
  );
  const manifest = {
    schemaVersion: 2,
    id: 'ai.deepseek.harness',
    displayName: 'DeepSeek Harness',
    pluginVersion: '7.4.2',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.0 <3.0' },
    process: { scope: 'shared' },
  };
  const manifestBody = Buffer.from(`${JSON.stringify(manifest)}\n`);
  await writeFile(join(packageDir, 'manifest.json'), manifestBody);
  const archivePath = join(root, 'proxy.tar.gz');
  await execFileAsync('/usr/bin/tar', ['-czf', archivePath, '-C', packageDir, '.']);
  const archive = await readFile(archivePath);
  const checksum = createHash('sha256').update(archive).digest('hex');
  const assetName = 'gian-proxy-dsh-7.4.2-darwin-arm64.tar.gz';
  const checksumBody = Buffer.from(`${checksum}  ${assetName}\n`);
  const checksumDigest = createHash('sha256').update(checksumBody).digest('hex');
  const manifestName = `${assetName}.manifest.json`;
  const manifestDigest = createHash('sha256').update(manifestBody).digest('hex');
  const incompatibleManifestBody = Buffer.from(`${JSON.stringify({
    ...manifest,
    pluginVersion: '9.0.0',
    protocol: { name: 'gian.proxy', range: '>=3.0 <4.0' },
  })}\n`);
  const incompatibleManifestName = 'gian-proxy-dsh-9.0.0-darwin-arm64.tar.gz.manifest.json';
  const incompatibleManifestDigest = createHash('sha256')
    .update(incompatibleManifestBody)
    .digest('hex');
  const probes: unknown[] = [];

  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.3.0',
    managedProxies: true,
    independentProxyReleases: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
    fetchImpl: async input => {
      const url = String(input);
      if (url.endsWith('/releases?per_page=100')) {
        return new Response(JSON.stringify([
          {
            tag_name: 'proxy-dsh-v9.0.0', draft: false, prerelease: false,
            assets: [{ name: incompatibleManifestName, digest: `sha256:${incompatibleManifestDigest}` }],
          },
          {
            tag_name: 'proxy-dsh-v7.4.2', draft: false, prerelease: false,
            assets: [{ name: manifestName, digest: `sha256:${manifestDigest}` }],
          },
        ]));
      }
      if (url.startsWith('https://api.github.com/')) {
        return new Response(JSON.stringify({
          tag_name: 'proxy-dsh-v7.4.2',
          assets: [
            { name: assetName, digest: `sha256:${checksum}` },
            { name: `${assetName}.sha256`, digest: `sha256:${checksumDigest}` },
            { name: manifestName, digest: `sha256:${manifestDigest}` },
          ],
        }));
      }
      if (url.endsWith(incompatibleManifestName)) return new Response(incompatibleManifestBody);
      if (url.endsWith(manifestName)) return new Response(manifestBody);
      return url.endsWith('.sha256') ? new Response(checksumBody) : new Response(archive);
    },
    proxyActivationProbe: async input => { probes.push(input); },
  });

  const result = await manager.installProxy('dsh');
  assert.equal(result.agent.proxy.state, 'ready');
  assert.equal(result.agent.proxy.version, '7.4.2');
  assert.equal(await readlink(join(root, 'data', 'plugins', 'dsh', 'current')), '7.4.2');
  const installedEntry = await realpath(join(
    root,
    'data',
    'plugins',
    'dsh',
    '7.4.2',
    'proxy.mjs',
  ));
  assert.deepEqual(probes, [{
    id: 'dsh',
    version: '7.4.2',
    entryPath: installedEntry,
    protocol: 'gian.proxy',
    processScope: 'shared',
  }]);
});

test('agent manager marks a managed proxy invalid when its startup self-test fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-proxy-self-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claude = join(root, 'bin', 'claude');
  await executable(claude, 'claude 2.1.220');

  const proxyDir = join(root, 'data', 'plugins', 'claude', '0.1.0');
  await mkdir(proxyDir, { recursive: true });
  await writeFile(join(proxyDir, 'proxy.mjs'), 'throw new Error("broken bundle");\n');
  await writeFile(join(proxyDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'claude',
    version: '0.1.0',
    entry: 'proxy.mjs',
  }));
  await symlink('0.1.0', join(root, 'data', 'plugins', 'claude', 'current'), 'dir');

  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: true,
    environmentCliPaths: { claude },
    homeDir: join(root, 'home'),
    pathEnv: '',
  });

  const status = await manager.status('claude');
  assert.equal(status.cli.state, 'ready');
  assert.equal(status.proxy.state, 'invalid');
  assert.match(status.proxy.error ?? '', /proxy self-test failed/i);
  assert.equal(status.ready, false);
  await assert.rejects(
    manager.proxyLaunchDescriptor('claude'),
    /proxy self-test failed/i,
  );
});

test('agent manager marks a valid older managed proxy as outdated', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-proxy-outdated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claude = join(root, 'bin', 'claude');
  await executable(claude, 'claude 2.1.220');

  const proxyDir = join(root, 'data', 'plugins', 'claude', '0.1.0');
  await mkdir(proxyDir, { recursive: true });
  await writeFile(join(proxyDir, 'proxy.mjs'), selfTestingProxy('claude'));
  await writeFile(join(proxyDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'claude',
    version: '0.1.0',
    entry: 'proxy.mjs',
  }));
  await symlink('0.1.0', join(root, 'data', 'plugins', 'claude', 'current'), 'dir');

  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.2.0',
    managedProxies: true,
    environmentCliPaths: { claude },
    homeDir: join(root, 'home'),
    pathEnv: '',
  });

  const status = await manager.status('claude');
  assert.equal(status.proxy.state, 'outdated');
  assert.equal(status.proxy.version, '0.1.0');
  assert.equal(status.ready, false);
});

test('agent manager keeps the base Proxy ready for an app-only hotfix', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-proxy-hotfix-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claude = join(root, 'bin', 'claude');
  await executable(claude, 'claude 2.1.220');

  const proxyDir = join(root, 'data', 'plugins', 'claude', '0.2.1');
  await mkdir(proxyDir, { recursive: true });
  await writeFile(join(proxyDir, 'proxy.mjs'), selfTestingProxyV2('claude', '0.2.1'));
  await writeFile(join(proxyDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 2,
    id: 'claude',
    displayName: 'Claude Code',
    pluginVersion: '0.2.1',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.0 <3.0' },
    process: { scope: 'session' },
  }));
  await symlink('0.2.1', join(root, 'data', 'plugins', 'claude', 'current'), 'dir');

  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.2.1-hotfix',
    managedProxies: true,
    environmentCliPaths: { claude },
    homeDir: join(root, 'home'),
    pathEnv: '',
  });

  const status = await manager.status('claude');
  assert.equal(status.proxy.state, 'ready');
  assert.equal(status.proxy.version, '0.2.1');
  assert.equal(status.ready, true);
});

test('manifest v2 keeps a compatible independently-versioned Proxy ready', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-proxy-v2-ready-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claude = join(root, 'bin', 'claude');
  await executable(claude, 'claude 2.1.220');

  const proxyDir = join(root, 'data', 'plugins', 'claude', '7.4.2');
  await mkdir(proxyDir, { recursive: true });
  await writeFile(join(proxyDir, 'proxy.mjs'), selfTestingProxyV2('claude', '7.4.2'));
  await writeFile(join(proxyDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 2,
    id: 'claude',
    displayName: 'Claude Code',
    pluginVersion: '7.4.2',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.0 <3.0' },
    process: { scope: 'session' },
    runtime: { id: 'claude', displayName: 'Claude Code CLI' },
  }));
  await symlink('7.4.2', join(root, 'data', 'plugins', 'claude', 'current'), 'dir');

  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '99.8.7',
    managedProxies: true,
    environmentCliPaths: { claude },
    homeDir: join(root, 'home'),
    pathEnv: '',
  });

  const status = await manager.status('claude');
  assert.equal(status.proxy.state, 'ready');
  assert.equal(status.proxy.version, '7.4.2');
  assert.equal(status.ready, true);
});

test('manifest v2 reports an incompatible protocol range as outdated', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-proxy-v2-outdated-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxyDir = join(root, 'data', 'plugins', 'codex', '4.0.0');
  await mkdir(proxyDir, { recursive: true });
  await writeFile(join(proxyDir, 'proxy.mjs'), selfTestingProxyV2('codex', '4.0.0'));
  await writeFile(join(proxyDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 2,
    id: 'codex',
    displayName: 'Codex',
    pluginVersion: '4.0.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=3.0 <4.0' },
    process: { scope: 'shared' },
  }));
  await symlink('4.0.0', join(root, 'data', 'plugins', 'codex', 'current'), 'dir');

  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.3.0',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
  });

  const status = await manager.status('codex');
  assert.equal(status.proxy.state, 'outdated');
  assert.equal(status.proxy.version, '4.0.0');
});

test('manifest v2 self-test must repeat the manifest plugin version', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-proxy-v2-self-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxyDir = join(root, 'data', 'plugins', 'kimi', '1.2.3');
  await mkdir(proxyDir, { recursive: true });
  await writeFile(join(proxyDir, 'proxy.mjs'), selfTestingProxyV2('kimi', '1.2.4'));
  await writeFile(join(proxyDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 2,
    id: 'kimi',
    displayName: 'Kimi Code',
    pluginVersion: '1.2.3',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '^1.0' },
    process: { scope: 'shared' },
  }));
  await symlink('1.2.3', join(root, 'data', 'plugins', 'kimi', 'current'), 'dir');

  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.3.0',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
  });

  const status = await manager.status('kimi');
  assert.equal(status.proxy.state, 'invalid');
  assert.match(status.proxy.error ?? '', /self-test returned an invalid result/i);
});

/** Fabricate an activated manifest-v2 plugin install without the network
 *  (checkProxyUpdate tests only need proxyStatus + resolveProxyRelease). */
async function fabricateInstalledProxyV2(
  root: string,
  id: string,
  version: string,
  range = '>=2.0 <3.0',
): Promise<void> {
  const proxyDir = join(root, 'data', 'plugins', id, version);
  await mkdir(proxyDir, { recursive: true });
  await writeFile(join(proxyDir, 'proxy.mjs'), selfTestingProxyV2(id, version));
  await writeFile(join(proxyDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 2,
    id,
    displayName: id,
    pluginVersion: version,
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range },
    process: { scope: 'shared' },
  }));
  await symlink(version, join(root, 'data', 'plugins', id, 'current'), 'dir');
}

test('checkProxyUpdate is unmanaged for development proxies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-proxy-check-dev-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxy = join(root, 'proxy.mjs');
  await writeFile(proxy, 'export {};\n');

  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.4.4',
    managedProxies: false,
    developmentProxyEntries: { claude: proxy, codex: proxy, kimi: proxy, grok: proxy, dsh: proxy },
    homeDir: join(root, 'home'),
    pathEnv: '',
  });

  assert.deepEqual(await manager.checkProxyUpdate('claude'), {
    managed: false,
    currentVersion: null,
    latestVersion: null,
    updateAvailable: false,
  });
});

test('checkProxyUpdate reports the newest compatible independent release', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-proxy-check-newer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fabricateInstalledProxyV2(root, 'codex', '7.4.2');

  const compatibleManifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    id: 'codex',
    displayName: 'Codex',
    pluginVersion: '7.5.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.0 <3.0' },
    process: { scope: 'shared' },
  })}\n`);
  const compatibleName = 'gian-proxy-codex-7.5.0-darwin-arm64.tar.gz.manifest.json';
  const compatibleDigest = createHash('sha256').update(compatibleManifest).digest('hex');
  const incompatibleManifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    id: 'codex',
    displayName: 'Codex',
    pluginVersion: '9.0.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=3.0 <4.0' },
    process: { scope: 'shared' },
  })}\n`);
  const incompatibleName = 'gian-proxy-codex-9.0.0-darwin-arm64.tar.gz.manifest.json';
  const incompatibleDigest = createHash('sha256').update(incompatibleManifest).digest('hex');

  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.4.4',
    managedProxies: true,
    independentProxyReleases: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
    fetchImpl: async input => {
      const url = String(input);
      if (url.endsWith('/releases?per_page=100')) {
        return new Response(JSON.stringify([
          // Newer but protocol-incompatible: must be skipped, not reported.
          {
            tag_name: 'proxy-codex-v9.0.0', draft: false, prerelease: false,
            assets: [{ name: incompatibleName, digest: `sha256:${incompatibleDigest}` }],
          },
          {
            tag_name: 'proxy-codex-v7.5.0', draft: false, prerelease: false,
            assets: [{ name: compatibleName, digest: `sha256:${compatibleDigest}` }],
          },
        ]));
      }
      if (url.endsWith(incompatibleName)) return new Response(incompatibleManifest);
      if (url.endsWith(compatibleName)) return new Response(compatibleManifest);
      throw new Error(`unexpected fetch: ${url}`);
    },
  });

  assert.deepEqual(await manager.checkProxyUpdate('codex'), {
    managed: true,
    currentVersion: '7.4.2',
    latestVersion: '7.5.0',
    updateAvailable: true,
  });
});

test('checkProxyUpdate reports up to date when the installed version matches', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-proxy-check-current-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await fabricateInstalledProxyV2(root, 'codex', '7.5.0');

  const manifest = Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    id: 'codex',
    displayName: 'Codex',
    pluginVersion: '7.5.0',
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.0 <3.0' },
    process: { scope: 'shared' },
  })}\n`);
  const manifestName = 'gian-proxy-codex-7.5.0-darwin-arm64.tar.gz.manifest.json';
  const manifestDigest = createHash('sha256').update(manifest).digest('hex');

  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.4.4',
    managedProxies: true,
    independentProxyReleases: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
    fetchImpl: async input => {
      const url = String(input);
      if (url.endsWith('/releases?per_page=100')) {
        return new Response(JSON.stringify([
          {
            tag_name: 'proxy-codex-v7.5.0', draft: false, prerelease: false,
            assets: [{ name: manifestName, digest: `sha256:${manifestDigest}` }],
          },
        ]));
      }
      if (url.endsWith(manifestName)) return new Response(manifest);
      throw new Error(`unexpected fetch: ${url}`);
    },
  });

  assert.deepEqual(await manager.checkProxyUpdate('codex'), {
    managed: true,
    currentVersion: '7.5.0',
    latestVersion: '7.5.0',
    updateAvailable: false,
  });
});

test('checkProxyUpdate treats a missing install as updatable without network in legacy mode', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-proxy-check-legacy-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.4.4',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
  });

  assert.deepEqual(await manager.checkProxyUpdate('kimi'), {
    managed: true,
    currentVersion: null,
    latestVersion: '0.4.4',
    updateAvailable: true,
  });
});
