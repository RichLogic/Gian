import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { Hono } from 'hono';
import test from 'node:test';
import type { AgentProxyDefaults, ProxyCatalog } from '@gian/shared';
import {
  AgentManager,
  assertOfficialInstallerIntegrity,
  parseArtifactChecksum,
  parseReleaseAssetDigests,
} from '../src/agents/manager.js';
import {
  acquireAgentProxyUpdateLock,
  acquireAgentRuntimeUseLock,
  acquireAgentUpdateLock,
  AgentUpdateBusyError,
  type AgentUpdateLease,
} from '../src/agents/update-lock.js';
import { CliRuntimeManager } from '../src/runtime/manager.js';
import { runProtectedCommand } from '../src/runtime/protected-command.js';
import { ProxyManager } from '../src/proxy/manager.js';
import { ProtocolV2Client } from '../src/proxy/protocol-v2-client.js';
import {
  ProtocolV2Host,
  ProtocolV2SessionClient,
} from '../src/proxy/protocol-v2-session-client.js';
import {
  createProxyProcessShutdownState,
  shutdownProxyProcess,
} from '../src/proxy/process-shutdown.js';
import { registerAgentRoutes } from '../src/web/routes/agents.js';

const PROTOCOL_V2 = {
  claudeProxy: { pluginVersion: '0.2.0', processScope: 'session' as const },
  codexProxy: { pluginVersion: '0.2.0', processScope: 'shared' as const },
  kimiProxy: { pluginVersion: '0.2.0', processScope: 'shared' as const },
  grokProxy: { pluginVersion: '0.3.0', processScope: 'session' as const },
};

const PROTOCOL_V2_STDIO_BOOT = `
      const reply = (request, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
      const fail = (request, error) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error }) + '\\n');
      if (request.method === 'initialize') {
        const pluginId = process.env.GIAN_PLUGIN_ID || 'claude';
        reply(request, {
          protocol: { name: 'gian.proxy', version: '2.0' },
          plugin: { id: pluginId, name: pluginId, version: pluginId === 'grok' ? '0.3.0' : '0.2.0' },
          process: { scope: pluginId === 'codex' || pluginId === 'kimi' ? 'shared' : 'session' },
          capabilities: {},
        });
        continue;
      }
      if (request.method === 'catalog.list') {
        reply(request, { catalogRevision: 'test', input: [{ type: 'text' }], configOptions: [], slashCommands: [] });
        continue;
      }
`;

const execFileAsync = promisify(execFile);

function errorTreeIncludes(error: unknown, pattern: RegExp): boolean {
  if (pattern.test(String(error))) return true;
  return error instanceof AggregateError
    && error.errors.some(item => errorTreeIncludes(item, pattern));
}

async function waitForChildOutput(
  child: ChildProcess,
  expected: RegExp,
  label: string,
  timeoutMs = 15_000,
): Promise<string> {
  if (!child.stdout) throw new Error(`${label} has no readable stdout.`);
  const stdout = child.stdout;
  const stderr = child.stderr;
  return await new Promise<string>((resolve, reject) => {
    let output = '';
    let errorOutput = '';
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`${label} did not become ready within ${timeoutMs}ms.`));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      stdout.off('data', onData);
      stdout.off('error', onStreamError);
      stderr?.off('data', onStderr);
      child.off('error', onChildError);
      child.off('close', onClose);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(output);
    };
    const onData = (chunk: Buffer | string) => {
      output += chunk.toString();
      expected.lastIndex = 0;
      if (expected.test(output)) finish();
    };
    const onStderr = (chunk: Buffer | string) => {
      errorOutput = `${errorOutput}${chunk.toString()}`.slice(-4_096);
    };
    const onStreamError = (error: Error) => {
      finish(new Error(`${label} stdout failed: ${error.message}`, { cause: error }));
    };
    const onChildError = (error: Error) => {
      finish(new Error(`${label} failed to start: ${error.message}`, { cause: error }));
    };
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      const diagnostic = errorOutput.trim();
      finish(new Error(
        `${label} exited before readiness (code=${String(code)}, signal=${String(signal)})`
        + (diagnostic ? `: ${diagnostic}` : '.'),
      ));
    };

    stdout.on('data', onData);
    stdout.once('error', onStreamError);
    stderr?.on('data', onStderr);
    child.once('error', onChildError);
    child.once('close', onClose);
  });
}

test('subprocess readiness wait rejects when the child exits before output', async () => {
  const child = spawn(process.execPath, ['--eval', 'process.exitCode = 7'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await assert.rejects(
    waitForChildOutput(child, /READY/, 'early-exit fixture'),
    /early-exit fixture exited before readiness \(code=7, signal=null\)/,
  );
});

function proxyPluginMeta(id: string): { displayName: string; processScope: 'session' | 'shared' } {
  if (id === 'codex') return { displayName: 'Codex', processScope: 'shared' };
  if (id === 'kimi') return { displayName: 'Kimi Code', processScope: 'shared' };
  if (id === 'grok') return { displayName: 'Grok Build', processScope: 'session' };
  return { displayName: 'Claude Code', processScope: 'session' };
}

function proxyManifest(id: string, version: string) {
  const meta = proxyPluginMeta(id);
  return {
    schemaVersion: 2,
    id,
    displayName: meta.displayName,
    pluginVersion: version,
    entry: 'proxy.mjs',
    protocol: { name: 'gian.proxy', range: '>=2.0 <3.0' },
    process: { scope: meta.processScope },
  };
}

function proxySource(
  id: string,
  version: string,
  ok = true,
  protocolCompatible = true,
  requireManagedEnv = false,
  omittedMethod?: string,
): string {
  const meta = proxyPluginMeta(id);
  const protocolVersion = protocolCompatible ? '2.0' : '9.0';
  const omitCatalog = omittedMethod === 'catalog.list';
  return `
import { createInterface } from 'node:readline';
if (process.argv.includes('--self-test')) {
  process.stdout.write(${JSON.stringify(`${JSON.stringify({ schemaVersion: 2, id, pluginVersion: version, ok })}\n`)});
} else {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    const request = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    const fail = (code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code, message } }) + '\\n');
    if (request.method === 'initialize') {
      const envOk = ${String(!requireManagedEnv)} || (
        process.env.DISABLE_AUTOUPDATER === '1' && process.env.DISABLE_UPDATES === '1'
      );
      if (!envOk) {
        fail(-32602, 'unsafe-env');
      } else {
        reply({
          protocol: { name: 'gian.proxy', version: ${JSON.stringify(protocolVersion)} },
          plugin: {
            id: ${JSON.stringify(id)},
            name: ${JSON.stringify(meta.displayName)},
            version: ${JSON.stringify(version)},
          },
          process: { scope: ${JSON.stringify(meta.processScope)} },
          capabilities: {},
        });
      }
    } else if (request.method === 'catalog.list') {
      ${omitCatalog
        ? "fail(-32601, 'Method not found');"
        : "reply({ catalogRevision: 'probe', input: [{ type: 'text' }], configOptions: [], slashCommands: [] });"}
    } else if (request.method === 'shutdown') {
      reply({ ok: true });
    } else {
      fail(-32601, 'Method not found');
      continue;
    }
    if (request.method === 'shutdown') break;
  }
}
`;
}

async function writeProxyVersion(
  dataDir: string,
  id: string,
  version: string,
  ok = true,
): Promise<string> {
  const directory = join(dataDir, 'plugins', id, version);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'proxy.mjs'), proxySource(id, version, ok));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(proxyManifest(id, version)));
  return directory;
}

async function writeFakeCli(root: string, id: string): Promise<string> {
  const path = join(root, `${id}-cli`);
  await writeFile(path, `#!/bin/sh\nprintf '${id} 1.2.3\\n'\n`, { mode: 0o700 });
  return path;
}

async function proxyArchive(
  root: string,
  id: string,
  version: string,
  ok = true,
  protocolCompatible = true,
  requireManagedEnv = false,
  omittedMethod?: string,
): Promise<{ archive: Buffer; filename: string; checksum: string }> {
  const fixture = join(root, `fixture-${version}`);
  await mkdir(fixture, { recursive: true });
  await writeFile(
    join(fixture, 'proxy.mjs'),
    proxySource(id, version, ok, protocolCompatible, requireManagedEnv, omittedMethod),
  );
  await writeFile(join(fixture, 'manifest.json'), JSON.stringify(proxyManifest(id, version)));
  const filename = `gian-proxy-${id}-${version}-darwin-arm64.tar.gz`;
  const archivePath = join(root, filename);
  await execFileAsync('/usr/bin/tar', ['-czf', archivePath, '-C', fixture, '.']);
  const archive = await readFile(archivePath);
  return {
    archive,
    filename,
    checksum: createHash('sha256').update(archive).digest('hex'),
  };
}

function proxyReleaseFetch(
  artifact: { archive: Buffer; filename: string; checksum: string },
): typeof fetch {
  const checksumBody = Buffer.from(`${artifact.checksum}  ${artifact.filename}\n`);
  const checksumDigest = createHash('sha256').update(checksumBody).digest('hex');
  return async input => {
    const url = String(input);
    if (url.startsWith('https://api.github.com/')) {
      return new Response(JSON.stringify({
        tag_name: 'v0.1.0',
        assets: [
          { name: artifact.filename, digest: `sha256:${artifact.checksum}` },
          { name: `${artifact.filename}.sha256`, digest: `sha256:${checksumDigest}` },
        ],
      }));
    }
    return url.endsWith('.sha256')
      ? new Response(checksumBody)
      : new Response(artifact.archive);
  };
}

test('Proxy checksum parser binds integrity to the exact immutable asset name', () => {
  const expected = 'a'.repeat(64);
  const unrelated = 'b'.repeat(64);
  assert.equal(parseArtifactChecksum(
    `${unrelated}  other.tar.gz\n${expected} *gian-proxy-claude-1.0.0-darwin-arm64.tar.gz\n`,
    'gian-proxy-claude-1.0.0-darwin-arm64.tar.gz',
  ), expected);
  assert.throws(
    () => parseArtifactChecksum(`${unrelated}  other.tar.gz\n`, 'expected.tar.gz'),
    /expected asset/i,
  );
});

test('official installer bootstrap is pinned before Gian executes it', () => {
  const script = Buffer.from('#!/bin/sh\nprintf ready\\n\n');
  const digest = createHash('sha256').update(script).digest('hex');
  assert.doesNotThrow(() => assertOfficialInstallerIntegrity(script, digest));
  assert.throws(
    () => assertOfficialInstallerIntegrity(Buffer.from(`${script.toString()}# changed\n`), digest),
    /changed and has not been reviewed/i,
  );
});

test('pinned official installer runs with vendor updater isolation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-official-installer-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = join(root, 'home');
  const cliPath = join(homeDir, '.local', 'bin', 'claude');
  const proxyPath = join(root, 'proxy.mjs');
  await writeFile(proxyPath, 'export {};\n');
  const installer = Buffer.from([
    '#!/bin/sh',
    'set -eu',
    'test "$NON_INTERACTIVE" = "1"',
    'test "$DISABLE_AUTOUPDATER" = "1"',
    'test "$DISABLE_UPDATES" = "1"',
    `mkdir -p ${JSON.stringify(dirname(cliPath))}`,
    `printf '%s\\n' '#!/bin/sh' "printf '%s\\\\n' 'claude 9.9.9'" > ${JSON.stringify(cliPath)}`,
    `chmod 700 ${JSON.stringify(cliPath)}`,
    '',
  ].join('\n'));
  const installerDigest = createHash('sha256').update(installer).digest('hex');
  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: {
      claude: proxyPath,
      codex: proxyPath,
      kimi: proxyPath,
      grok: proxyPath,
    },
    homeDir,
    pathEnv: '',
    fetchImpl: async () => new Response(installer),
    officialInstallerSha256: { claude: installerDigest },
  });

  const result = await manager.installOfficialCli('claude');
  assert.equal(result.agent.cli.state, 'ready');
  assert.equal(result.agent.cli.version, '9.9.9');
  assert.equal(result.agent.cli.path, cliPath);
});

