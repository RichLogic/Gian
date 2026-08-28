import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { listProcessGroup, resolveDshBinary } from './run-dsh-bridge-canary.mjs';

const execFileAsync = promisify(execFile);
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const bridgePackageDir = join(rootDir, 'packages/proxies/dsh-bridge');
const defaultProxyPath = join(rootDir, 'packages/proxies/dsh-proxy/dist/src/cli/spawn.js');
const defaultTimeoutMs = 120_000;
const shutdownTimeoutMs = 15_000;
const credentialName = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i;
const ansiSequence = /\u001B(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/;

function sleep(ms) {
  return new Promise(resolveWait => setTimeout(resolveWait, ms));
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolveWait, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for DSH proxy exit after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveWait({ code, signal });
    });
  });
}

function isolatedEnvironment(home) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!credentialName.test(key) && value !== undefined) environment[key] = value;
  }
  return {
    ...environment,
    DSH_HOME: home,
    DSH_PERMISSION_MODE: 'read-only',
    DSH_TELEMETRY_DISABLED: '1',
    FORCE_COLOR: '0',
    NO_COLOR: '1',
  };
}

async function createIsolatedProfile(canaryRoot, packageDir) {
  const home = join(canaryRoot, 'home');
  const profileDir = join(home, 'profiles/gian');
  const scopedModules = join(profileDir, 'node_modules/@gian');
  await mkdir(scopedModules, { recursive: true });
  await writeFile(join(profileDir, 'package.json'), `${JSON.stringify({
    name: 'gian-dsh-proxy-canary-profile',
    private: true,
    dependencies: { '@gian/dsh-bridge': `file:${packageDir}` },
    dsh: {
      profile: {
        bundles: ['@deepseek-ai/dsh-base', '@gian/dsh-bridge'],
      },
    },
  }, null, 2)}\n`, 'utf8');
  await symlink(packageDir, join(scopedModules, 'dsh-bridge'), 'dir');
  return { home, profileDir };
}

async function installedDshVersion(binaryPath) {
  const result = await execFileAsync(binaryPath, ['--version'], {
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  assert.equal(String(result.stderr ?? ''), '', 'dsh --version wrote to stderr.');
  const version = String(result.stdout ?? '').trim();
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, 'dsh --version was not a version string.');
  return version;
}

async function resolveMockServerModule(options) {
  const candidates = [
    options.mockServerPath,
    process.env.DSH_LLM_MOCK_SERVER_PATH,
    join(rootDir, '.dsh-runtime/node_modules/@deepseek-ai/dsh-llm-mock-server/lib/index.js'),
    join(bridgePackageDir, '.dsh-runtime/node_modules/@deepseek-ai/dsh-llm-mock-server/lib/index.js'),
    join(rootDir, 'node_modules/@deepseek-ai/dsh-llm-mock-server/lib/index.js'),
  ].filter(Boolean).map(candidate => resolve(candidate));

  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.R_OK);
      return import(pathToFileURL(candidate).href);
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(
    `No installed @deepseek-ai/dsh-llm-mock-server found. Expected ${join(rootDir, '.dsh-runtime/node_modules/@deepseek-ai/dsh-llm-mock-server/lib/index.js')} or set DSH_LLM_MOCK_SERVER_PATH.`,
  );
}

class DshProxyClient {
  constructor(options) {
    this.options = options;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stderr = '';
    this.rawStdout = '';
    this.exitResult = null;
    this.protocolFailure = null;
  }

