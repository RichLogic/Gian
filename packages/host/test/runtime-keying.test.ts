import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { ProxyManager } from '../src/proxy/manager.js';
import { ProtocolV2SessionClient } from '../src/proxy/protocol-v2-session-client.js';
import { CliRuntimeManager } from '../src/runtime/manager.js';
import { CommandRuntimeProvider } from '../src/runtime/command-provider.js';

async function countingCli(path: string, countPath: string, version: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `#!/bin/sh
count=0
if [ -f '${countPath}' ]; then count=$(cat '${countPath}'); fi
count=$((count + 1))
printf '%s' "$count" > '${countPath}'
printf 'claude ${version}\\n'
`, { mode: 0o700 });
  await chmod(path, 0o755);
}

async function probeCount(countPath: string): Promise<number> {
  try {
    return Number(await readFile(countPath, 'utf8'));
  } catch {
    return 0;
  }
}

test('CliRuntimeManager keys runtimes by (kind, path): two paths never share a runtime', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-keying-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cliA = join(root, 'a', 'claude');
  const cliB = join(root, 'b', 'claude');
  const countA = join(root, 'count-a');
  const countB = join(root, 'count-b');
  await countingCli(cliA, countA, '2.0.0');
  await countingCli(cliB, countB, '2.1.0');

  const provider = new CommandRuntimeProvider({
    id: 'claude',
    command: 'claude',
    configuredPath: () => undefined,
    officialPaths: () => [],
    pathEnv: () => '',
  });
  const runtimes = new CliRuntimeManager([provider], join(root, 'locks'));

  const leaseA1 = await runtimes.acquire('claude', cliA);
  const leaseB1 = await runtimes.acquire('claude', cliB);
  assert.equal(leaseA1.binaryPath, cliA);
  assert.equal(leaseB1.binaryPath, cliB);
  assert.equal(leaseA1.version, '2.0.0');
  assert.equal(leaseB1.version, '2.1.0');

  // Same (kind, path) reuses the resolved runtime without re-probing.
  const leaseA2 = await runtimes.acquire('claude', cliA);
  assert.equal(leaseA2.binaryPath, cliA);
  assert.equal(await probeCount(countA), 1);
  assert.equal(await probeCount(countB), 1);

  // Invalidating one (kind, path) leaves the other generation untouched.
  runtimes.invalidate('claude', cliA);
  const leaseA3 = await runtimes.acquire('claude', cliA);
  const leaseB2 = await runtimes.acquire('claude', cliB);
  assert.equal(await probeCount(countA), 2, 'path A re-probed after its invalidation');
  assert.equal(await probeCount(countB), 1, 'path B was not disturbed');
  assert.equal(leaseB2.binaryPath, cliB);

  await Promise.all([
    leaseA1.release(),
    leaseA2.release(),
    leaseA3.release(),
    leaseB1.release(),
    leaseB2.release(),
  ]);
  await runtimes.drain('claude');
});

const STDIO_BOOT = `
  const reply = (request, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  if (request.method === 'initialize') {
    reply(request, {
      protocol: { name: 'gian.proxy', version: '2.0' },
      plugin: { id: 'codex', name: 'codex', version: '0.2.0' },
      process: { scope: 'shared' },
      capabilities: {},
    });
    continue;
  }
  if (request.method === 'catalog.list') {
    reply(request, { catalogRevision: 'test', input: [{ type: 'text' }], configOptions: [], slashCommands: [] });
    continue;
  }
  if (request.method === 'shutdown') {
    reply(request, { ok: true });
    process.exit(0);
  }
`;

test('ProxyManager keys shared hosts by (kind, path): two Codex paths get two hosts', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-proxy-keying-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxyEntry = join(root, 'fake-codex-proxy.mjs');
  await writeFile(proxyEntry, `
    import { createInterface } from 'node:readline';
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      const request = JSON.parse(line);
      ${STDIO_BOOT}
    }
  `);

  const acquiredPaths: Array<string | null | undefined> = [];
  const runtimeManager = {
    async acquire(_cli: string, overridePath?: string | null) {
      acquiredPaths.push(overridePath);
      return {
        cli: 'codex',
        binaryPath: overridePath ?? '/fake/codex',
        version: '1.0.0',
        source: 'managed',
        env: {},
        async release() {},
      };
    },
  };
  const manager = new ProxyManager({
    dataDir: root,
    ccProxyEntry: '/unused/cc-proxy.mjs',
    codexProxyEntry: proxyEntry,
    codexProxy: { pluginVersion: '0.2.0', processScope: 'shared' },
    runtimeManager: runtimeManager as never,
  });

  const pathA = join(root, 'a', 'codex');
  const pathB = join(root, 'b', 'codex');
  const clientA = await manager.getOrCreate('session-a', 'codex', { cliPath: pathA });
  const clientB = await manager.getOrCreate('session-b', 'codex', { cliPath: pathB });
  const clientA2 = await manager.getOrCreate('session-c', 'codex', { cliPath: pathA });

  assert.ok(clientA instanceof ProtocolV2SessionClient);
  assert.ok(clientB instanceof ProtocolV2SessionClient);
  assert.ok(clientA2 instanceof ProtocolV2SessionClient);
  assert.notEqual(
    clientA.runtimeHost(),
    clientB.runtimeHost(),
    'different CLI paths must not share a Codex host process',
  );
  assert.equal(
    clientA.runtimeHost(),
    clientA2.runtimeHost(),
    'same (kind, path) reuses the shared host',
  );
  assert.deepEqual(acquiredPaths, [pathA, pathB]);

  await manager.closeByExecutor('codex');
  // After a kind-wide close, the next acquire starts a fresh host.
  const clientA3 = await manager.getOrCreate('session-d', 'codex', { cliPath: pathA });
  assert.ok(clientA3 instanceof ProtocolV2SessionClient);
  assert.notEqual(clientA3.runtimeHost(), clientA.runtimeHost());
  assert.deepEqual(acquiredPaths, [pathA, pathB, pathA]);
  await manager.closeAll();
});