for (const fixture of [
  { id: 'claude', relativePath: ['.local', 'bin', 'claude'], version: 'claude 9.9.1' },
  { id: 'codex', relativePath: ['.local', 'bin', 'codex'], version: 'codex-cli 9.9.2' },
  { id: 'kimi', relativePath: ['.kimi-code', 'bin', 'kimi'], version: 'kimi 9.9.3' },
] as const) {
  test(`official ${fixture.id} installer lands on its supported user path`, async t => {
    const root = await mkdtemp(join(tmpdir(), `gian-${fixture.id}-official-path-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const homeDir = join(root, 'home');
    const cliPath = join(homeDir, ...fixture.relativePath);
    const proxyPath = join(root, 'proxy.mjs');
    await writeFile(proxyPath, 'export {};\n');
    const installer = Buffer.from([
      '#!/bin/sh',
      'set -eu',
      'test "$NON_INTERACTIVE" = "1"',
      `mkdir -p "$HOME/${fixture.relativePath.slice(0, -1).join('/')}"`,
      `printf '%s\\n' '#!/bin/sh' "printf '%s\\\\n' '${fixture.version}'" > "$HOME/${fixture.relativePath.join('/')}"`,
      `chmod 700 "$HOME/${fixture.relativePath.join('/')}"`,
      '',
    ].join('\n'));
    const installerDigest = createHash('sha256').update(installer).digest('hex');
    const manager = await AgentManager.create({
      dataDir: join(root, 'data'),
      releaseVersion: '0.1.0',
      managedProxies: false,
      developmentProxyEntries: {
        claude: proxyPath,
        codex: proxyPath,
        kimi: proxyPath,
      },
      homeDir,
      pathEnv: '',
      fetchImpl: async () => new Response(installer),
      officialInstallerSha256: { [fixture.id]: installerDigest },
    });

    const result = await manager.installOfficialCli(fixture.id);
    assert.equal(result.agent.cli.state, 'ready');
    assert.equal(result.agent.cli.path, cliPath);
    assert.equal(result.agent.cli.source, 'official-user');
  });
}

test('install route cannot replace an in-use CLI and re-probes after the last lease drains', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-official-installer-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = join(root, 'home');
  const cliPath = join(homeDir, '.local', 'bin', 'claude');
  const proxyPath = join(root, 'proxy.mjs');
  await mkdir(dirname(cliPath), { recursive: true });
  await writeFile(cliPath, "#!/bin/sh\nprintf 'claude 1.0.0\\n'\n", { mode: 0o700 });
  await writeFile(proxyPath, 'export {};\n');
  const installer = Buffer.from([
    '#!/bin/sh',
    'set -eu',
    `printf '%s\\n' '#!/bin/sh' "printf 'claude 2.0.0\\\\n'" > ${JSON.stringify(cliPath)}`,
    `chmod 700 ${JSON.stringify(cliPath)}`,
    '',
  ].join('\n'));
  const installerDigest = createHash('sha256').update(installer).digest('hex');
  let fetchCalls = 0;
  const agents = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: {
      claude: proxyPath,
      codex: proxyPath,
      kimi: proxyPath,
      grok: proxyPath,
    },
    environmentCliPaths: { claude: cliPath },
    homeDir,
    pathEnv: '',
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(installer);
    },
    officialInstallerSha256: { claude: installerDigest },
  });
  const runtimes = new CliRuntimeManager(
    agents.runtimeProviders(),
    agents.updateLockDataDir(),
  );
  const oldLease = await runtimes.acquire('claude');
  assert.equal(oldLease.version, '1.0.0');

  const app = new Hono();
  registerAgentRoutes(app, {
    agents,
    runtimes,
    // The lease represents another Host, so closing this route's local Proxy
    // cannot release it.
    closeProxy: async () => undefined,
    capabilities: async () => ({ models: [], modes: [] }),
  });
  const blocked = await app.request('/api/agents/claude/install-cli', { method: 'POST' });
  assert.equal(blocked.status, 409);
  assert.equal(fetchCalls, 0, 'the installer script is not even downloaded while CLI use is active');
  assert.equal(
    (await execFileAsync(oldLease.binaryPath, [], { encoding: 'utf8' })).stdout.trim(),
    'claude 1.0.0',
  );

  await oldLease.release();
  const installed = await app.request('/api/agents/claude/install-cli', { method: 'POST' });
  assert.equal(installed.status, 200);
  assert.equal(fetchCalls, 1);
  const newLease = await runtimes.acquire('claude');
  assert.equal(newLease.binaryPath, oldLease.binaryPath);
  assert.equal(newLease.version, '2.0.0');
  await newLease.release();
});

test('runtime invalidation keeps a failed idle retirement strongly retryable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-invalidate-retirement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let manager!: CliRuntimeManager;
  let probeCalls = 0;
  let retirementReleaseCalls = 0;
  let firstReleaseStarted!: () => void;
  const firstReleasing = new Promise<void>(resolve => { firstReleaseStarted = resolve; });
  let allowFirstReleaseFailure!: () => void;
  const firstReleaseGate = new Promise<void>(resolve => { allowFirstReleaseFailure = resolve; });
  const provider = {
    id: 'claude' as const,
    async inspectInstalled() {
      return [{ cli: 'claude' as const, binaryPath: '/fake/claude', source: 'override' as const }];
    },
    async probe(runtime: { binaryPath: string }, protector: unknown) {
      probeCalls += 1;
      if (probeCalls === 1) {
        const claim = protector as { release(): Promise<void> };
        const release = claim.release.bind(claim);
        claim.release = async () => {
          retirementReleaseCalls += 1;
          if (retirementReleaseCalls === 1) {
            firstReleaseStarted();
            await firstReleaseGate;
            throw new Error('controlled idle retirement failure');
          }
          await release();
        };
        // First microtask lets resolve() publish ActiveRuntime; the nested one
        // invalidates before acquire() can increment its lease count.
        queueMicrotask(() => queueMicrotask(() => manager.invalidate('claude')));
      }
      return {
        cli: 'claude' as const,
        binaryPath: runtime.binaryPath,
        version: `${probeCalls}.0.0`,
        source: 'override' as const,
      };
    },
    managedEnv() { return {}; },
  };
  manager = new CliRuntimeManager([provider], root);

  const acquiring = manager.acquire('claude');
  const acquireRejected = assert.rejects(acquiring, /controlled idle retirement failure/);
  await firstReleasing;
  allowFirstReleaseFailure();
  await acquireRejected;
  assert.equal(retirementReleaseCalls, 1);
  await assert.rejects(
    acquireAgentUpdateLock(root, 'claude', 'exclusive writer'),
    (error: unknown) => error instanceof AgentUpdateBusyError,
  );

  await manager.drain('claude');
  assert.equal(retirementReleaseCalls, 2);
  const writer = await acquireAgentUpdateLock(root, 'claude', 'exclusive writer');
  await writer.release();
  const lease = await manager.acquire('claude');
  assert.equal(lease.version, '2.0.0');
  await lease.release();
});

test('failed runtime resolution keeps an unreleased claim visible to drain', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-resolution-retirement-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const claimDirectory = join(root, 'update-locks', 'agent-claude-claims');
  const provider = {
    id: 'claude' as const,
    async inspectInstalled() {
      await chmod(claimDirectory, 0o500);
      throw new Error('controlled runtime inspection failure');
    },
    async probe() {
      throw new Error('probe must not run');
    },
    managedEnv() { return {}; },
  };
  const manager = new CliRuntimeManager([provider], root);

  await assert.rejects(
    manager.acquire('claude'),
    (error: unknown) => error instanceof AggregateError
      && error.errors.some(item => /controlled runtime inspection failure/.test(String(item))),
  );
  await chmod(claimDirectory, 0o700);
  await assert.rejects(
    acquireAgentUpdateLock(root, 'claude', 'exclusive writer'),
    (error: unknown) => error instanceof AgentUpdateBusyError,
  );
  await manager.drain('claude');
  const writer = await acquireAgentUpdateLock(root, 'claude', 'exclusive writer');
  await writer.release();
});

test('real status --version probe blocks installer fetch and post-install status reuses writer', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-status-probe-writer-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDir = join(root, 'home');
  const cliPath = join(root, 'bin', 'claude');
  const probeStarted = join(root, 'probe-started');
  const probeRelease = join(root, 'probe-release');
  const proxyPath = join(root, 'proxy.mjs');
  await mkdir(dirname(cliPath), { recursive: true });
  await writeFile(cliPath, [
    '#!/bin/sh',
    `printf started > ${JSON.stringify(probeStarted)}`,
    `while [ ! -f ${JSON.stringify(probeRelease)} ]; do sleep 0.02; done`,
    "printf 'claude 1.0.0\\n'",
    '',
  ].join('\n'), { mode: 0o700 });
  await writeFile(proxyPath, 'export {};\n');
  const installer = Buffer.from([
    '#!/bin/sh',
    'set -eu',
    `printf '%s\\n' '#!/bin/sh' "printf 'claude 2.0.0\\\\n'" > ${JSON.stringify(cliPath)}`,
    `chmod 700 ${JSON.stringify(cliPath)}`,
    '',
  ].join('\n'));
  const installerDigest = createHash('sha256').update(installer).digest('hex');
  let fetchCalls = 0;
  const agents = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: {
      claude: proxyPath,
      codex: proxyPath,
      kimi: proxyPath,
      grok: proxyPath,
    },
    environmentCliPaths: { claude: cliPath },
    homeDir,
    pathEnv: '',
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(installer);
    },
    officialInstallerSha256: { claude: installerDigest },
  });
  const app = new Hono();
  registerAgentRoutes(app, {
    agents,
    runtimes: { drain: async () => undefined, invalidate: () => true } as never,
    closeProxy: async () => undefined,
    capabilities: async () => ({ models: [], modes: [] }),
  });

  const statusProbe = agents.status('claude', true);
  const markerDeadline = Date.now() + 3_000;
  while (Date.now() < markerDeadline) {
    try {
      await readFile(probeStarted);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  assert.equal(await readFile(probeStarted, 'utf8'), 'started');
  const blocked = await app.request('/api/agents/claude/install-cli', { method: 'POST' });
  assert.equal(blocked.status, 409);
  assert.equal(fetchCalls, 0, 'writer must fail before fetching while --version is running');

  await writeFile(probeRelease, 'go');
  assert.equal((await statusProbe).cli.version, '1.0.0');
  const installed = await Promise.race([
    app.request('/api/agents/claude/install-cli', { method: 'POST' }),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('post-install owner status self-locked')), 4_000);
    }),
  ]);
  assert.equal(installed.status, 200);
  assert.equal(fetchCalls, 1);
  const body = await installed.json() as { agent: { cli: { version: string } } };
  assert.equal(body.agent.cli.version, '2.0.0');
});

test('updateAgent rejects while the kind claim is busy and leaves agents.json untouched', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-set-cli-path-busy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldPath = await writeFakeCli(root, 'old-claude');
  const newPath = await writeFakeCli(root, 'new-claude');
  const proxyPath = join(root, 'proxy.mjs');
  await writeFile(proxyPath, 'export {};\n');
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const configPath = join(dataDir, 'agents.json');
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    cliPaths: { claude: oldPath },
    proxyDefaults: {},
  }, null, 2)}\n`);
  const agents = await AgentManager.create({
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: {
      claude: proxyPath,
      codex: proxyPath,
      kimi: proxyPath,
      grok: proxyPath,
    },
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  const agent = agents.listAgents().find(candidate => candidate.proxy === 'claude')!;
  const writer = await acquireAgentUpdateLock(
    agents.updateLockDataDir(),
    'claude',
    'blocking writer',
  );
  const persistedBefore = await readFile(configPath, 'utf8');
  try {
    await assert.rejects(
      agents.updateAgent(agent.id, { cliPath: newPath }),
      (error: unknown) => error instanceof AgentUpdateBusyError,
    );
    await assert.rejects(
      agents.createAgent({ name: 'Second Claude', proxy: 'claude', cliPath: newPath }),
      (error: unknown) => error instanceof AgentUpdateBusyError,
    );
    assert.equal(agents.getAgent(agent.id).cliPath, oldPath);
    assert.equal(await readFile(configPath, 'utf8'), persistedBefore);
    // Write-through updates (name/color/defaults) never queue behind the
    // kind updater — they only need the cross-Host config claim.
    const renamed = await agents.updateAgent(agent.id, { name: 'Renamed Claude' });
    assert.equal(renamed.name, 'Renamed Claude');
  } finally {
    await writer.release();
  }
});

test('updateAgent holds the kind claim from the path probe through persistence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-set-cli-path-transaction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldPath = await writeFakeCli(root, 'old-claude');
  const newPath = join(root, 'new-claude');
  const probeStarted = join(root, 'probe-started');
  const probeRelease = join(root, 'probe-release');
  await writeFile(newPath, `#!/bin/sh
: > '${probeStarted}'
while [ ! -f '${probeRelease}' ]; do sleep 0.02; done
printf 'claude 2.0.0\\n'
`, { mode: 0o700 });
  const proxyPath = join(root, 'proxy.mjs');
  await writeFile(proxyPath, 'export {};\n');
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const configPath = join(dataDir, 'agents.json');
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    cliPaths: { claude: oldPath },
    proxyDefaults: {},
  }, null, 2)}\n`);
  const agents = await AgentManager.create({
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: { claude: proxyPath, codex: proxyPath, kimi: proxyPath, grok: proxyPath, dsh: proxyPath },
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  const agent = agents.listAgents().find(candidate => candidate.proxy === 'claude')!;

  const updating = agents.updateAgent(agent.id, { cliPath: newPath });
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    try {
      await readFile(probeStarted);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  assert.equal(await readFile(probeStarted, 'utf8'), '');
  await assert.rejects(
    acquireAgentUpdateLock(agents.updateLockDataDir(), 'claude', 'racing installer'),
    (error: unknown) => error instanceof AgentUpdateBusyError,
  );
  await writeFile(probeRelease, 'go');
  const updated = await updating;
  assert.equal(updated.cliPath, newPath);
  const persisted = JSON.parse(await readFile(configPath, 'utf8')) as {
    schemaVersion: number;
    agents: Array<{ id: string; cliPath: string | null }>;
  };
  assert.equal(persisted.schemaVersion, 3);
  assert.equal(persisted.agents.find(candidate => candidate.id === agent.id)?.cliPath, newPath);
});

test('updateAgent leaves persisted state untouched when the path probe fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-set-cli-path-final-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldPath = await writeFakeCli(root, 'old-claude');
  const newPath = join(root, 'flaky-claude');
  await writeFile(newPath, "#!/bin/sh\nprintf 'broken\\n'\n", { mode: 0o700 });
  const proxyPath = join(root, 'proxy.mjs');
  await writeFile(proxyPath, 'export {};\n');
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const configPath = join(dataDir, 'agents.json');
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    cliPaths: { claude: oldPath },
    proxyDefaults: {},
  }, null, 2)}\n`);
  const persistedBefore = await readFile(configPath, 'utf8');
  const agents = await AgentManager.create({
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: { claude: proxyPath, codex: proxyPath, kimi: proxyPath, grok: proxyPath, dsh: proxyPath },
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  const agent = agents.listAgents().find(candidate => candidate.proxy === 'claude')!;
  const persistedAfterMigration = await readFile(configPath, 'utf8');

  await assert.rejects(
    agents.updateAgent(agent.id, { cliPath: newPath }),
    /did not report a semantic version/i,
  );
  assert.equal(agents.getAgent(agent.id).cliPath, oldPath);
  assert.equal(await readFile(configPath, 'utf8'), persistedAfterMigration);
  assert.notEqual(persistedAfterMigration, persistedBefore, 'migration itself persists v2');
});

test('updateAgent keeps a committed path when only claim retirement fails', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-set-cli-path-retirement-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const oldPath = await writeFakeCli(root, 'old-claude-retirement');
  const newPath = await writeFakeCli(root, 'new-claude-retirement');
  const proxyPath = join(root, 'proxy.mjs');
  await writeFile(proxyPath, 'export {};\n');
  const dataDir = join(root, 'data');
  await mkdir(dataDir, { recursive: true });
  const configPath = join(dataDir, 'agents.json');
  await writeFile(configPath, `${JSON.stringify({
    schemaVersion: 1,
    cliPaths: { claude: oldPath },
    proxyDefaults: {},
  }, null, 2)}\n`);
  const agents = await AgentManager.create({
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: { claude: proxyPath, codex: proxyPath, kimi: proxyPath, grok: proxyPath, dsh: proxyPath },
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  const agent = agents.listAgents().find(candidate => candidate.proxy === 'claude')!;
  const claimDirectory = join(
    agents.updateLockDataDir(),
    'update-locks',
    'agent-claude-claims',
  );
  const internals = agents as unknown as {
    saveConfig: (config: unknown) => Promise<void>;
  };
  const saveConfig = internals.saveConfig;
  internals.saveConfig = async config => {
    await Reflect.apply(saveConfig, agents, [config]);
    await chmod(claimDirectory, 0o500);
  };

  try {
    await assert.rejects(
      agents.updateAgent(agent.id, { cliPath: newPath }),
      (error: unknown) => error instanceof AggregateError,
    );
  } finally {
    internals.saveConfig = saveConfig;
    await chmod(claimDirectory, 0o700);
  }
  // Persistence is the commit point: a claim-retirement failure cannot roll
  // the new path back.
  assert.equal(agents.getAgent(agent.id).cliPath, newPath);
  const persisted = JSON.parse(await readFile(configPath, 'utf8')) as {
    agents: Array<{ id: string; cliPath: string | null }>;
  };
  assert.equal(persisted.agents.find(candidate => candidate.id === agent.id)?.cliPath, newPath);
});

test('committed Agent defaults invalidate cached status before claim retirement', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-proxy-defaults-retirement-failure-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cliPath = await writeFakeCli(root, 'claude-defaults');
  const proxyPath = join(root, 'proxy.mjs');
  await writeFile(proxyPath, 'export {};\n');
  const dataDir = join(root, 'data');
  const agents = await AgentManager.create({
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: false,
    developmentProxyEntries: { claude: proxyPath, codex: proxyPath, kimi: proxyPath, grok: proxyPath, dsh: proxyPath },
    environmentCliPaths: { claude: cliPath },
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  const agent = agents.listAgents().find(candidate => candidate.proxy === 'claude')!;
  const cached = await agents.status('claude', true);
  assert.equal(cached.proxy.defaults.mode, '');
  const claimDirectory = join(
    agents.updateLockDataDir(),
    'update-locks',
    'agent-__agent-config__-claims',
  );
  const internals = agents as unknown as {
    saveConfig: (config: unknown) => Promise<void>;
  };
  const saveConfig = internals.saveConfig;
  internals.saveConfig = async config => {
    await Reflect.apply(saveConfig, agents, [config]);
    await chmod(claimDirectory, 0o500);
  };

  try {
    await assert.rejects(agents.updateAgent(agent.id, { defaults: { mode: 'auto' } }));
  } finally {
    internals.saveConfig = saveConfig;
    await chmod(claimDirectory, 0o700);
  }
  assert.equal(agents.proxyDefaults('claude').mode, 'auto');
  const persisted = JSON.parse(await readFile(join(dataDir, 'agents.json'), 'utf8')) as {
    agents: Array<{ id: string; defaults: { mode: string } }>;
  };
  assert.equal(persisted.agents.find(candidate => candidate.id === agent.id)?.defaults.mode, 'auto');
  const refreshed = await agents.status('claude');
  assert.equal(refreshed.proxy.defaults.mode, 'auto');
});

test('config mutations serialize locally and a stale Host reloads before commit', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-config-mutation-serialization-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const homeDir = join(root, 'home');
  const proxyPath = join(root, 'proxy.mjs');
  await writeFile(proxyPath, 'export {};\n');
  const options = {
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: false as const,
    developmentProxyEntries: { claude: proxyPath, codex: proxyPath, kimi: proxyPath, grok: proxyPath, dsh: proxyPath },
    homeDir,
    pathEnv: '',
  };
  const firstHost = await AgentManager.create(options);
  const staleHost = await AgentManager.create(options);

  await Promise.all([
    firstHost.createAgent({ name: 'Claude A', proxy: 'claude' }),
    firstHost.createAgent({ name: 'Codex A', proxy: 'codex' }),
  ]);
  // The stale Host's in-memory config predates both creates; it must reload
  // under the cross-Host claim rather than overwrite the newer file.
  await staleHost.createAgent({ name: 'Kimi A', proxy: 'kimi' });

  const persisted = JSON.parse(await readFile(join(dataDir, 'agents.json'), 'utf8')) as {
    agents: Array<{ name: string; proxy: string }>;
  };
  assert.deepEqual(
    persisted.agents.map(agent => [agent.name, agent.proxy]),
    [['Claude A', 'claude'], ['Codex A', 'codex'], ['Kimi A', 'kimi']],
  );
});

test('GitHub release integrity binds both exact Proxy assets to SHA-256 digests', () => {
  const archive = 'a'.repeat(64);
  const checksum = 'b'.repeat(64);
  const digests = parseReleaseAssetDigests({
    tag_name: 'v0.1.0',
    assets: [
      { name: 'proxy.tar.gz', digest: `sha256:${archive}` },
      { name: 'proxy.tar.gz.sha256', digest: `sha256:${checksum}` },
    ],
  }, 'v0.1.0', ['proxy.tar.gz', 'proxy.tar.gz.sha256']);
  assert.equal(digests.get('proxy.tar.gz'), archive);
  assert.equal(digests.get('proxy.tar.gz.sha256'), checksum);
  assert.throws(
    () => parseReleaseAssetDigests({
      tag_name: 'v0.1.0',
      assets: [{ name: 'proxy.tar.gz', digest: `sha256:${archive}` }],
    }, 'v0.1.0', ['proxy.tar.gz', 'proxy.tar.gz.sha256']),
    /omitted integrity metadata/i,
  );
});

test('Agent update bakery lock excludes contenders, isolates agents, and reclaims safe dead v2 claims', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-agent-update-lock-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const first = await acquireAgentUpdateLock(dataDir, 'claude', 'official CLI install');
  await assert.rejects(
    acquireAgentUpdateLock(dataDir, 'claude', 'Proxy install'),
    (error: unknown) => error instanceof AgentUpdateBusyError
      && error.code === 'AGENT_UPDATE_BUSY'
      && /official CLI install/.test(error.message),
  );
  // A different Agent has a disjoint bakery and may update concurrently.
  const isolated = await acquireAgentUpdateLock(dataDir, 'codex', 'Proxy install');
  await isolated.release();
  await first.release();
  const second = await acquireAgentUpdateLock(dataDir, 'claude', 'Proxy install');
  await second.release();

  const claims = join(dataDir, 'update-locks', 'agent-kimi-claims');
  await mkdir(claims, { recursive: true });
  await writeFile(join(claims, 'claim-dead-owner'), JSON.stringify({
    schemaVersion: 2,
    token: 'dead-owner',
    pid: 2_147_483_647,
    processIdentity: 'darwin:never',
    operation: 'abandoned update',
    scope: 'cli-update',
    createdAt: new Date(0).toISOString(),
    choosing: false,
    ticket: 1,
  }), { mode: 0o600 });

  // Contenders may all observe the same dead claim, but each ever removes
  // only that unique path. Exactly one bakery participant can enter.
  const attempts = await Promise.allSettled(Array.from({ length: 6 }, (_, index) => (
    acquireAgentUpdateLock(dataDir, 'kimi', `contender ${index}`)
  )));
  const winners = attempts.filter(
    (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof acquireAgentUpdateLock>>> => (
      result.status === 'fulfilled'
    ),
  );
  assert.equal(winners.length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 5);
  for (const result of attempts) {
    if (result.status === 'rejected') assert.equal(result.reason.code, 'AGENT_UPDATE_BUSY');
  }
  await winners[0]!.value.release();
  const reclaimed = await acquireAgentUpdateLock(dataDir, 'kimi', 'post-race check');
  await reclaimed.release();

  const deadLegacyPath = join(claims, 'claim-dead-legacy-owner');
  await symlink(JSON.stringify({
    schemaVersion: 1,
    token: 'dead-legacy-owner',
    pid: 2_147_483_647,
    processIdentity: 'darwin:never',
    operation: 'legacy updater requiring repair',
    createdAt: new Date(0).toISOString(),
    choosing: false,
    ticket: 1,
  }), deadLegacyPath);
  await assert.rejects(
    acquireAgentUpdateLock(dataDir, 'kimi', 'unsafe legacy recovery'),
    (error: unknown) => error instanceof AgentUpdateBusyError
      && error.operation === 'legacy updater requiring repair',
  );
  await rm(deadLegacyPath);
});

test('v2 reservation refuses live-group release and is rejected by a v1 parser', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-agent-v2-protected-group-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const lease = await acquireAgentRuntimeUseLock(dataDir, 'claude', 'protected runtime');
  const reservation = await lease.reserveProcessGroup();
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    "process.stdout.write('READY\\n'); setInterval(() => {}, 1_000);",
  ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
  });
  await waitForChildOutput(child, /READY/, 'v2 protected-group child');
  assert.ok(child.pid);
  await reservation.register(child.pid!);

  const claimDirectory = join(dataDir, 'update-locks', 'agent-claude-claims');
  const [claimName] = (await readdir(claimDirectory)).filter(name => name.startsWith('claim-'));
  const claimPath = join(claimDirectory, claimName!);
  const claim = JSON.parse(await readFile(claimPath, 'utf8')) as {
    schemaVersion: number;
    protectedProcessGroups?: unknown[];
  };
  assert.equal(claim.schemaVersion, 2);
  assert.equal(claim.protectedProcessGroups?.length, 1);
  await assert.rejects(
    readlink(claimPath),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EINVAL',
  );

  await assert.rejects(reservation.release(), /ESRCH was not observed/);
  await assert.rejects(lease.release(), /protected process groups remain/);
  process.kill(-child.pid!, 'SIGKILL');
  await once(child, 'exit');
  await reservation.release();
  await lease.release();
});