  start() {
    if (this.child) return;
    const child = spawn(process.execPath, [this.options.proxyPath], {
      cwd: this.options.cwd ?? rootDir,
      env: {
        ...this.options.environment,
        GIAN_RUNTIME_BIN: this.options.binaryPath,
        GIAN_DSH_HOST_ENTRY: this.options.binaryPath,
      },
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      this.rawStdout += `${line}\n`;
      if (line.trim() === '') {
        this.fail(new Error('DSH proxy emitted a blank non-protocol stdout line.'));
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.fail(new Error(`DSH proxy emitted invalid JSON: ${error.message}: ${line}`));
        return;
      }
      if (message?.jsonrpc !== '2.0') {
        this.fail(new Error(`DSH proxy emitted a non-JSON-RPC envelope: ${line}`));
        return;
      }
      if (typeof message.id === 'string') {
        const pending = this.pending.get(message.id);
        if (!pending) {
          this.fail(new Error(`DSH proxy emitted an unexpected response id ${message.id}.`));
          return;
        }
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          const error = new Error(message.error.message ?? 'DSH proxy request failed.');
          error.code = message.error.data?.domainCode ?? message.error.code;
          pending.reject(error);
        } else {
          pending.resolve(message.result);
        }
        return;
      }
      if (typeof message.method === 'string' && message.id === undefined) {
        this.notifications.push(message);
        return;
      }
      this.fail(new Error(`DSH proxy emitted an invalid JSON-RPC message: ${line}`));
    });
    child.stderr.on('data', chunk => {
      if (this.stderr.length < 64 * 1024) this.stderr += chunk.toString();
    });
    child.once('error', error => this.fail(error));
    child.once('exit', (code, signal) => {
      this.exitResult = { code, signal };
      if (this.pending.size > 0) {
        this.fail(new Error(
          `DSH proxy exited with pending requests (code=${code}, signal=${signal}).${this.stderrSuffix()}`,
        ));
      }
    });
  }

  stderrSuffix() {
    return this.stderr.trim() ? `\n${this.stderr.trim()}` : '';
  }

  fail(error) {
    if (!this.protocolFailure) this.protocolFailure = error;
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  async request(method, params = {}, timeoutMs = this.options.timeoutMs ?? defaultTimeoutMs) {
    this.start();
    if (this.protocolFailure) throw this.protocolFailure;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`DSH proxy is not running.${this.stderrSuffix()}`);
    }
    const id = `canary-${this.nextId++}`;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(
          `Timed out waiting for DSH proxy ${method} after ${timeoutMs}ms.${this.stderrSuffix()}`,
        ));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        reject(error);
      });
    });
  }

  async waitFor(predicate, label, from = 0, timeoutMs = this.options.timeoutMs ?? defaultTimeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.notifications.slice(from).find(predicate);
      if (found) return found;
      await sleep(25);
    }
    throw new Error(
      `Timed out waiting for ${label} after ${timeoutMs}ms. Last notifications: ${JSON.stringify(this.notifications.slice(-20))}.${this.stderrSuffix()}`,
    );
  }

  async waitForExit(timeoutMs) {
    if (!this.child) return { code: null, signal: null };
    const result = await waitForExit(this.child, timeoutMs);
    this.exitResult ??= result;
    return this.exitResult;
  }

  assertStdoutPurity() {
    assert.equal(this.protocolFailure, null, this.protocolFailure?.message);
    assert.equal(ansiSequence.test(this.rawStdout), false, 'DSH proxy stdout contained ANSI control sequences.');
  }

  async forceStop() {
    const child = this.child;
    if (!child?.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    } catch {
      return;
    }
    await waitForExit(child, 2_000).catch(() => {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // The owned process group already exited.
      }
    });
  }
}

async function waitForEmptyProcessGroup(processGroupId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let remaining = await listProcessGroup(processGroupId);
  while (remaining.length > 0 && Date.now() < deadline) {
    await sleep(50);
    remaining = await listProcessGroup(processGroupId);
  }
  return remaining;
}

