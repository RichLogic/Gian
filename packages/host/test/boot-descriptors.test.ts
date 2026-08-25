// Lazy boot load set (issue #97): only Proxy kinds referenced by saved
// Agents get validated launch descriptors at boot; everything else stays a
// nominal entry — no realpath, no manifest read, no self-test spawn.

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AgentManager } from '../src/agents/manager.js';
import { resolveBootProxyDescriptors } from '../src/proxy/boot-descriptors.js';

async function installedProxy(
  dataDir: string,
  kind: string,
  version: string,
  markerPath: string,
): Promise<void> {
  const dir = join(dataDir, 'plugins', kind, version);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'proxy.mjs'), `
    import { writeFileSync } from 'node:fs';
    if (process.argv.includes('--self-test')) {
      writeFileSync(${JSON.stringify(markerPath)}, 'self-test-ran');
      process.stdout.write('${JSON.stringify({ schemaVersion: 2, id: kind, pluginVersion: version, ok: true })}\\n');
    }
  `);
  await writeFile(join(dir, 'manifest.json'), JSON.stringify({
    schemaVersion: 2,
    id: kind,
    displayName: kind,
    pluginVersion: version,
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.0 <3.0' },
    process: { scope: 'shared' },
  }));
  await symlink(version, join(dataDir, 'plugins', kind, 'current'), 'dir');
}

async function markerRan(path: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')) === 'self-test-ran';
  } catch {
    return false;
  }
}

test('boot resolves launch descriptors only for kinds used by saved Agents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-boot-lazy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const claudeMarker = join(root, 'claude-self-test');
  const codexMarker = join(root, 'codex-self-test');
  await installedProxy(dataDir, 'claude', '0.2.0', claudeMarker);
  await installedProxy(dataDir, 'codex', '0.2.0', codexMarker);
  // A saved-agents profile (v2 on disk — no migration): only claude is used.
  await mkdir(dataDir, { recursive: true });
  await writeFile(join(dataDir, 'agents.json'), `${JSON.stringify({
    schemaVersion: 2,
    agents: [{
      id: 'agent-claude-1',
      name: 'My Claude',
      color: 'ember',
      proxy: 'claude',
      cliPath: null,
      defaults: { model: '', thinking: '', mode: '' },
    }],
  }, null, 2)}\n`);

  const agents = await AgentManager.create({
    dataDir,
    releaseVersion: '0.5.2',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
  });

  const descriptors = await resolveBootProxyDescriptors(agents);

  // The used kind is validated (manifest + self-test ran).
  assert.equal(descriptors.claude.protocol?.pluginVersion, '0.2.0');
  assert.equal(descriptors.claude.protocol?.processScope, 'shared');
  assert.equal(await markerRan(claudeMarker), true);

  // Unused kinds stay nominal: no protocol descriptor, no self-test spawn.
  assert.equal(descriptors.codex?.protocol, undefined);
  assert.equal(
    descriptors.codex?.entryPath,
    join(dataDir, 'plugins', 'codex', 'current', 'proxy.mjs'),
  );
  assert.equal(await markerRan(codexMarker), false);
  assert.equal(descriptors.kimi?.protocol, undefined);
  assert.equal(descriptors.dsh?.protocol, undefined);
});

test('boot descriptors in development mode never read plugin versions for unused kinds', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-boot-lazy-dev-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxy = join(root, 'proxy.mjs');
  await writeFile(proxy, 'export {};\n');
  const agents = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.5.2',
    managedProxies: false,
    developmentProxyEntries: { claude: proxy, codex: proxy },
    homeDir: join(root, 'home'),
    pathEnv: '',
  });

  const descriptors = await resolveBootProxyDescriptors(agents);
  // No saved Agents at all: every kind is nominal, even in dev mode.
  assert.deepEqual(descriptors.claude, { entryPath: proxy });
  assert.deepEqual(descriptors.codex, { entryPath: proxy });
});