test('v2 regular-file claims scale across many groups and failed mutation is retryable', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-agent-large-v2-claim-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const lease = await acquireAgentRuntimeUseLock(dataDir, 'claude', 'many protected groups');
  const claimDirectory = join(dataDir, 'update-locks', 'agent-claude-claims');

  // Make one atomic replacement fail. The in-memory state must remain equal
  // to the last published file so the lease is still usable and releasable.
  await chmod(claimDirectory, 0o500);
  try {
    await assert.rejects(lease.reserveProcessGroup());
  } finally {
    await chmod(claimDirectory, 0o700);
  }

  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    "process.stdout.write('READY\\n'); setInterval(() => {}, 1_000);",
  ], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const childExit = once(child, 'exit');
  t.after(() => {
    if (child.pid !== undefined) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
  });
  await waitForChildOutput(child, /READY/, 'v2 multi-reservation child');
  assert.ok(child.pid);

  const reservations = [];
  for (let index = 0; index < 32; index += 1) {
    const reservation = await lease.reserveProcessGroup();
    assert.equal(await reservation.register(child.pid!), 'registered');
    reservations.push(reservation);
  }
  const [claimName] = (await readdir(claimDirectory)).filter(name => name.startsWith('claim-'));
  const claimPath = join(claimDirectory, claimName!);
  const metadata = await lstat(claimPath);
  assert.equal(metadata.isFile(), true);
  assert.ok(metadata.size > 1_024, 'claim should exceed the former symlink target limit');
  await assert.rejects(
    readlink(claimPath),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'EINVAL',
    'a v1 Host must reject the v2 regular-file representation',
  );

  process.kill(-child.pid!, 'SIGKILL');
  await childExit;
  await Promise.all(reservations.map(reservation => reservation.release()));
  await lease.release();
});

test('protected commands tolerate clean exit before PGID registration', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-agent-fast-exit-command-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const lease = await acquireAgentRuntimeUseLock(dataDir, 'claude', 'fast command probe');

  // Exercise the real claim implementation repeatedly: /usr/bin/true often
  // exits before ps can capture its leader identity. The pending marker must
  // survive until child completion and a second PGID ESRCH proof, but a clean
  // command must not be misclassified as a failed probe.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const result = await runProtectedCommand({
      command: '/usr/bin/true',
      args: [],
      env: process.env,
      timeoutMs: 2_000,
      maxBuffer: 1_024,
      label: 'immediate exit probe',
      protector: lease,
    });
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }

  await lease.release();
  const claimDirectory = join(dataDir, 'update-locks', 'agent-claude-claims');
  assert.deepEqual(
    (await readdir(claimDirectory)).filter(name => name.startsWith('claim-')),
    [],
  );
});

test('an already-empty protected command never enters a signalling shutdown path', {
  skip: process.platform === 'win32',
}, async () => {
  let signalPathCalls = 0;
  let releaseUnregisteredCalls = 0;
  const result = await runProtectedCommand({
    command: process.execPath,
    args: ['--eval', 'process.exit(0)'],
    env: process.env,
    timeoutMs: 2_000,
    maxBuffer: 1_024,
    label: 'known-empty command probe',
    protector: {
      async reserveProcessGroup() {
        return {
          async register() { return 'already-empty' as const; },
          async cancelBeforeSpawn() { assert.fail('spawn already occurred'); },
          async releaseUnregistered(groupId: number) {
            assert.ok(groupId > 0);
            releaseUnregisteredCalls += 1;
          },
          async release() { assert.fail('the group was never registered'); },
        };
      },
    },
    async shutdownProcess() {
      signalPathCalls += 1;
    },
  });

  assert.deepEqual(result, { stdout: '', stderr: '' });
  assert.equal(signalPathCalls, 0);
  assert.equal(releaseUnregisteredCalls, 1);
});

test('protected commands include stdio data delivered after leader exit', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async () => {
  const source = `
    const { spawn } = require('node:child_process');
    spawn(process.execPath, ['-e', ${JSON.stringify(
      "setTimeout(() => process.stdout.write('tail'), 60)",
    )}], { stdio: ['ignore', 1, 2] });
    process.stdout.write('head:');
    process.exit(0);
  `;
  const result = await runProtectedCommand({
    command: process.execPath,
    args: ['-e', source],
    env: process.env,
    timeoutMs: 2_000,
    maxBuffer: 1_024,
    label: 'late stdio probe',
  });
  assert.equal(result.stdout, 'head:tail');
  assert.equal(result.stderr, '');
});

test('v2 claim rejects the 1025th outstanding reservation transactionally', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-agent-v2-reservation-limit-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const lease = await acquireAgentRuntimeUseLock(dataDir, 'claude', 'reservation limit');
  const reservations = [];
  for (let index = 0; index < 1_024; index += 1) {
    reservations.push(await lease.reserveProcessGroup());
  }
  const claimDirectory = join(dataDir, 'update-locks', 'agent-claude-claims');
  const [claimName] = (await readdir(claimDirectory)).filter(name => name.startsWith('claim-'));
  const claimPath = join(claimDirectory, claimName!);
  const before = await readFile(claimPath, 'utf8');
  await assert.rejects(
    lease.reserveProcessGroup(),
    /cannot protect more than 1024 process groups/,
  );
  assert.equal(await readFile(claimPath, 'utf8'), before, 'rejection must not mutate the claim');

  await Promise.all(reservations.map(reservation => reservation.cancelBeforeSpawn()));
  await lease.release();
});

test('scoped Agent claims allow readers and Proxy probes but exclude CLI mutation', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-agent-scoped-lock-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  const firstRuntime = await acquireAgentRuntimeUseLock(dataDir, 'claude', 'Host A runtime');
  const secondRuntime = await acquireAgentRuntimeUseLock(dataDir, 'claude', 'Host B runtime');
  const proxyUpdate = await acquireAgentProxyUpdateLock(dataDir, 'claude', 'Proxy install');
  await assert.rejects(
    acquireAgentUpdateLock(dataDir, 'claude', 'official CLI install'),
    (error: unknown) => error instanceof AgentUpdateBusyError
      && /Host [AB] runtime/.test(error.operation),
  );

  await proxyUpdate.release();
  await firstRuntime.release();
  await assert.rejects(
    acquireAgentUpdateLock(dataDir, 'claude', 'official CLI install'),
    (error: unknown) => error instanceof AgentUpdateBusyError
      && error.operation === 'Host B runtime',
  );
  await secondRuntime.release();

  const cliUpdate = await acquireAgentUpdateLock(dataDir, 'claude', 'official CLI install');
  await assert.rejects(
    acquireAgentRuntimeUseLock(dataDir, 'claude', 'late runtime'),
    (error: unknown) => error instanceof AgentUpdateBusyError,
  );
  await assert.rejects(
    acquireAgentProxyUpdateLock(dataDir, 'claude', 'late Proxy update'),
    (error: unknown) => error instanceof AgentUpdateBusyError,
  );
  await cliUpdate.release();

  const legacyDirectory = join(dataDir, 'update-locks', 'agent-claude-claims');
  const processIdentity = process.platform === 'darwin' || process.platform === 'linux'
    ? `${process.platform}:${String((await execFileAsync('/bin/ps', [
      '-p', String(process.pid), '-o', 'lstart=',
      ], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C', LANG: 'C', TZ: 'UTC' },
      })).stdout).trim().replace(/\s+/g, ' ')}`
    : `pid:${process.pid}`;
  const legacyPath = join(legacyDirectory, 'claim-legacy-host');
  await symlink(JSON.stringify({
    schemaVersion: 1,
    token: 'legacy-host',
    pid: process.pid,
    processIdentity,
    operation: 'legacy updater',
    createdAt: new Date().toISOString(),
    choosing: false,
    ticket: 1,
  }), legacyPath);
  await assert.rejects(
    acquireAgentRuntimeUseLock(dataDir, 'claude', 'new Host runtime'),
    (error: unknown) => error instanceof AgentUpdateBusyError
      && error.operation === 'legacy updater',
  );
  await assert.rejects(
    acquireAgentProxyUpdateLock(dataDir, 'claude', 'new Proxy update'),
    (error: unknown) => error instanceof AgentUpdateBusyError
      && error.operation === 'legacy updater',
  );
  await rm(legacyPath);
});

test('Agent update lease excludes another Host process and recovers its crashed claim', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-agent-update-process-lock-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/agents/update-lock.ts', import.meta.url).href;
  const holderScript = `
    import { acquireAgentUpdateLock } from ${JSON.stringify(moduleUrl)};
    const lease = await acquireAgentUpdateLock(process.env.LOCK_DATA_DIR, 'claude', 'holder process');
    process.stdout.write('ACQUIRED\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
    await lease.release();
  `;
  const holder = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', holderScript,
  ], {
    env: { ...process.env, LOCK_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (holder.exitCode === null) holder.kill('SIGKILL'); });
  const holderOutput = await waitForChildOutput(
    holder,
    /ACQUIRED/,
    'agent update lease holder',
  );
  assert.match(holderOutput, /ACQUIRED/);
  assert.equal(holder.exitCode, null);

  const contenderScript = `
    import { acquireAgentUpdateLock } from ${JSON.stringify(moduleUrl)};
    try {
      const lease = await acquireAgentUpdateLock(process.env.LOCK_DATA_DIR, 'claude', 'contender process');
      await lease.release();
      process.stdout.write('ACQUIRED\\n');
    } catch (error) {
      process.stdout.write(String(error?.code ?? error?.message) + '\\n');
    }
  `;
  const contender = await execFileAsync(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', contenderScript,
  ], {
    env: { ...process.env, LOCK_DATA_DIR: dataDir },
    encoding: 'utf8',
  });
  assert.match(String(contender.stdout), /AGENT_UPDATE_BUSY/);

  holder.kill('SIGKILL');
  await once(holder, 'exit');
  const recovered = await acquireAgentUpdateLock(dataDir, 'claude', 'crash recovery');
  await recovered.release();
});

