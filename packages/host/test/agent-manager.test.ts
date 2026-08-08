import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { AgentManager } from '../src/agents/manager.js';

const execFileAsync = promisify(execFile);

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

test('agent manager detects configured official CLIs and development proxies', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agents-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bins = {
    claude: join(root, 'bin', 'claude'),
    codex: join(root, 'bin', 'codex'),
    kimi: join(root, 'bin', 'kimi'),
  };
  await Promise.all([
    executable(bins.claude, 'claude 2.1.220'),
    executable(bins.codex, 'codex-cli 0.146.0'),
    executable(bins.kimi, 'kimi 0.31.1'),
  ]);
  const proxy = join(root, 'proxy.mjs');
  await writeFile(proxy, 'export {};\n');

  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: { claude: proxy, codex: proxy, kimi: proxy },
    environmentCliPaths: bins,
    homeDir: join(root, 'home'),
    pathEnv: '',
  });

  const agents = await manager.list();
  assert.deepEqual(agents.map(agent => [agent.id, agent.ready, agent.cli.version]), [
    ['claude', true, '2.1.220'],
    ['codex', true, '0.146.0'],
    ['kimi', true, '0.31.1'],
  ]);

  await executable(bins.codex, 'codex-cli 0.147.0');
  assert.equal((await manager.status('codex')).cli.version, '0.146.0');
  assert.equal((await manager.status('codex', true)).cli.version, '0.147.0');
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
    developmentProxyEntries: { claude: proxy, codex: proxy, kimi: proxy },
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
    developmentProxyEntries: { claude: proxy, codex: proxy, kimi: proxy },
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
  await writeFile(join(packageDir, 'proxy.mjs'), selfTestingProxy('claude'));
  await writeFile(join(packageDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'claude',
    version: '0.1.0',
    entry: 'proxy.mjs',
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
  await writeFile(join(proxyDir, 'proxy.mjs'), selfTestingProxy('claude'));
  await writeFile(join(proxyDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 1,
    id: 'claude',
    version: '0.2.1',
    entry: 'proxy.mjs',
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