export async function runDshProxyCanary(options = {}) {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const proxyPath = options.proxyPath ?? defaultProxyPath;
  const binaryPath = await resolveDshBinary(
    options.binaryPath ?? process.env.DSH_PROXY_CANARY_BIN ?? process.env.DSH_BRIDGE_CANARY_BIN,
  );
  const dshVersion = await installedDshVersion(binaryPath);
  const mockModule = await resolveMockServerModule(options);
  const mockServer = await mockModule.startMockLlmServer({
    host: '127.0.0.1',
    port: 0,
    apiKey: 'mock-key',
    sequence: ['success'],
    repeatLast: true,
    successText: 'hello from gian dsh mock',
    chunkSize: 12,
    chunkDelayMs: 5,
  });
  const canaryRoot = await mkdtemp(join(tmpdir(), 'gian-dsh-proxy-canary-'));
  const workspace = join(canaryRoot, 'workspace');
  let client;
  let processGroupId;

  try {
    await mkdir(workspace, { recursive: true });
    const profile = await createIsolatedProfile(
      canaryRoot,
      options.bridgePackageDir ?? bridgePackageDir,
    );
    const environment = {
      ...isolatedEnvironment(profile.home),
      DEEPSEEK_BASE_URL: `${mockServer.baseURL}/v1`,
      DEEPSEEK_API_KEY: 'mock-key',
    };
    client = new DshProxyClient({
      proxyPath,
      binaryPath,
      cwd: workspace,
      environment,
      timeoutMs,
    });

    const initialized = await client.request('initialize', {
      protocol: { name: 'gian.proxy', versions: ['2.1'] },
      host: { name: 'Gian DSH proxy canary', version: '0.0.0' },
    });
    assert.equal(initialized?.protocol?.version, '2.0');
    assert.equal(initialized?.plugin?.id, 'ai.deepseek.harness');
    assert.equal(initialized?.process?.scope, 'shared');
    assert.equal(initialized?.capabilities?.['event.step'], 1);
    assert.equal(initialized?.capabilities?.['event.request'], 1);
    assert.equal(initialized?.capabilities?.['event.usage'], 1);

    const catalog = await client.request('catalog.list');
    assert.equal(typeof catalog?.catalogRevision, 'string');
    assert.ok(Array.isArray(catalog?.configOptions));
    assert.ok(catalog.configOptions.some(option => option?.id === 'model'));

    const sessionId = `gian-dsh-proxy-${randomUUID()}`;
    const created = await client.request('session.create', {
      sessionId,
      workspace: { cwd: workspace, roots: [workspace] },
      config: {},
    });
    assert.equal(created?.session?.id, sessionId);
    assert.equal(created?.session?.state, 'idle');
    const streamId = created.session.streamId;
    assert.equal(typeof streamId, 'string');

    processGroupId = client.child?.pid;
    assert.ok(Number.isInteger(processGroupId) && processGroupId > 0);

    const turnId = `gian-dsh-turn-${randomUUID()}`;
    const started = await client.request('turn.start', {
      sessionId,
      streamId,
      turnId,
      input: [{ type: 'text', text: 'hello from the DSH proxy canary' }],
      config: { model: 'deepseek-chat' },
    });
    assert.equal(started?.accepted, true);
    assert.equal(started?.turnId, turnId);

    const completed = await client.waitFor(
      notification => notification?.method === 'turn.completed'
        && notification?.params?.sessionId === sessionId
        && notification?.params?.turnId === turnId,
      `turn ${turnId} completion`,
    );
    assert.ok(completed);

    const methods = new Set(client.notifications.map(notification => notification.method));
    for (const expected of ['turn.started', 'step.updated', 'request.updated', 'content.delta', 'content.completed', 'usage.updated', 'turn.completed']) {
      assert.ok(methods.has(expected), `expected DSH proxy notification ${expected}; saw ${[...methods].join(', ')}`);
    }

    const replay = await client.request('session.replay', {
      sessionId,
      streamId,
      cursor: null,
      limit: 500,
    });
    assert.equal(typeof replay?.replayStreamId, 'string');
    assert.ok(Array.isArray(replay?.events));
    assert.ok(replay.events.some(event => event?.method === 'turn.completed'));
    assert.ok(replay.events.some(event => event?.method === 'usage.updated' || event?.method === 'content.completed'));

    const closed = await client.request('session.close', { sessionId, streamId });
    assert.equal(closed?.ok, true);
    const shutdown = await client.request('shutdown');
    assert.equal(shutdown?.ok, true);

    const exit = await client.waitForExit(shutdownTimeoutMs);
    assert.equal(exit.code, 0, `DSH proxy exited with signal ${exit.signal}.${client.stderrSuffix()}`);
    assert.equal(exit.signal, null);
    client.assertStdoutPurity();

    assert.ok(mockServer.requests.length >= 1, 'mock LLM server received no chat completion request.');
    const mockRequest = mockServer.requests[0];
    assert.ok(mockRequest.path.endsWith('/chat/completions'));
    assert.equal(typeof mockRequest.body?.model, 'string');

    const remainingProcesses = await waitForEmptyProcessGroup(processGroupId, 2_000);
    assert.deepEqual(
      remainingProcesses,
      [],
      `DSH proxy process group ${processGroupId} left residual processes: ${JSON.stringify(remainingProcesses)}`,
    );

    return {
      runtime: {
        package: '@deepseek-ai/dsh',
        version: dshVersion,
        binary: relative(rootDir, binaryPath),
        profile: 'gian',
        bundles: ['@deepseek-ai/dsh-base', '@gian/dsh-bridge'],
      },
      proxy: {
        pluginId: 'ai.deepseek.harness',
        protocol: 'gian.proxy/2.1',
        processScope: 'shared',
        binary: relative(rootDir, proxyPath),
      },
      mockLlm: {
        package: '@deepseek-ai/dsh-llm-mock-server',
        baseURL: mockServer.baseURL,
        randomSeed: mockServer.randomSeed,
        requests: mockServer.requests.length,
      },
      quotaConsuming: false,
      modelTurnsSent: 0,
      lifecycle: ['initialize', 'catalog.list', 'session.create', 'turn.start', 'turn.completed', 'session.replay', 'session.close', 'shutdown'],
      notifications: {
        total: client.notifications.length,
        methods: [...new Set(client.notifications.map(notification => notification.method))],
      },
      processTree: {
        processGroupId,
        residualProcesses: 0,
      },
      stderrBytes: Buffer.byteLength(client.stderr),
    };
  } finally {
    await client?.forceStop();
    if (processGroupId) await waitForEmptyProcessGroup(processGroupId, 2_000).catch(() => []);
    await mockServer.close().catch(() => undefined);
    await rm(canaryRoot, { recursive: true, force: true });
  }
}

export async function main() {
  const summary = await runDshProxyCanary();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`DSH proxy canary failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