test('dead Host claim remains busy until its registered detached process group is empty', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-agent-protected-host-crash-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/agents/update-lock.ts', import.meta.url).href;
  const protectedChild = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    "process.stdout.write('READY\\n'); setInterval(() => {}, 1_000);",
  ], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await waitForChildOutput(protectedChild, /READY/, 'protected orphan process group');
  const protectedGroup = protectedChild.pid;
  assert.ok(protectedGroup);
  const holderScript = `
    import { acquireAgentRuntimeUseLock } from ${JSON.stringify(moduleUrl)};
    const lease = await acquireAgentRuntimeUseLock(
      process.env.LOCK_DATA_DIR,
      'claude',
      'crashed Host protected runtime',
    );
    const reservation = await lease.reserveProcessGroup();
    const protectedGroup = Number(process.env.PROTECTED_GROUP);
    await reservation.register(protectedGroup);
    process.stdout.write('ACQUIRED ' + protectedGroup + '\\n');
    setInterval(() => {}, 1_000);
  `;
  const holder = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', holderScript,
  ], {
    env: {
      ...process.env,
      LOCK_DATA_DIR: dataDir,
      PROTECTED_GROUP: String(protectedGroup),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (holder.exitCode === null) holder.kill('SIGKILL');
    if (protectedChild.exitCode === null && protectedChild.signalCode === null) {
      try { process.kill(-protectedGroup, 'SIGKILL'); } catch { /* already stopped */ }
    }
  });
  const output = await waitForChildOutput(
    holder,
    /ACQUIRED \d+/,
    'protected process-group holder',
  );
  assert.equal(Number(output.match(/ACQUIRED (\d+)/)?.[1]), protectedGroup);

  holder.kill('SIGKILL');
  await once(holder, 'exit');
  await assert.rejects(
    acquireAgentUpdateLock(dataDir, 'claude', 'writer while orphan group lives'),
    (error: unknown) => error instanceof AgentUpdateBusyError
      && error.operation === 'crashed Host protected runtime',
  );

  const protectedChildExit = once(protectedChild, 'exit');
  process.kill(-protectedGroup, 'SIGKILL');
  await protectedChildExit;
  const deadline = Date.now() + 3_000;
  let groupIsEmpty = false;
  while (Date.now() < deadline) {
    try {
      process.kill(-protectedGroup, 0);
      await new Promise(resolve => setTimeout(resolve, 20));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        groupIsEmpty = true;
        break;
      }
      throw error;
    }
  }
  assert.equal(groupIsEmpty, true, 'the reaped child process group must become empty');
  const writer = await acquireAgentUpdateLock(
    dataDir,
    'claude',
    'writer after protected group exit',
  );
  await writer.release();
});

test('dead Host pending-spawn claim is fail-closed for explicit repair', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-agent-pending-host-crash-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/agents/update-lock.ts', import.meta.url).href;
  const holderScript = `
    import { acquireAgentRuntimeUseLock } from ${JSON.stringify(moduleUrl)};
    const lease = await acquireAgentRuntimeUseLock(
      process.env.LOCK_DATA_DIR,
      'codex',
      'crashed Host pending spawn',
    );
    await lease.reserveProcessGroup();
    process.stdout.write('PENDING\\n');
    setInterval(() => {}, 1_000);
  `;
  const holder = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', holderScript,
  ], {
    env: { ...process.env, LOCK_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (holder.exitCode === null) holder.kill('SIGKILL'); });
  await waitForChildOutput(holder, /PENDING/, 'pending-spawn holder');
  holder.kill('SIGKILL');
  await once(holder, 'exit');
  await assert.rejects(
    acquireAgentUpdateLock(dataDir, 'codex', 'automatic pending recovery'),
    (error: unknown) => error instanceof AgentUpdateBusyError
      && error.operation === 'crashed Host pending spawn',
  );
});

test('shared runtime claims coexist across Host processes and drain before CLI update', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'gian-agent-runtime-process-lock-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const moduleUrl = new URL('../src/agents/update-lock.ts', import.meta.url).href;
  const holderScript = `
    import { acquireAgentRuntimeUseLock } from ${JSON.stringify(moduleUrl)};
    const lease = await acquireAgentRuntimeUseLock(
      process.env.LOCK_DATA_DIR,
      'claude',
      'other Host runtime',
    );
    process.stdout.write('ACQUIRED\\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
    await lease.release();
  `;
  const holder = spawn(process.execPath, [
    '--import', 'tsx', '--input-type=module', '--eval', holderScript,
  ], {
    env: { ...process.env, LOCK_DATA_DIR: dataDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { if (holder.exitCode === null) holder.kill('SIGKILL'); });
  const holderOutput = await waitForChildOutput(
    holder,
    /ACQUIRED/,
    'shared runtime lease holder',
  );
  assert.match(holderOutput, /ACQUIRED/);

  const localRuntime = await acquireAgentRuntimeUseLock(dataDir, 'claude', 'local Host runtime');
  await assert.rejects(
    acquireAgentUpdateLock(dataDir, 'claude', 'official CLI install'),
    (error: unknown) => error instanceof AgentUpdateBusyError,
  );
  await localRuntime.release();
  await assert.rejects(
    acquireAgentUpdateLock(dataDir, 'claude', 'official CLI install'),
    (error: unknown) => error instanceof AgentUpdateBusyError
      && error.operation === 'other Host runtime',
  );

  holder.stdin.end('release\n');
  await once(holder, 'exit');
  const updater = await acquireAgentUpdateLock(dataDir, 'claude', 'official CLI install');
  await updater.release();
});

test('Proxy shutdown escalates an acknowledged child that refuses to exit', async t => {
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    `
      process.on('SIGTERM', () => {});
      process.stdout.write('READY\\n');
      setInterval(() => {}, 1_000);
    `,
  ], {
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (child.pid !== undefined && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
  });
  const ready = await waitForChildOutput(child, /READY/, 'controlled Proxy child');
  assert.match(ready, /READY/);
  let exited = false;
  let exitSignal: NodeJS.Signals | null = null;
  child.once('exit', (_code, signal) => {
    exited = true;
    exitSignal = signal;
  });
  const startedAt = Date.now();
  await shutdownProxyProcess({
    child,
    isExited: () => exited,
    requestShutdown: async () => ({ ok: true }),
    label: 'controlled Proxy',
  });
  assert.equal(exited, true);
  assert.equal(exitSignal, 'SIGKILL');
  assert.ok(Date.now() - startedAt < 3_000, 'shutdown escalation must remain bounded');
});

test('Proxy shutdown waits for PGID emptiness after a graceful leader exit', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async t => {
  const stubbornGrandchild = `
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1_000);
  `;
  const leader = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    `
      import { spawn } from 'node:child_process';
      const grandchild = spawn(process.execPath, [
        '--input-type=module', '--eval', ${JSON.stringify(stubbornGrandchild)},
      ], { detached: false, stdio: 'ignore' });
      process.stdout.write('READY ' + grandchild.pid + '\\n');
      process.stdin.once('data', () => process.exit(0));
    `,
  ], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => {
    if (leader.pid !== undefined) {
      try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* already stopped */ }
    }
  });
  const ready = await waitForChildOutput(
    leader,
    /READY \d+/,
    'graceful Proxy leader',
  );
  assert.match(ready, /READY \d+/);
  let exited = false;
  leader.once('exit', () => { exited = true; });

  await shutdownProxyProcess({
    child: leader,
    isExited: () => exited,
    requestShutdown: async () => {
      leader.stdin.end('shutdown\n');
      return { ok: true };
    },
    label: 'graceful leader with stubborn grandchild',
  });
  assert.equal(exited, true);
  assert.ok(leader.pid);
  assert.throws(
    () => process.kill(-leader.pid!, 0),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH',
  );
});

test('Proxy shutdown does not treat an absent PGID as a live leader exit', async () => {
  let exited = false;
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  const fakeChild = {
    pid: 2_147_483_647,
    kill(signal?: NodeJS.Signals | number) {
      signals.push(signal);
      exited = true;
      return true;
    },
  };
  await shutdownProxyProcess({
    child: fakeChild as never,
    isExited: () => exited,
    label: 'direct-child fallback',
  });
  assert.deepEqual(signals, ['SIGTERM']);
});

test('a shutdown retry never signals a live PGID after prior escalation', async () => {
  const groupSignals: NodeJS.Signals[] = [];
  const childSignals: NodeJS.Signals[] = [];
  const state = createProxyProcessShutdownState();
  let leaderExited = false;
  let groupEmpty = false;
  const input = {
    child: {
      pid: 424_242,
      kill(signal: NodeJS.Signals) {
        childSignals.push(signal);
        return true;
      },
    },
    isExited: () => leaderExited,
    label: 'reused PGID test',
    state,
    probeProcessGroupEmpty: () => groupEmpty,
    signalProcessGroup: (_groupId: number, signal: NodeJS.Signals) => {
      groupSignals.push(signal);
    },
  };

  await assert.rejects(
    shutdownProxyProcess(input),
    /did not exit after shutdown escalation/,
  );
  assert.deepEqual(groupSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(childSignals, ['SIGTERM', 'SIGKILL']);

  // The original leader is gone, while a live group now has the same numeric
  // id. A retry may verify only; signalling again could kill unrelated work.
  leaderExited = true;
  await assert.rejects(
    shutdownProxyProcess(input),
    /refusing to signal a potentially reused PGID/,
  );
  assert.deepEqual(groupSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(childSignals, ['SIGTERM', 'SIGKILL']);

  groupEmpty = true;
  await shutdownProxyProcess(input);
  assert.deepEqual(groupSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepEqual(childSignals, ['SIGTERM', 'SIGKILL']);
});

test('observed process-tree absence permanently disables signalling for a reused PGID', async () => {
  const groupSignals: NodeJS.Signals[] = [];
  const childSignals: NodeJS.Signals[] = [];
  const state = createProxyProcessShutdownState();
  let groupEmpty = true;
  const input = {
    child: {
      pid: 434_343,
      kill(signal: NodeJS.Signals) {
        childSignals.push(signal);
        return true;
      },
    },
    isExited: () => true,
    label: 'terminal PGID test',
    state,
    probeProcessGroupEmpty: () => groupEmpty,
    signalProcessGroup: (_groupId: number, signal: NodeJS.Signals) => {
      groupSignals.push(signal);
    },
  };

  await shutdownProxyProcess(input);
  assert.equal(state.absenceObserved, true);

  // The same number now names unrelated live work. A stale forceKill-style
  // caller and a second cleanup must both honor the terminal absence proof.
  groupEmpty = false;
  assert.equal(state.beginEscalation(), false);
  await shutdownProxyProcess(input);
  assert.deepEqual(groupSignals, []);
  assert.deepEqual(childSignals, []);
});

test('Claude forceKill makes exit cleanup verification-only', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-claude-force-kill-one-shot-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'stuck-proxy.mjs');
  await writeFile(entry, 'setInterval(() => {}, 1_000);\n');
  const repeatedGroupSignals: NodeJS.Signals[] = [];
  let cleanupCalls = 0;
  let finishCleanup!: () => void;
  const cleanupFinished = new Promise<void>(resolve => { finishCleanup = resolve; });
  const client = new ProtocolV2Client({
    entry,
    dataDir: root,
    pluginId: 'claude',
    pluginVersion: '0.2.0',
    processScope: 'session',
    hostVersion: '9.9.9',
    async shutdownProcess(input) {
      cleanupCalls += 1;
      try {
        await shutdownProxyProcess({
          ...input,
          probeProcessGroupEmpty: () => false,
          signalProcessGroup: (_groupId, signal) => {
            repeatedGroupSignals.push(signal);
          },
        });
      } finally {
        finishCleanup();
      }
    },
  });

  client.forceKill();
  await Promise.race([
    cleanupFinished,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('forceKill cleanup did not run')), 2_000);
    }),
  ]);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(repeatedGroupSignals, []);
});

test('Claude already-empty observation makes a later exit cleanup signal-free', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-claude-known-empty-exit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entry = join(root, 'fast-exit-proxy.mjs');
  await writeFile(entry, 'process.exit(0);\n');
  const repeatedGroupSignals: NodeJS.Signals[] = [];
  let cleanupCalls = 0;
  let finishCleanup!: () => void;
  const cleanupFinished = new Promise<void>(resolve => { finishCleanup = resolve; });
  const client = new ProtocolV2Client({
    entry,
    dataDir: root,
    pluginId: 'claude',
    pluginVersion: '0.2.0',
    processScope: 'session',
    hostVersion: '9.9.9',
    async shutdownProcess(input) {
      cleanupCalls += 1;
      try {
        await shutdownProxyProcess({
          ...input,
          probeProcessGroupEmpty: () => false,
          signalProcessGroup: (_groupId, signal) => {
            repeatedGroupSignals.push(signal);
          },
        });
      } finally {
        finishCleanup();
      }
    },
  });

  // Model reservation.register() observing ESRCH before Node delivers exit.
  client.observeProcessGroupAbsence();
  await Promise.race([
    cleanupFinished,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('known-empty exit cleanup did not run')), 2_000);
    }),
  ]);
  assert.equal(cleanupCalls, 1);
  assert.deepEqual(repeatedGroupSignals, []);
});

test('CLI and Proxy installers share one cross-process Agent update boundary', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-update-boundary-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  let releaseFetch!: () => void;
  const blocked = new Promise<void>(resolve => { releaseFetch = resolve; });
  let fetchStarted!: () => void;
  const started = new Promise<void>(resolve => { fetchStarted = resolve; });
  const options = {
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
    fetchImpl: async () => {
      fetchStarted();
      await blocked;
      return new Response(new Uint8Array());
    },
  } as const;
  const firstManager = await AgentManager.create(options);
  // Different app/worktree profiles have different data directories but the
  // same HOME and vendor CLI. They must still share one updater namespace.
  const secondManager = await AgentManager.create({
    ...options,
    dataDir: join(root, 'other-profile-data'),
  });

  const first = firstManager.installOfficialCli('claude');
  await started;
  await assert.rejects(
    secondManager.installOfficialCli('claude'),
    (error: unknown) => error instanceof AgentUpdateBusyError,
  );
  await assert.rejects(
    firstManager.installProxy('claude'),
    (error: unknown) => error instanceof AgentUpdateBusyError,
  );

  releaseFetch();
  await assert.rejects(first, /Download size is invalid/);
  const lease = await acquireAgentUpdateLock(
    join(options.homeDir, '.gian'),
    'claude',
    'post-failure check',
  );
  await lease.release();
});

