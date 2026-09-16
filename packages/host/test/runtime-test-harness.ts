import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { RuntimeResolver } from '../src/runtime/resolver.js';

export async function fakeOfficialProxy(
  root: string,
  id: 'claude' | 'codex' | 'kimi' | 'grok' | 'dsh' | 'zcode',
  runtimeDisplayName: string,
  pluginVersion: string,
): Promise<string> {
  const packageName = id === 'claude' ? 'cc-proxy' : `${id}-proxy`;
  const pluginId = id === 'dsh' ? 'ai.deepseek.harness' : id === 'zcode' ? 'com.zhipu.zcode' : id;
  const displayName = {
    claude: 'Claude Code',
    codex: 'Codex',
    kimi: 'Kimi Code',
    grok: 'Grok Build',
    dsh: 'DeepSeek Harness',
    zcode: 'ZCode',
  }[id];
  const runtimeId = id === 'dsh' ? 'deepseek-harness' : id;
  const verifiedVersions = {
    claude: ['2.1.159'],
    codex: ['0.146.0'],
    kimi: ['0.38.0'],
    grok: ['1.0.4'],
    dsh: ['0.1.1-rc.2'],
    zcode: ['0.16.5'],
  }[id];
  const packageDir = join(root, packageName);
  const proxy = join(packageDir, 'dist', 'src', 'cli', 'spawn.js');
  await mkdir(dirname(proxy), { recursive: true });
  await writeFile(join(packageDir, 'package.json'), JSON.stringify({
    name: `@gian/${packageName}`,
    version: pluginVersion,
  }));
  await writeFile(join(packageDir, 'manifest.json'), JSON.stringify({
    schemaVersion: 4,
    id: pluginId,
    displayName,
    pluginVersion,
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.2 <3.0' },
    process: { scope: id === 'claude' || id === 'grok' ? 'session' : 'shared' },
    runtime: {
      kind: 'external',
      id: runtimeId,
      displayName: runtimeDisplayName,
      verifiedVersions,
    },
    branding: {
      logo: {
        light: {
          path: 'assets/logo-light.png',
          mediaType: 'image/png',
          sha256: 'a'.repeat(64),
        },
      },
    },
  }));
  await writeFile(proxy, `#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { execFile } from 'node:child_process';
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: req.id, result,
  }) + '\\n');
  const fail = (message) => process.stdout.write(JSON.stringify({
    jsonrpc: '2.0', id: req.id, error: { code: -32000, message },
  }) + '\\n');
  if (req.method === 'initialize') {
    reply({
      protocol: { name: 'gian.proxy', version: '2.2' },
      plugin: { id: ${JSON.stringify(pluginId)}, name: ${JSON.stringify(displayName)}, version: ${JSON.stringify(pluginVersion)} },
      process: { scope: ${JSON.stringify(id === 'claude' || id === 'grok' ? 'session' : 'shared')} },
      capabilities: { 'runtime.discover': 1, 'runtime.probe': 1 },
    });
    return;
  }
  if (req.method === 'runtime.discover') {
    reply({ candidates: [], setupActions: [] });
    return;
  }
  if (req.method === 'runtime.probe') {
    let out = '';
    try {
      out = await new Promise((resolve, reject) => {
        execFile(req.params.path, ['--version'], (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve(String(stdout) + String(stderr));
        });
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
      return;
    }
    const version = String(out).match(/\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?/)?.[0];
    if (!version) {
      fail('did not report a semantic version');
      return;
    }
    reply({
      runtimeId: ${JSON.stringify(runtimeId)},
      displayName: ${JSON.stringify(runtimeDisplayName)},
      path: req.params.path,
      version,
      configHome: null,
      contentRoots: [{ path: req.params.path, mode: 'file' }],
    });
    return;
  }
  if (req.method === 'shutdown') {
    reply({ ok: true });
    process.exit(0);
  }
});
`);
  await chmod(proxy, 0o755);
  return proxy;
}

export async function developmentEntries(root: string): Promise<Record<'claude' | 'codex' | 'kimi' | 'grok' | 'dsh' | 'zcode', string>> {
  return {
    claude: await fakeOfficialProxy(root, 'claude', 'Claude Code', '0.2.4'),
    codex: await fakeOfficialProxy(root, 'codex', 'Codex CLI', '0.2.13'),
    kimi: await fakeOfficialProxy(root, 'kimi', 'Kimi Code', '0.2.8'),
    grok: await fakeOfficialProxy(root, 'grok', 'Grok CLI', '0.3.3'),
    dsh: await fakeOfficialProxy(root, 'dsh', 'DeepSeek Harness', '0.1.6'),
    zcode: await fakeOfficialProxy(root, 'zcode', 'ZCode Runtime', '0.1.1'),
  };
}

export function testResolver(root: string): RuntimeResolver {
  return new RuntimeResolver({
    dataDir: join(root, 'resolver'),
    updateLockDataDir: join(root, 'locks'),
    hostVersion: '0.1.0',
    homeDir: join(root, 'home'),
  });
}