test('an already-empty compatibility process never enters signalling shutdown', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-compatibility-known-empty-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entryPath = join(root, 'fast-exit-proxy.mjs');
  await writeFile(entryPath, 'process.exit(0);\n');
  let signalPathCalls = 0;
  let releaseUnregisteredCalls = 0;
  const manager = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.1.0',
    managedProxies: false,
    homeDir: join(root, 'home'),
    pathEnv: '',
    async shutdownProxyProcessImpl() {
      signalPathCalls += 1;
    },
  });
  const internals = manager as unknown as {
    resolveCompatibilityRuntime: () => Promise<{
      cli: 'claude';
      binaryPath: string;
      version: string;
      source: 'path';
      env: Readonly<Record<string, string>>;
    }>;
    runProxyCompatibilityProbe: (
      input: {
        id: 'claude';
        version: string;
        entryPath: string;
        protocol: 'legacy' | 'gian.proxy';
        processScope?: 'shared' | 'session';
      },
      updateOwner: AgentUpdateLease,
    ) => Promise<void>;
  };
  internals.resolveCompatibilityRuntime = async () => ({
    cli: 'claude',
    binaryPath: process.execPath,
    version: process.version,
    source: 'path',
    env: {},
  });
  const updateOwner: AgentUpdateLease = {
    async reserveProcessGroup() {
      return {
        async register() {
          await new Promise(resolve => setTimeout(resolve, 50));
          return 'already-empty' as const;
        },
        async cancelBeforeSpawn() { assert.fail('spawn already occurred'); },
        async releaseUnregistered(groupId: number) {
          assert.ok(groupId > 0);
          releaseUnregisteredCalls += 1;
        },
        async release() { assert.fail('the group was never registered'); },
      };
    },
    async release() {},
  };

  await assert.rejects(
    internals.runProxyCompatibilityProbe({
      id: 'claude',
      version: '0.1.0',
      entryPath,
      protocol: 'gian.proxy',
    }, updateOwner),
    /exited before registration/,
  );
  assert.equal(signalPathCalls, 0);
  assert.equal(releaseUnregisteredCalls, 1);
});

test('protocol v2 compatibility probe uses generic env and validates the handshake', {
  skip: process.platform === 'win32',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-compatibility-v2-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const entryPath = join(root, 'v2-proxy.mjs');
  await writeFile(entryPath, `
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of input) {
  const request = JSON.parse(line);
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
  if (request.method === 'initialize') {
    const valid = process.env.GIAN_PLUGIN_ID === 'claude'
      && process.env.GIAN_PLUGIN_DATA_DIR
      && process.env.GIAN_RUNTIME_BIN
      && process.env.GIAN_PROTOCOL_VERSIONS === '2.1,2.0'
      && request.params.protocol.name === 'gian.proxy'
      && request.params.protocol.versions.includes('2.1')
      && request.params.protocol.versions.includes('2.0');
    reply({
      protocol: { name: 'gian.proxy', version: '2.0' },
      plugin: { id: valid ? 'claude' : 'invalid.fixture', name: 'Claude', version: '7.4.2' },
      process: { scope: 'shared' },
      capabilities: {},
    });
  } else if (request.method === 'catalog.list') {
    reply({ catalogRevision: 'probe', input: [{ type: 'text' }], configOptions: [], slashCommands: [] });
  } else if (request.method === 'shutdown') {
    reply({ ok: true });
  }
  if (request.method === 'shutdown') break;
}
`);
  const cliPath = await writeFakeCli(root, 'claude');
  const dataDir = join(root, 'data');
  const manager = await AgentManager.create({
    dataDir,
    releaseVersion: '99.8.7',
    managedProxies: false,
    environmentCliPaths: { claude: cliPath },
    homeDir: join(root, 'home'),
    pathEnv: '',
  });
  const internals = manager as unknown as {
    runProxyCompatibilityProbe: (
      input: {
        id: 'claude';
        version: string;
        entryPath: string;
        protocol: 'gian.proxy';
        processScope: 'shared';
      },
      updateOwner: AgentUpdateLease,
    ) => Promise<void>;
  };
  const updateOwner = await acquireAgentUpdateLock(
    join(root, 'locks'),
    'claude',
    'protocol v2 compatibility probe',
  );
  try {
    await internals.runProxyCompatibilityProbe({
      id: 'claude',
      version: '7.4.2',
      entryPath,
      protocol: 'gian.proxy',
      processScope: 'shared',
    }, updateOwner);
  } finally {
    await updateOwner.release();
  }
});

test('production compatibility handshake validates protocol, capabilities, and managed env', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-real-handshake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await writeProxyVersion(dataDir, 'claude', '0.0.9');
  await symlink('0.0.9', join(dataDir, 'plugins', 'claude', 'current'), 'dir');
  const artifact = await proxyArchive(root, 'claude', '0.1.0', true, true, true);
  const cliPath = await writeFakeCli(root, 'claude');
  const manager = await AgentManager.create({
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
    environmentCliPaths: { claude: cliPath },
    fetchImpl: proxyReleaseFetch(artifact),
  });

  const result = await manager.installProxy('claude');
  assert.equal(result.agent.proxy.state, 'ready');
  assert.equal(await readlink(join(dataDir, 'plugins', 'claude', 'current')), '0.1.0');
});

test('an incompatible real protocol handshake never activates the candidate', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-bad-handshake-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await writeProxyVersion(dataDir, 'claude', '0.0.9');
  await symlink('0.0.9', join(dataDir, 'plugins', 'claude', 'current'), 'dir');
  const artifact = await proxyArchive(root, 'claude', '0.1.0', true, false);
  const cliPath = await writeFakeCli(root, 'claude');
  const manager = await AgentManager.create({
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
    environmentCliPaths: { claude: cliPath },
    fetchImpl: proxyReleaseFetch(artifact),
  });

  await assert.rejects(manager.installProxy('claude'), /Invalid initialize result|initialize handshake is incompatible/i);
  assert.equal(await readlink(join(dataDir, 'plugins', 'claude', 'current')), '0.0.9');
});

test('the compatibility gate rejects a missing catalog.list method', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  for (const id of ['claude', 'codex', 'kimi'] as const) {
    await t.test(`${id} requires catalog.list`, async t => {
      const root = await mkdtemp(join(tmpdir(), `gian-agent-missing-${id}-catalog-`));
      t.after(() => rm(root, { recursive: true, force: true }));
      const dataDir = join(root, 'data');
      await writeProxyVersion(dataDir, id, '0.0.9');
      await symlink('0.0.9', join(dataDir, 'plugins', id, 'current'), 'dir');
      const artifact = await proxyArchive(
        root,
        id,
        '0.1.0',
        true,
        true,
        false,
        'catalog.list',
      );
      const cliPath = await writeFakeCli(root, id);
      const manager = await AgentManager.create({
        dataDir,
        releaseVersion: '0.1.0',
        managedProxies: true,
        homeDir: join(root, 'home'),
        pathEnv: '',
        environmentCliPaths: { [id]: cliPath },
        fetchImpl: proxyReleaseFetch(artifact),
      });

      await assert.rejects(manager.installProxy(id), /catalog\.list failed/i);
      assert.equal(await readlink(join(dataDir, 'plugins', id, 'current')), '0.0.9');
    });
  }
});

test('failed Proxy compatibility probe never changes the active version', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-probe-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await writeProxyVersion(dataDir, 'claude', '0.0.9');
  await symlink('0.0.9', join(dataDir, 'plugins', 'claude', 'current'), 'dir');
  const artifact = await proxyArchive(root, 'claude', '0.1.0', false);
  let activationProbeCalls = 0;
  const manager = await AgentManager.create({
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
    fetchImpl: proxyReleaseFetch(artifact),
    proxyActivationProbe: async () => { activationProbeCalls += 1; },
  });

  await assert.rejects(manager.installProxy('claude'), /self-test returned an invalid result/i);
  assert.equal(await readlink(join(dataDir, 'plugins', 'claude', 'current')), '0.0.9');
  assert.equal(activationProbeCalls, 0);
});

test('a pending or failed compatibility probe never exposes the candidate version', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-activation-rollback-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await writeProxyVersion(dataDir, 'claude', '0.0.9');
  await symlink('0.0.9', join(dataDir, 'plugins', 'claude', 'current'), 'dir');
  const artifact = await proxyArchive(root, 'claude', '0.1.0');
  let probeStarted!: () => void;
  const started = new Promise<void>(resolve => { probeStarted = resolve; });
  let rejectProbe!: (reason: Error) => void;
  const blocked = new Promise<void>((_resolve, reject) => { rejectProbe = reject; });
  const manager = await AgentManager.create({
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
    fetchImpl: proxyReleaseFetch(artifact),
    proxyActivationProbe: async () => {
      probeStarted();
      await blocked;
    },
  });

  const installation = manager.installProxy('claude');
  await started;
  assert.equal(await readlink(join(dataDir, 'plugins', 'claude', 'current')), '0.0.9');
  rejectProbe(new Error('compatibility handshake rejected'));
  await assert.rejects(installation, /compatibility handshake rejected/i);
  assert.equal(await readlink(join(dataDir, 'plugins', 'claude', 'current')), '0.0.9');
});

test('an atomic activation commit failure keeps the previous validated version', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-activation-commit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  await writeProxyVersion(dataDir, 'claude', '0.0.9');
  await symlink('0.0.9', join(dataDir, 'plugins', 'claude', 'current'), 'dir');
  const artifact = await proxyArchive(root, 'claude', '0.1.0');
  const manager = await AgentManager.create({
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
    fetchImpl: proxyReleaseFetch(artifact),
    proxyActivationProbe: async () => undefined,
    proxyActivationSwap: async () => { throw new Error('atomic rename rejected'); },
  });

  await assert.rejects(manager.installProxy('claude'), /kept the previous validated version/i);
  assert.equal(await readlink(join(dataDir, 'plugins', 'claude', 'current')), '0.0.9');
});

test('an escaped version symlink is never classified as a validated previous version', {
  skip: process.platform !== 'darwin' || process.arch !== 'arm64',
}, async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-escaped-lkg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const agentRoot = join(dataDir, 'plugins', 'claude');
  const outside = join(root, 'outside-proxy');
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'proxy.mjs'), proxySource('claude', '0.0.9'));
  await writeFile(join(outside, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, id: 'claude', version: '0.0.9', entry: 'proxy.mjs',
  }));
  await mkdir(agentRoot, { recursive: true });
  await symlink(outside, join(agentRoot, '0.0.9'), 'dir');
  await symlink('0.0.9', join(agentRoot, 'current'), 'dir');
  const artifact = await proxyArchive(root, 'claude', '0.1.0');
  const manager = await AgentManager.create({
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
    fetchImpl: proxyReleaseFetch(artifact),
    proxyActivationProbe: async () => undefined,
    proxyActivationSwap: async () => { throw new Error('atomic rename rejected'); },
  });

  assert.equal((await manager.status('claude', true)).proxy.state, 'invalid');
  await assert.rejects(
    manager.installProxy('claude'),
    (error: unknown) => error instanceof Error
      && /active target was not changed/i.test(error.message)
      && !/previous validated version/i.test(error.message),
  );
});

test('Proxy refresh reruns self-test after an entry changes in place', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-agent-self-test-refresh-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, 'data');
  const directory = await writeProxyVersion(dataDir, 'claude', '0.1.0');
  await symlink('0.1.0', join(dataDir, 'plugins', 'claude', 'current'), 'dir');
  const manager = await AgentManager.create({
    dataDir,
    releaseVersion: '0.1.0',
    managedProxies: true,
    homeDir: join(root, 'home'),
    pathEnv: '',
  });

  assert.equal((await manager.status('claude', true)).proxy.state, 'ready');
  await writeFile(join(directory, 'proxy.mjs'), proxySource('claude', '0.1.0', false));
  assert.equal((await manager.status('claude', true)).proxy.state, 'invalid');
});

test('Agent install routes expose updater contention as 409', async () => {
  const agents = {
    installOfficialCli: async () => { throw new AgentUpdateBusyError('Proxy install'); },
    installProxy: async () => { throw new AgentUpdateBusyError('official CLI install'); },
  } as unknown as AgentManager;
  const app = new Hono();
  registerAgentRoutes(app, {
    agents,
    runtimes: { drain: async () => undefined, invalidate: () => true } as never,
    closeProxy: async () => undefined,
    capabilities: async () => ({ models: [], modes: [] }),
  });

  for (const endpoint of ['install-cli', 'install-proxy']) {
    const response = await app.request(`/api/agents/claude/${endpoint}`, { method: 'POST' });
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, /already in progress/i);
  }
});

test('Proxy defaults keep managed approval presets separate from native policy values', async () => {
  const defaults: AgentProxyDefaults = { model: 'codex-model', thinking: 'high', mode: 'ask' };
  const writes: Array<Partial<AgentProxyDefaults>> = [];
  let catalog: ProxyCatalog = {
    catalogRevision: 'codex-low-level',
    input: [{ type: 'text' }],
    configOptions: [
      {
        id: 'model',
        displayName: 'Model',
        binding: 'turn',
        role: 'model',
        control: 'select',
        required: false,
        defaultValue: 'codex-model',
        choices: [{ value: 'codex-model', displayName: 'Codex model' }],
      },
      {
        id: 'effort',
        displayName: 'Effort',
        binding: 'turn',
        role: 'effort',
        control: 'select',
        required: false,
        defaultValue: 'high',
        choices: [{ value: 'high', displayName: 'High' }],
      },
      {
        id: 'approval_policy',
        displayName: 'Approval policy',
        binding: 'turn',
        role: 'approval_mode',
        control: 'select',
        required: false,
        defaultValue: null,
        choices: [
          { value: null, displayName: 'Configured default' },
          { value: 'on-request', displayName: 'On request' },
          { value: 'never', displayName: 'Never' },
        ],
      },
    ],
    slashCommands: [],
  };
  const agents = {
    getAgent: () => ({
      id: 'agent-codex',
      name: 'Codex',
      proxy: 'codex',
      cliPath: null,
      defaults: { ...defaults },
    }),
    updateAgent: async (_id: string, patch: { defaults?: Partial<AgentProxyDefaults> }) => {
      writes.push(patch.defaults ?? {});
      Object.assign(defaults, patch.defaults);
      return {};
    },
    agentStatus: async () => ({}),
  } as unknown as AgentManager;
  const app = new Hono();
  registerAgentRoutes(app, {
    agents,
    runtimes: {} as never,
    closeProxy: async () => undefined,
    capabilities: async () => catalog,
  });
  const put = (body: Partial<AgentProxyDefaults>) => app.request(
    '/api/agents/agent-codex',
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ defaults: body }),
    },
  );

  const unrelated = await put({ model: 'codex-model' });
  assert.equal(unrelated.status, 200, 'an existing semantic preset must not block unrelated saves');
  assert.deepEqual(writes, [{ model: 'codex-model' }]);

  const nativePolicy = await put({ mode: 'on-request' });
  assert.equal(nativePolicy.status, 400);
  assert.match(
    (await nativePolicy.json() as { error: string }).error,
    /Gian approval preset|product-level approval modes/,
  );
  assert.equal(writes.length, 1, 'native policy values must not be stored as managed presets');

  catalog = {
    ...catalog,
    catalogRevision: 'codex-semantic-modes',
    configOptions: catalog.configOptions.map(option => option.role === 'approval_mode'
      ? {
          ...option,
          id: 'approval_mode',
          defaultValue: 'ask',
          choices: [
            { value: 'ask', displayName: 'Ask for approval' },
            { value: 'auto', displayName: 'Approve for me' },
            { value: 'full-access', displayName: 'Full access' },
            { value: 'custom', displayName: 'config.toml' },
          ],
        }
      : option),
  };
  const semanticPreset = await put({ mode: 'full-access' });
  assert.equal(semanticPreset.status, 200);
  assert.deepEqual(writes.at(-1), { mode: 'full-access' });
});

test('native DSH defaults accept the Proxy-owned mode vocabulary', async () => {
  const defaults: AgentProxyDefaults = { model: '', thinking: '', mode: '' };
  const writes: Array<Partial<AgentProxyDefaults>> = [];
  const agents = {
    getAgent: () => ({
      id: 'agent-dsh',
      name: 'DeepSeek Harness',
      proxy: 'dsh',
      cliPath: null,
      defaults: { ...defaults },
    }),
    updateAgent: async (_id: string, patch: { defaults?: Partial<AgentProxyDefaults> }) => {
      writes.push(patch.defaults ?? {});
      Object.assign(defaults, patch.defaults);
      return {};
    },
    agentStatus: async () => ({}),
  } as unknown as AgentManager;
  const app = new Hono();
  registerAgentRoutes(app, {
    agents,
    runtimes: {} as never,
    closeProxy: async () => undefined,
    capabilities: async () => ({
      catalogRevision: 'dsh-native',
      input: [{ type: 'text' }],
      configOptions: [{
        id: 'approval_policy',
        displayName: 'Approval policy',
        binding: 'turn',
        role: 'approval_mode',
        control: 'select',
        required: false,
        defaultValue: 'ask',
        choices: [
          { value: 'ask', displayName: 'Ask' },
          { value: 'never', displayName: 'Never' },
        ],
      }],
      slashCommands: [],
    }),
  });

  const response = await app.request('/api/agents/agent-dsh', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaults: { mode: 'never' } }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(writes, [{ mode: 'never' }]);
});

test('Proxy defaults validate effort against the catalog resolved for the selected model', async () => {
  const defaults: AgentProxyDefaults = { model: 'default', thinking: 'medium', mode: 'ask' };
  const writes: Array<Partial<AgentProxyDefaults>> = [];
  const baseCatalog: ProxyCatalog = {
    catalogRevision: 'claude-models',
    input: [{ type: 'text' }],
    configOptions: [
      {
        id: 'model',
        displayName: 'Model',
        binding: 'turn',
        role: 'model',
        control: 'select',
        required: false,
        defaultValue: 'default',
        choices: [
          { value: 'default', displayName: 'Default' },
          { value: 'opus', displayName: 'Opus' },
        ],
      },
      {
        id: 'effort',
        displayName: 'Effort',
        binding: 'turn',
        role: 'effort',
        control: 'select',
        required: false,
        defaultValue: 'medium',
        choices: [
          { value: 'low', displayName: 'Low' },
          { value: 'medium', displayName: 'Medium' },
          { value: 'high', displayName: 'High' },
        ],
      },
      {
        id: 'approval_mode',
        displayName: 'Approval mode',
        binding: 'turn',
        role: 'approval_mode',
        control: 'select',
        required: false,
        defaultValue: 'ask',
        choices: [
          { value: 'ask', displayName: 'Ask' },
          { value: 'auto', displayName: 'Auto' },
        ],
      },
    ],
    slashCommands: [],
  };
  const resolveCalls: unknown[] = [];
  const agents = {
    getAgent: () => ({
      id: 'agent-claude',
      name: 'Claude Code',
      proxy: 'claude',
      cliPath: null,
      defaults: { ...defaults },
    }),
    updateAgent: async (_id: string, patch: { defaults?: Partial<AgentProxyDefaults> }) => {
      writes.push(patch.defaults ?? {});
      Object.assign(defaults, patch.defaults);
      return {};
    },
    agentStatus: async () => ({}),
  } as unknown as AgentManager;
  const app = new Hono();
  registerAgentRoutes(app, {
    agents,
    runtimes: {} as never,
    closeProxy: async () => undefined,
    capabilities: async () => baseCatalog,
    resolveDefaultsCatalog: async (id, catalog, config) => {
      resolveCalls.push({ id, revision: catalog.catalogRevision, config });
      return {
        ...catalog,
        configOptions: catalog.configOptions.map(option => option.role === 'effort'
          ? {
              ...option,
              defaultValue: 'high',
              choices: [
                { value: 'low', displayName: 'Low' },
                { value: 'high', displayName: 'High' },
                { value: 'max', displayName: 'Max' },
              ],
            }
          : option),
      };
    },
  });

  const response = await app.request('/api/agents/agent-claude', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ defaults: { model: 'opus', thinking: 'max' } }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(resolveCalls, [{
    id: 'claude',
    revision: 'claude-models',
    config: { sessionConfig: {}, turnConfig: { model: 'opus' } },
  }]);
  assert.deepEqual(writes, [{ model: 'opus', thinking: 'max' }]);
});

test('Agent install routes drain CLI use before mutation without self-locking Proxy updates', async () => {
  const events: string[] = [];
  const agents = {
    installOfficialCli: async () => {
      events.push('install-cli');
      return { agent: {} };
    },
    installProxy: async () => {
      events.push('install-proxy');
      return { agent: {} };
    },
  } as unknown as AgentManager;
  const app = new Hono();
  registerAgentRoutes(app, {
    agents,
    runtimes: {
      async drain() {
        events.push('drain');
      },
      invalidate: () => {
        events.push('invalidate');
        return true;
      },
    } as never,
    closeProxy: async id => {
      events.push(`close-${id}`);
    },
    capabilities: async () => ({ models: [], modes: [] }),
  });

  assert.equal(
    (await app.request('/api/agents/claude/install-cli', { method: 'POST' })).status,
    200,
  );
  assert.deepEqual(events, ['close-claude', 'drain', 'install-cli', 'invalidate']);
  events.length = 0;
  assert.equal(
    (await app.request('/api/agents/claude/install-proxy', { method: 'POST' })).status,
    200,
  );
  assert.deepEqual(events, ['install-proxy', 'close-claude']);
});

test('Agent path route invalidates a committed runtime even when claim retirement reports failure', async () => {
  let invalidations = 0;
  const agents = {
    getAgent: () => ({
      id: 'agent-claude',
      name: 'Claude Code',
      proxy: 'claude' as const,
      cliPath: null,
      defaults: { model: '', thinking: '', mode: '' },
    }),
    async updateAgent() {
      throw new Error('configuration committed but claim retirement failed');
    },
  } as unknown as AgentManager;
  const app = new Hono();
  registerAgentRoutes(app, {
    agents,
    runtimes: {
      invalidate() {
        invalidations += 1;
        return true;
      },
    } as never,
    closeProxy: async () => undefined,
    capabilities: async () => ({ models: [], modes: [] }),
  });

  const response = await app.request('/api/agents/agent-claude', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cliPath: '/new/claude' }),
  });
  assert.equal(response.status, 400);
  assert.equal(invalidations, 1);
});

test('Proxy close barrier waits for an in-flight runtime attempt to release its claim', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-proxy-close-runtime-barrier-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxyEntry = join(root, 'delayed-exit-proxy.mjs');
  const exitMarker = join(root, 'proxy-exited');
  await writeFile(proxyEntry, `
    import { writeFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      const request = JSON.parse(line);
      if (request.method !== 'shutdown') continue;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
      setTimeout(() => {
        writeFileSync(process.env.EXIT_MARKER, 'exited');
        process.exit(0);
      }, 50);
    }
  `);
  let acquireCalls = 0;
  let firstAcquireStarted!: () => void;
  const acquireStarted = new Promise<void>(resolve => { firstAcquireStarted = resolve; });
  let allowFirstAcquire!: () => void;
  const acquireGate = new Promise<void>(resolve => { allowFirstAcquire = resolve; });
  let releaseStarted!: () => void;
  const releasing = new Promise<void>(resolve => { releaseStarted = resolve; });
  let allowRelease!: () => void;
  const releaseGate = new Promise<void>(resolve => { allowRelease = resolve; });
  let runtimeReleasedAfterProxyExit = false;
  const runtimeManager = {
    async acquire() {
      acquireCalls += 1;
      if (acquireCalls > 1) throw new Error('controlled post-close stop');
      firstAcquireStarted();
      await acquireGate;
      return {
        cli: 'claude' as const,
        binaryPath: '/fake/claude',
        version: '1.0.0',
        source: 'managed' as const,
        env: { EXIT_MARKER: exitMarker },
        async release() {
          runtimeReleasedAfterProxyExit = await readFile(exitMarker, 'utf8') === 'exited';
          releaseStarted();
          await releaseGate;
        },
      };
    },
  };
  const manager = new ProxyManager({
    ...PROTOCOL_V2,
    dataDir: root,
    ccProxyEntry: proxyEntry,
    runtimeManager: runtimeManager as never,
  });

  const pendingClient = manager.getOrCreate('racing-session', 'claude');
  await acquireStarted;
  let closeFinished = false;
  const closing = manager.closeByExecutor('claude').then(() => { closeFinished = true; });
  allowFirstAcquire();
  await releasing;
  assert.equal(runtimeReleasedAfterProxyExit, true);
  assert.equal(closeFinished, false, 'close cannot cross the runtime release barrier');
  allowRelease();
  await closing;
  await assert.rejects(pendingClient, /controlled post-close stop/);
  assert.equal(acquireCalls, 2);
  await manager.closeAll();
});

test('startup leases remain strongly retryable when reservation and lease cleanup fail', async t => {
  for (const executor of ['claude', 'codex', 'kimi', 'grok'] as const) {
    const root = await mkdtemp(join(tmpdir(), `gian-${executor}-startup-binding-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    let acquireCalls = 0;
    let releaseCalls = 0;
    const runtimeManager = {
      async acquire() {
        acquireCalls += 1;
        return {
          cli: executor,
          binaryPath: `/fake/${executor}`,
          version: '1.0.0',
          source: 'managed',
          env: {},
          async reserveProcessGroup() {
            throw new Error(`controlled ${executor} reservation failure`);
          },
          async release() {
            releaseCalls += 1;
            if (releaseCalls <= 2) {
              throw new Error(`controlled ${executor} lease release failure ${releaseCalls}`);
            }
          },
        };
      },
    };
    const manager = new ProxyManager({
    ...PROTOCOL_V2,
      dataDir: root,
      ccProxyEntry: '/unused/cc-proxy.mjs',
      ...(executor === 'codex' ? { codexProxyEntry: '/unused/codex-proxy.mjs' } : {}),
      ...(executor === 'kimi' ? { kimiProxyEntry: '/unused/kimi-proxy.mjs' } : {}),
      ...(executor === 'grok' ? { grokProxyEntry: '/unused/grok-proxy.mjs' } : {}),
      runtimeManager: runtimeManager as never,
    });

    await assert.rejects(
      manager.getOrCreate(`${executor}-startup-session`, executor),
      (error: unknown) => error instanceof AggregateError
        && error.errors.some(item => new RegExp(
          `controlled ${executor} lease release failure 1`,
        ).test(String(item))),
    );
    assert.equal(acquireCalls, 1);
    assert.equal(releaseCalls, 1);
    await assert.rejects(
      manager.getOrCreate(`${executor}-blocked-reuse`, executor),
      new RegExp(`controlled ${executor} lease release failure 1`),
    );
    assert.equal(acquireCalls, 1, 'failed startup cleanup must block a replacement acquire');

    await assert.rejects(
      manager.closeByExecutor(executor),
      (error: unknown) => errorTreeIncludes(
        error,
        new RegExp(`controlled ${executor} lease release failure 1`),
      ),
    );
    assert.equal(releaseCalls, 1, 'first close reports the retained failure without skipping stages');
    await assert.rejects(
      manager.closeByExecutor(executor),
      (error: unknown) => errorTreeIncludes(
        error,
        new RegExp(`controlled ${executor} lease release failure 2`),
      ),
    );
    assert.equal(releaseCalls, 2);
    await manager.closeByExecutor(executor);
    assert.equal(releaseCalls, 3);
  }
});

test('already-empty Proxy startup skips shutdown and records terminal absence', async t => {
  const observeCalls = { claude: 0, codex: 0, kimi: 0, grok: 0 };
  const shutdownCalls = { claude: 0, codex: 0, kimi: 0, grok: 0 };
  const originalObserve = ProtocolV2Host.prototype.observeProcessGroupAbsence;
  const originalShutdown = ProtocolV2Host.prototype.shutdown;
  ProtocolV2Host.prototype.observeProcessGroupAbsence = function observeAbsence() {
    observeCalls[this.executor] += 1;
    originalObserve.call(this);
  };
  ProtocolV2Host.prototype.shutdown = async function skipShutdown() {
    shutdownCalls[this.executor] += 1;
  };
  t.after(() => {
    ProtocolV2Host.prototype.observeProcessGroupAbsence = originalObserve;
    ProtocolV2Host.prototype.shutdown = originalShutdown;
  });

  for (const executor of ['claude', 'codex', 'kimi', 'grok'] as const) {
    const root = await mkdtemp(join(tmpdir(), `gian-${executor}-known-empty-startup-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const proxyEntry = join(root, 'fast-exit-proxy.mjs');
    await writeFile(proxyEntry, 'process.exit(0);\n');
    let releaseUnregisteredCalls = 0;
    let leaseReleaseCalls = 0;
    const runtimeManager = {
      async acquire() {
        return {
          cli: executor,
          binaryPath: `/fake/${executor}`,
          version: '1.0.0',
          source: 'managed',
          env: {},
          async reserveProcessGroup() {
            return {
              async register() {
                await new Promise(resolve => setTimeout(resolve, 50));
                return 'already-empty' as const;
              },
              async cancelBeforeSpawn() { assert.fail('spawn already occurred'); },
              async releaseUnregistered(groupId: number) {
                assert.ok(groupId > 0);
                releaseUnregisteredCalls += 1;
              },
              async release() { assert.fail('the group was never registered'); },
            };
          },
          async release() { leaseReleaseCalls += 1; },
        };
      },
    };
    const manager = new ProxyManager({
    ...PROTOCOL_V2,
      dataDir: root,
      ccProxyEntry: proxyEntry,
      ...(executor === 'codex' ? { codexProxyEntry: proxyEntry } : {}),
      ...(executor === 'kimi' ? { kimiProxyEntry: proxyEntry } : {}),
      ...(executor === 'grok' ? { grokProxyEntry: proxyEntry } : {}),
      runtimeManager: runtimeManager as never,
    });

    await assert.rejects(
      manager.getOrCreate(`${executor}-known-empty`, executor),
      /exited before its process group could be registered/,
    );
    assert.equal(observeCalls[executor], 1);
    assert.equal(shutdownCalls[executor], 0);
    assert.equal(releaseUnregisteredCalls, 1);
    assert.equal(leaseReleaseCalls, 1);
    await manager.closeAll();
  }
});

test('a stale unpublished Claude runtime retains its lease until shutdown can be retried', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-unpublished-claude-cleanup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxyEntry = join(root, 'unpublished-proxy.mjs');
  await writeFile(proxyEntry, `
    import { createInterface } from 'node:readline';
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      const request = JSON.parse(line);
      if (request.method !== 'shutdown') continue;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
      process.exit(0);
    }
  `);
  let acquireStarted!: () => void;
  const acquiring = new Promise<void>(resolve => { acquireStarted = resolve; });
  let allowAcquire!: () => void;
  const acquireGate = new Promise<void>(resolve => { allowAcquire = resolve; });
  let releaseCalls = 0;
  const runtimeManager = {
    async acquire() {
      acquireStarted();
      await acquireGate;
      return {
        cli: 'claude' as const,
        binaryPath: '/fake/claude',
        version: '1.0.0',
        source: 'managed' as const,
        env: {},
        async release() { releaseCalls += 1; },
      };
    },
  };
  const manager = new ProxyManager({
    ...PROTOCOL_V2,
    dataDir: root,
    ccProxyEntry: proxyEntry,
    runtimeManager: runtimeManager as never,
  });
  const originalShutdown = ProtocolV2Host.prototype.shutdown;
  ProtocolV2Host.prototype.shutdown = async function controlledShutdownFailure() {
    throw new Error('controlled unpublished shutdown failure');
  };
  t.after(() => { ProtocolV2Host.prototype.shutdown = originalShutdown; });

  const pendingClient = manager.getOrCreate('unpublished-claude', 'claude');
  const pendingRejected = assert.rejects(
    pendingClient,
    /controlled unpublished shutdown failure/,
  );
  await acquiring;
  const closing = manager.closeByExecutor('claude');
  allowAcquire();
  await pendingRejected;
  await assert.rejects(
    closing,
    (error: unknown) => errorTreeIncludes(error, /controlled unpublished shutdown failure/),
  );
  assert.equal(manager.get('unpublished-claude'), undefined);
  assert.equal(releaseCalls, 0, 'shutdown proof must precede lease release');
  await assert.rejects(
    manager.getOrCreate('blocked-unpublished-reuse', 'claude'),
    /controlled unpublished shutdown failure/,
  );

  ProtocolV2Host.prototype.shutdown = originalShutdown;
  await manager.closeByExecutor('claude');
  assert.equal(releaseCalls, 1);
});

test('failed close blocks replacement runtimes until exact cleanup is retried', async t => {
  for (const executor of ['claude', 'codex', 'kimi', 'grok'] as const) {
    const root = await mkdtemp(join(tmpdir(), `gian-${executor}-failed-close-barrier-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const proxyEntry = join(root, 'close-barrier-proxy.mjs');
    await writeFile(proxyEntry, `
      import { createInterface } from 'node:readline';
      const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of input) {
        const request = JSON.parse(line);
        if (request.method !== 'shutdown') continue;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
        process.exit(0);
      }
    `);
    let acquireCalls = 0;
    let releaseCalls = 0;
    const usesSharedRuntime = executor === 'kimi';
    const runtimeManager = (usesSharedRuntime || executor === 'grok') ? {
      async acquire() {
        acquireCalls += 1;
        return {
          cli: executor,
          binaryPath: `/fake/${executor}`,
          version: `${acquireCalls}.0.0`,
          source: 'managed' as const,
          env: {},
          async release() { releaseCalls += 1; },
        };
      },
    } : undefined;
    const manager = new ProxyManager({
    ...PROTOCOL_V2,
      dataDir: root,
      ccProxyEntry: proxyEntry,
      ...(executor === 'codex' ? { codexProxyEntry: proxyEntry } : {}),
      ...(executor === 'kimi' ? { kimiProxyEntry: proxyEntry } : {}),
      ...(executor === 'grok' ? { grokProxyEntry: proxyEntry } : {}),
      ...(runtimeManager ? { runtimeManager: runtimeManager as never } : {}),
    });
    const client = await manager.getOrCreate(`${executor}-failed-close`, executor);
    const owner = client instanceof ProtocolV2SessionClient
      ? client.runtimeHost()
      : client;
    const originalShutdown = owner.shutdown;
    owner.shutdown = async () => {
      throw new Error(`controlled ${executor} close cleanup failure`);
    };

    await assert.rejects(
      manager.closeByExecutor(executor),
      (error: unknown) => errorTreeIncludes(
        error,
        new RegExp(`controlled ${executor} close cleanup failure`),
      ),
    );
    assert.equal(manager.get(`${executor}-failed-close`), undefined);
    await assert.rejects(
      manager.getOrCreate(`${executor}-replacement-blocked`, executor),
      new RegExp(`controlled ${executor} close cleanup failure`),
    );
    if (usesSharedRuntime) assert.equal(acquireCalls, 1);

    owner.shutdown = originalShutdown;
    await manager.closeByExecutor(executor);
    const replacement = await manager.getOrCreate(`${executor}-replacement`, executor);
    const replacementOwner = replacement instanceof ProtocolV2SessionClient
      ? replacement.runtimeHost()
      : replacement;
    assert.notEqual(replacementOwner, owner);
    await manager.closeAll();
    if (usesSharedRuntime) {
      assert.equal(acquireCalls, 2);
      assert.equal(releaseCalls, 2);
    }
  }
});

test('racing dispose holds every same-session creation waiter behind its barrier', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-dispose-create-waiters-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxyEntry = join(root, 'dispose-waiter-proxy.mjs');
  await writeFile(proxyEntry, `
    import { createInterface } from 'node:readline';
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      const request = JSON.parse(line);
      if (request.method !== 'shutdown') continue;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
      process.exit(0);
    }
  `);
  let acquireCalls = 0;
  let firstAcquireStarted!: () => void;
  const firstAcquiring = new Promise<void>(resolve => { firstAcquireStarted = resolve; });
  let allowFirstAcquire!: () => void;
  const firstAcquireGate = new Promise<void>(resolve => { allowFirstAcquire = resolve; });
  let secondAcquireStarted!: () => void;
  const secondAcquiring = new Promise<void>(resolve => { secondAcquireStarted = resolve; });
  let allowSecondAcquire!: () => void;
  const secondAcquireGate = new Promise<void>(resolve => { allowSecondAcquire = resolve; });
  const released: number[] = [];
  const runtimeManager = {
    async acquire() {
      acquireCalls += 1;
      const id = acquireCalls;
      if (id === 1) {
        firstAcquireStarted();
        await firstAcquireGate;
      } else if (id === 2) {
        secondAcquireStarted();
        await secondAcquireGate;
      }
      return {
        cli: 'claude' as const,
        binaryPath: '/fake/claude',
        version: `${id}.0.0`,
        source: 'managed' as const,
        env: {},
        async release() { released.push(id); },
      };
    },
  };
  const manager = new ProxyManager({
    ...PROTOCOL_V2,
    dataDir: root,
    ccProxyEntry: proxyEntry,
    runtimeManager: runtimeManager as never,
  });
  let firstSettled = false;
  let waiterSettled = false;
  const first = manager.getOrCreate('dispose-race', 'claude').then(client => {
    firstSettled = true;
    return client;
  });
  const waiter = manager.getOrCreate('dispose-race', 'claude').then(client => {
    waiterSettled = true;
    return client;
  });
  await firstAcquiring;
  const disposing = manager.dispose('dispose-race');
  allowFirstAcquire();
  await secondAcquiring;
  assert.equal(firstSettled, false);
  assert.equal(waiterSettled, false);
  assert.deepEqual(released, [1]);
  await disposing;
  allowSecondAcquire();
  const [replacement, sameReplacement] = await Promise.all([first, waiter]);
  assert.equal(replacement, sameReplacement);
  assert.equal(acquireCalls, 2);
  await manager.closeAll();
  assert.deepEqual(released, [1, 2]);
});

test('unexpected Proxy leader exit releases runtime only after orphan PGID cleanup', {
  skip: process.platform !== 'darwin' && process.platform !== 'linux',
}, async t => {
  for (const executor of ['claude', 'codex', 'kimi', 'grok'] as const) {
    const root = await mkdtemp(join(tmpdir(), `gian-${executor}-unexpected-pgid-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const groupFile = join(root, 'group.json');
    const proxyEntry = join(root, 'unexpected-proxy.mjs');
    await writeFile(proxyEntry, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const grandchild = spawn(process.execPath, [
        '--input-type=module', '--eval',
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ], { detached: false, stdio: 'ignore' });
      writeFileSync(process.env.GROUP_FILE, JSON.stringify({
        groupId: process.pid,
        grandchildPid: grandchild.pid,
      }));
      setTimeout(() => process.exit(23), 120);
    `);

    let releasedAfterGroupEmpty = false;
    let markReleased!: () => void;
    const released = new Promise<void>(resolve => { markReleased = resolve; });
    const runtimeManager = {
      async acquire() {
        return {
          cli: executor,
          binaryPath: `/fake/${executor}`,
          version: '1.0.0',
          source: 'managed',
          env: { GROUP_FILE: groupFile },
          async release() {
            const { groupId } = JSON.parse(await readFile(groupFile, 'utf8')) as {
              groupId: number;
            };
            try {
              process.kill(-groupId, 0);
              releasedAfterGroupEmpty = false;
            } catch (error) {
              releasedAfterGroupEmpty = (
                (error as NodeJS.ErrnoException).code === 'ESRCH'
              );
            }
            markReleased();
          },
        };
      },
    };
    const manager = new ProxyManager({
    ...PROTOCOL_V2,
      dataDir: root,
      ccProxyEntry: proxyEntry,
      ...(executor === 'codex' ? { codexProxyEntry: proxyEntry } : {}),
      ...(executor === 'kimi' ? { kimiProxyEntry: proxyEntry } : {}),
      ...(executor === 'grok' ? { grokProxyEntry: proxyEntry } : {}),
      runtimeManager: runtimeManager as never,
    });
    await manager.getOrCreate(`${executor}-unexpected-session`, executor);
    await Promise.race([
      released,
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`${executor} runtime release timed out`)), 4_000);
      }),
    ]);
    assert.equal(
      releasedAfterGroupEmpty,
      true,
      `${executor} lease cannot release before its whole process group exits`,
    );
    await manager.closeAll();
  }
});

test('same-session concurrent getOrCreate is single-flight and releases each client lease once', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-proxy-same-session-singleflight-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spawnLog = join(root, 'spawns.log');
  const proxyEntry = join(root, 'singleflight-proxy.mjs');
  await writeFile(proxyEntry, `
    import { appendFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    appendFileSync(process.env.SPAWN_LOG, process.env.RUNTIME_ID + '\\n');
    if (process.env.UNEXPECTED_EXIT === '1') {
      setTimeout(() => process.exit(19), 120);
    }
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      const request = JSON.parse(line);
      if (request.method !== 'shutdown') continue;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
      process.exit(0);
    }
  `);
  let acquireCalls = 0;
  const released: number[] = [];
  let secondReleased!: () => void;
  const secondRelease = new Promise<void>(resolve => { secondReleased = resolve; });
  const runtimeManager = {
    async acquire() {
      acquireCalls += 1;
      const id = acquireCalls;
      await new Promise(resolve => setImmediate(resolve));
      return {
        cli: 'claude' as const,
        binaryPath: '/fake/claude',
        version: `${id}.0.0`,
        source: 'managed' as const,
        env: {
          SPAWN_LOG: spawnLog,
          RUNTIME_ID: String(id),
          ...(id === 2 ? { UNEXPECTED_EXIT: '1' } : {}),
        },
        async release() {
          released.push(id);
          if (id === 2) secondReleased();
        },
      };
    },
  };
  const manager = new ProxyManager({
    ...PROTOCOL_V2,
    dataDir: root,
    ccProxyEntry: proxyEntry,
    runtimeManager: runtimeManager as never,
  });
  const waitForSpawnIds = async (expected: number): Promise<string[]> => {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      try {
        const ids = (await readFile(spawnLog, 'utf8')).trim().split('\n').filter(Boolean);
        if (ids.length >= expected) return ids;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`expected ${expected} Proxy spawn markers`);
  };

  const [first, same] = await Promise.all([
    manager.getOrCreate('same-session', 'claude'),
    manager.getOrCreate('same-session', 'claude'),
  ]);
  assert.equal(first, same);
  assert.equal(acquireCalls, 1);
  assert.deepEqual(await waitForSpawnIds(1), ['1']);

  await manager.closeByExecutor('claude');
  assert.deepEqual(released, [1]);
  await manager.getOrCreate('same-session', 'claude');
  await Promise.race([
    secondRelease,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error('second runtime release timed out')), 3_000);
    }),
  ]);
  assert.deepEqual(released, [1, 2]);
  assert.deepEqual(await waitForSpawnIds(2), ['1', '2']);
  await manager.closeAll();
  assert.deepEqual(released, [1, 2], 'explicit close and exit callback are deduplicated');
});

test('an exited Proxy is never published after delayed process-group registration', async t => {
  for (const executor of ['claude', 'codex', 'kimi', 'grok'] as const) {
    const root = await mkdtemp(join(tmpdir(), `gian-${executor}-dead-publication-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const proxyEntry = join(root, 'early-exit-proxy.mjs');
    await writeFile(proxyEntry, `
      import { createInterface } from 'node:readline';
      if (process.env.EXIT_EARLY === '1') setTimeout(() => process.exit(17), 10);
      const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of input) {
        const request = JSON.parse(line);
        if (request.method !== 'shutdown') continue;
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
        process.exit(0);
      }
    `);
    let acquireCalls = 0;
    const releases: number[] = [];
    const runtimeManager = {
      async acquire() {
        acquireCalls += 1;
        const id = acquireCalls;
        return {
          cli: executor,
          binaryPath: `/fake/${executor}`,
          version: `${id}.0.0`,
          source: 'managed',
          env: id === 1 ? { EXIT_EARLY: '1' } : {},
          async reserveProcessGroup() {
            return {
              async register() {
                if (id === 1) await new Promise(resolve => setTimeout(resolve, 200));
                return 'registered' as const;
              },
              async cancelBeforeSpawn() {},
              async releaseUnregistered() {},
              async release() {},
            };
          },
          async release() { releases.push(id); },
        };
      },
    };
    const manager = new ProxyManager({
    ...PROTOCOL_V2,
      dataDir: root,
      ccProxyEntry: proxyEntry,
      ...(executor === 'codex' ? { codexProxyEntry: proxyEntry } : {}),
      ...(executor === 'kimi' ? { kimiProxyEntry: proxyEntry } : {}),
      ...(executor === 'grok' ? { grokProxyEntry: proxyEntry } : {}),
      runtimeManager: runtimeManager as never,
    });

    const client = await Promise.race([
      manager.getOrCreate(`${executor}-publication-session`, executor),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`${executor} dead-host retry timed out`)), 4_000);
      }),
    ]);
    assert.equal(acquireCalls, 2, `${executor} must replace the exited first process`);
    assert.equal(client.isExited(), false);
    assert.equal(manager.get(`${executor}-publication-session`), client);
    assert.deepEqual(releases, [1]);
    await manager.closeAll();
    assert.deepEqual(releases, [1, 2]);
  }
});

test('executor close waits for unexpected-exit runtime release after cache deletion', async t => {
  for (const executor of ['claude', 'codex', 'kimi', 'grok'] as const) {
    const root = await mkdtemp(join(tmpdir(), `gian-${executor}-release-barrier-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const proxyEntry = join(root, 'self-exit-proxy.mjs');
    await writeFile(proxyEntry, 'setTimeout(() => process.exit(29), 80);\n');
    let releaseCalls = 0;
    let releaseStarted!: () => void;
    const releasing = new Promise<void>(resolve => { releaseStarted = resolve; });
    let allowRelease!: () => void;
    const releaseGate = new Promise<void>(resolve => { allowRelease = resolve; });
    const runtimeManager = {
      async acquire() {
        return {
          cli: executor,
          binaryPath: `/fake/${executor}`,
          version: '1.0.0',
          source: 'managed',
          env: {},
          async release() {
            releaseCalls += 1;
            releaseStarted();
            await releaseGate;
          },
        };
      },
    };
    const manager = new ProxyManager({
    ...PROTOCOL_V2,
      dataDir: root,
      ccProxyEntry: proxyEntry,
      ...(executor === 'codex' ? { codexProxyEntry: proxyEntry } : {}),
      ...(executor === 'kimi' ? { kimiProxyEntry: proxyEntry } : {}),
      ...(executor === 'grok' ? { grokProxyEntry: proxyEntry } : {}),
      runtimeManager: runtimeManager as never,
    });
    const sessionId = `${executor}-release-barrier-session`;
    await manager.getOrCreate(sessionId, executor);
    await releasing;
    assert.equal(manager.get(sessionId), undefined);

    let closed = false;
    const closing = manager.closeByExecutor(executor).then(() => { closed = true; });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(closed, false, `${executor} close crossed the runtime release barrier`);
    allowRelease();
    await closing;
    assert.equal(releaseCalls, 1);
  }
});

test('failed runtime cleanup stays strongly reachable for later close retries', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-runtime-release-retry-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxyEntry = join(root, 'self-exit-proxy.mjs');
  await writeFile(proxyEntry, 'setTimeout(() => process.exit(31), 80);\n');
  let releaseCalls = 0;
  let firstReleaseStarted!: () => void;
  const firstRelease = new Promise<void>(resolve => { firstReleaseStarted = resolve; });
  const runtimeManager = {
    async acquire() {
      return {
        cli: 'claude' as const,
        binaryPath: '/fake/claude',
        version: '1.0.0',
        source: 'managed' as const,
        env: {},
        async release() {
          releaseCalls += 1;
          if (releaseCalls === 1) firstReleaseStarted();
          if (releaseCalls <= 2) throw new Error(`controlled release failure ${releaseCalls}`);
        },
      };
    },
  };
  const manager = new ProxyManager({
    ...PROTOCOL_V2,
    dataDir: root,
    ccProxyEntry: proxyEntry,
    runtimeManager: runtimeManager as never,
  });
  await manager.getOrCreate('release-retry-session', 'claude');
  await firstRelease;
  await new Promise(resolve => setImmediate(resolve));

  await assert.rejects(
    manager.closeByExecutor('claude'),
    (error: unknown) => error instanceof AggregateError
      && error.errors.some(item => /controlled release failure 1/.test(String(item))),
  );
  assert.equal(releaseCalls, 1, 'first close reports the already-failed automatic cleanup');
  await assert.rejects(
    manager.closeByExecutor('claude'),
    (error: unknown) => error instanceof AggregateError
      && error.errors.some(item => /controlled release failure 2/.test(String(item))),
  );
  assert.equal(releaseCalls, 2);
  await manager.closeByExecutor('claude');
  assert.equal(releaseCalls, 3);
  await manager.closeByExecutor('claude');
  assert.equal(releaseCalls, 3, 'successful cleanup removes the strong retry task');
});

test('throwing shared-facade exit handlers cannot interrupt host cleanup', async t => {
  for (const executor of ['codex', 'kimi'] as const) {
    const root = await mkdtemp(join(tmpdir(), `gian-${executor}-throwing-exit-handler-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const proxyEntry = join(root, 'throwing-handler-proxy.mjs');
    await writeFile(proxyEntry, `
      import { createInterface } from 'node:readline';
      const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of input) {
        const request = JSON.parse(line);
        ${PROTOCOL_V2_STDIO_BOOT}
        if (request.method !== 'session.create') continue;
        reply(request, {
          session: {
            id: request.params.sessionId,
            nativeSession: { id: process.env.TEST_EXECUTOR === 'codex' ? 'codex_throw_native' : 'kimi_throw_native' },
            streamId: 'stream-1',
            state: 'idle',
            sessionConfig: request.params.config ?? {},
            createdAt: new Date(0).toISOString(),
            updatedAt: new Date(0).toISOString(),
          },
        });
        setTimeout(() => process.exit(37), 30);
      }
    `);
    let releaseCalls = 0;
    let released!: () => void;
    const runtimeReleased = new Promise<void>(resolve => { released = resolve; });
    const runtimeManager = {
      async acquire() {
        return {
          cli: executor,
          binaryPath: `/fake/${executor}`,
          version: '1.0.0',
          source: 'managed',
          env: { TEST_EXECUTOR: executor },
          async release() { releaseCalls += 1; released(); },
        };
      },
    };
    const manager = new ProxyManager({
    ...PROTOCOL_V2,
      dataDir: root,
      ccProxyEntry: '/unused/cc-proxy.mjs',
      ...(executor === 'codex'
        ? { codexProxyEntry: proxyEntry }
        : { kimiProxyEntry: proxyEntry }),
      runtimeManager: runtimeManager as never,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const client = await manager.getOrCreate(`${executor}-throw-session`, executor);
      let laterHandlerCalls = 0;
      client.onExit(() => { throw new Error('controlled facade handler failure'); });
      client.onExit(() => { laterHandlerCalls += 1; });
      await client.createSession({ cwd: '/tmp' });
      await Promise.race([
        runtimeReleased,
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error(`${executor} runtime release timed out`)), 4_000);
        }),
      ]);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(laterHandlerCalls, 1);
      assert.deepEqual(unhandled, []);
      assert.equal(releaseCalls, 1);
      assert.equal(manager.get(`${executor}-throw-session`), undefined);
      await manager.closeAll();
      assert.equal(releaseCalls, 1);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  }
});

test('a Kimi host is removed from reuse before failed-attach retirement awaits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-retiring-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxyEntry = join(root, 'retiring-kimi-proxy.mjs');
  await writeFile(proxyEntry, `
    import { createInterface } from 'node:readline';
    const first = process.env.RUNTIME_ID === '1';
    if (first) process.on('SIGTERM', () => {});
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      const request = JSON.parse(line);
      ${PROTOCOL_V2_STDIO_BOOT}
      if (request.method === 'session.create') {
        if (first) {
          fail(request, {
            code: -32000,
            message: 'login required',
            data: { domainCode: 'RUNTIME_AUTH_REQUIRED', retryable: false, details: {} },
          });
        } else {
          reply(request, {
            session: {
              id: request.params.sessionId,
              nativeSession: { id: 'fresh_kimi_native' },
              streamId: 'stream-1',
              state: 'idle',
              sessionConfig: request.params.config ?? {},
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
            },
          });
        }
      } else if (request.method === 'shutdown' && !first) {
        reply(request, { ok: true });
        process.exit(0);
      }
    }
  `);
  let acquireCalls = 0;
  let releaseCalls = 0;
  const runtimeManager = {
    async acquire() {
      acquireCalls += 1;
      return {
        cli: 'kimi' as const,
        binaryPath: '/fake/kimi',
        version: `${acquireCalls}.0.0`,
        source: 'managed' as const,
        env: { RUNTIME_ID: String(acquireCalls) },
        async release() { releaseCalls += 1; },
      };
    },
  };
  const manager = new ProxyManager({
    ...PROTOCOL_V2,
    dataDir: root,
    ccProxyEntry: '/unused/cc-proxy.mjs',
    kimiProxyEntry: proxyEntry,
    runtimeManager: runtimeManager as never,
  });

  const failed = await manager.getOrCreate('failed-kimi-session', 'kimi');
  assert.ok(failed instanceof ProtocolV2SessionClient);
  await assert.rejects(failed.createSession({ cwd: '/tmp' }), /login required/);
  const oldHost = failed.runtimeHost();
  const disposing = manager.dispose('failed-kimi-session');
  let replacementSettled = false;
  const replacementPromise = manager.getOrCreate('replacement-kimi-session', 'kimi')
    .then(client => {
      replacementSettled = true;
      return client;
    });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(replacementSettled, false, 'replacement must wait for exact host retirement');
  assert.equal(acquireCalls, 1, 'replacement cannot acquire while the old host may still run');
  const replacement = await replacementPromise;
  assert.ok(replacement instanceof ProtocolV2SessionClient);
  assert.notEqual(replacement.runtimeHost(), oldHost);
  assert.equal(acquireCalls, 2);
  assert.equal(replacement.isExited(), false);
  await disposing;
  assert.equal(manager.get('replacement-kimi-session'), replacement);
  await manager.closeAll();
  assert.equal(releaseCalls, 2);
});

test('every dropped Kimi facade awaits the exact shared-host retirement', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-retirement-facades-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxyEntry = join(root, 'kimi-retirement-facades-proxy.mjs');
  await writeFile(proxyEntry, `
    import { createInterface } from 'node:readline';
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      const request = JSON.parse(line);
      if (request.method !== 'shutdown') continue;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
      process.exit(0);
    }
  `);
  let releaseCalls = 0;
  const manager = new ProxyManager({
    ...PROTOCOL_V2,
    dataDir: root,
    ccProxyEntry: '/unused/cc-proxy.mjs',
    kimiProxyEntry: proxyEntry,
    runtimeManager: {
      async acquire() {
        return {
          cli: 'kimi' as const,
          binaryPath: '/fake/kimi',
          version: '1.0.0',
          source: 'managed' as const,
          env: {},
          async release() { releaseCalls += 1; },
        };
      },
    } as never,
  });
  const first = await manager.getOrCreate('kimi-retire-a', 'kimi');
  const second = await manager.getOrCreate('kimi-retire-b', 'kimi');
  assert.ok(first instanceof ProtocolV2SessionClient);
  assert.ok(second instanceof ProtocolV2SessionClient);
  const host = first.runtimeHost();
  assert.equal(second.runtimeHost(), host);
  const originalShutdown = host.shutdown;
  let retirementStarted!: () => void;
  const retiring = new Promise<void>(resolve => { retirementStarted = resolve; });
  let allowRetirementFailure!: () => void;
  const retirementGate = new Promise<void>(resolve => { allowRetirementFailure = resolve; });
  host.shutdown = async () => {
    retirementStarted();
    await retirementGate;
    throw new Error('controlled exact Kimi retirement failure');
  };

  let firstDone = false;
  let secondDone = false;
  const disposeFirst = manager.dispose('kimi-retire-a').finally(() => { firstDone = true; });
  await retiring;
  const disposeSecond = manager.dispose('kimi-retire-b').finally(() => { secondDone = true; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(firstDone, false);
  assert.equal(secondDone, false, 'a dropped sibling facade must retain exact retirement ownership');
  allowRetirementFailure();
  await assert.rejects(disposeFirst, /controlled exact Kimi retirement failure/);
  await assert.rejects(disposeSecond, /controlled exact Kimi retirement failure/);

  host.shutdown = originalShutdown;
  await Promise.all([
    manager.dispose('kimi-retire-a'),
    manager.dispose('kimi-retire-b'),
  ]);
  assert.equal(releaseCalls, 1);
  await manager.closeAll();
});

test('dispose racing Kimi creation retires the newly published unattached host', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-kimi-create-dispose-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxyEntry = join(root, 'kimi-create-dispose-proxy.mjs');
  await writeFile(proxyEntry, `
    import { createInterface } from 'node:readline';
    const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of input) {
      const request = JSON.parse(line);
      if (request.method !== 'shutdown') continue;
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } }) + '\\n');
      process.exit(0);
    }
  `);
  let acquireCalls = 0;
  let firstAcquireStarted!: () => void;
  const firstAcquiring = new Promise<void>(resolve => { firstAcquireStarted = resolve; });
  let allowFirstAcquire!: () => void;
  const firstAcquireGate = new Promise<void>(resolve => { allowFirstAcquire = resolve; });
  const released: number[] = [];
  const runtimeManager = {
    async acquire() {
      acquireCalls += 1;
      const id = acquireCalls;
      if (id === 1) {
        firstAcquireStarted();
        await firstAcquireGate;
      }
      return {
        cli: 'kimi' as const,
        binaryPath: '/fake/kimi',
        version: `${id}.0.0`,
        source: 'managed' as const,
        env: {},
        async release() { released.push(id); },
      };
    },
  };
  const manager = new ProxyManager({
    ...PROTOCOL_V2,
    dataDir: root,
    ccProxyEntry: '/unused/cc-proxy.mjs',
    kimiProxyEntry: proxyEntry,
    runtimeManager: runtimeManager as never,
  });

  const getting = manager.getOrCreate('kimi-create-dispose-race', 'kimi');
  const otherGetting = manager.getOrCreate('kimi-create-dispose-other', 'kimi');
  await firstAcquiring;
  const disposing = manager.dispose('kimi-create-dispose-race');
  allowFirstAcquire();
  const [replacement, , other] = await Promise.all([getting, disposing, otherGetting]);
  assert.ok(replacement instanceof ProtocolV2SessionClient);
  assert.ok(other instanceof ProtocolV2SessionClient);
  assert.equal(replacement.runtimeHost(), other.runtimeHost());
  assert.equal(acquireCalls, 2, 'the unattached first host must be retired, not returned');
  assert.deepEqual(released, [1]);
  await manager.closeAll();
  assert.deepEqual(released, [1, 2]);
});

test('whole-executor close reaches bounded shared-host shutdown when session.close hangs', async t => {
  for (const executor of ['codex', 'kimi'] as const) {
    const root = await mkdtemp(join(tmpdir(), `gian-${executor}-hung-session-close-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const proxyEntry = join(root, 'hung-shared-proxy.mjs');
    await writeFile(proxyEntry, `
      import { createInterface } from 'node:readline';
      const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
      for await (const line of input) {
        const request = JSON.parse(line);
        ${PROTOCOL_V2_STDIO_BOOT}
        if (request.method === 'session.create') {
          reply(request, {
            session: {
              id: request.params.sessionId,
              nativeSession: { id: process.env.TEST_EXECUTOR === 'codex' ? 'codex_hung_native' : 'kimi_hung_native' },
              streamId: 'stream-1',
              state: 'idle',
              sessionConfig: request.params.config ?? {},
              createdAt: new Date(0).toISOString(),
              updatedAt: new Date(0).toISOString(),
            },
          });
        } else if (request.method === 'session.close' || request.method === 'shutdown') {
          // Deliberately never respond. Whole-executor close must bypass the
          // facade RPC and reach bounded host PGID escalation.
        }
      }
    `);
    let releaseCalls = 0;
    const runtimeManager = {
      async acquire() {
        return {
          cli: executor,
          binaryPath: `/fake/${executor}`,
          version: '1.0.0',
          source: 'managed',
          env: { TEST_EXECUTOR: executor },
          async release() { releaseCalls += 1; },
        };
      },
    };
    const manager = new ProxyManager({
    ...PROTOCOL_V2,
      dataDir: root,
      ccProxyEntry: '/unused/cc-proxy.mjs',
      ...(executor === 'codex'
        ? { codexProxyEntry: proxyEntry }
        : { kimiProxyEntry: proxyEntry }),
      runtimeManager: runtimeManager as never,
    });
    const client = await manager.getOrCreate(`${executor}-hung-session`, executor);
    await client.createSession({ cwd: '/tmp' });
    const disposing = manager.dispose(`${executor}-hung-session`);
    await new Promise(resolve => setImmediate(resolve));
    const startedAt = Date.now();
    await Promise.race([
      manager.closeByExecutor(executor),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error(`${executor} whole-executor close hung`)), 3_000);
      }),
    ]);
    await disposing;
    assert.ok(Date.now() - startedAt < 3_000);
    assert.equal(releaseCalls, 1);
    assert.equal(manager.get(`${executor}-hung-session`), undefined);
    await manager.closeAll();
    assert.equal(releaseCalls, 1);
  }
});

test('check-proxy-update route is read-only and rejects unknown agents', async t => {
  const root = await mkdtemp(join(tmpdir(), 'gian-proxy-check-route-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const proxyPath = join(root, 'proxy.mjs');
  await writeFile(proxyPath, 'export {};\n');
  const agents = await AgentManager.create({
    dataDir: join(root, 'data'),
    releaseVersion: '0.4.4',
    managedProxies: false,
    developmentProxyEntries: {
      claude: proxyPath,
      codex: proxyPath,
      kimi: proxyPath,
      grok: proxyPath,
    },
    homeDir: join(root, 'home'),
    pathEnv: '',
    fetchImpl: async () => {
      throw new Error('check-proxy-update must not fetch for development proxies');
    },
  });
  const runtimes = new CliRuntimeManager(
    agents.runtimeProviders(),
    agents.updateLockDataDir(),
  );
  const app = new Hono();
  registerAgentRoutes(app, {
    agents,
    runtimes,
    closeProxy: async () => undefined,
    capabilities: async () => ({ models: [], modes: [] }),
  });

  const unknown = await app.request('/api/agents/nope/check-proxy-update', { method: 'POST' });
  assert.equal(unknown.status, 404);

  const response = await app.request('/api/agents/claude/check-proxy-update', { method: 'POST' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    managed: false,
    // Development builds report the vendored/App fallback version for display.
    currentVersion: '0.4.4',
    latestVersion: null,
    updateAvailable: false,
  });
});
