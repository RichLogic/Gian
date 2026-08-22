import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const bridgePackageDir = join(rootDir, 'packages/proxies/dsh-bridge');
const defaultTimeoutMs = 60_000;
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
      () => reject(new Error(`Timed out waiting for DSH exit after ${timeoutMs}ms.`)),
      timeoutMs,
    );
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveWait({ code, signal });
    });
  });
}

async function executable(path) {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveDshBinary(explicitPath) {
  const candidates = [
    explicitPath,
    process.env.DSH_BRIDGE_CANARY_BIN,
    join(bridgePackageDir, '.dsh-runtime/node_modules/.bin/dsh'),
    join(rootDir, '.dsh-runtime/node_modules/.bin/dsh'),
    join(rootDir, 'node_modules/.bin/dsh'),
  ].filter(Boolean).map(candidate => resolve(candidate));

  for (const candidate of candidates) {
    if (await executable(candidate)) return candidate;
  }
  throw new Error(
    `No installed DSH binary found. Expected ${join(bridgePackageDir, '.dsh-runtime/node_modules/.bin/dsh')} or set DSH_BRIDGE_CANARY_BIN.`,
  );
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
    name: 'gian-dsh-bridge-canary-profile',
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

export async function listProcessGroup(processGroupId, execImpl = execFileAsync) {
  if (process.platform === 'win32') return [];
  const result = await execImpl('ps', ['-axo', 'pid=,ppid=,pgid=,command='], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  });
  return String(result.stdout ?? '')
    .split('\n')
    .map(line => line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(match => ({
      pid: Number(match[1]),
      parentPid: Number(match[2]),
      processGroupId: Number(match[3]),
      command: match[4],
    }))
    .filter(process => process.processGroupId === processGroupId);
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

class DshBridgeClient {
  constructor(options) {
    this.options = options;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.notifications = [];
    this.stdoutLines = [];
    this.rawStdout = '';
    this.stderr = '';
    this.protocolFailure = null;
    this.exitResult = null;
  }

  start() {
    if (this.child) return;
    const child = spawn(this.options.binaryPath, ['--profile', 'gian'], {
      cwd: this.options.cwd,
      env: this.options.environment,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', chunk => {
      this.rawStdout += chunk.toString();
    });
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
      this.handleLine(line);
    });
    child.stderr.on('data', chunk => {
      if (this.stderr.length < 64 * 1024) this.stderr += chunk.toString();
    });
    child.once('error', error => this.fail(error));
    child.once('exit', (code, signal) => {
      this.exitResult = { code, signal };
      if (this.pending.size > 0) {
        this.fail(new Error(
          `DSH exited with pending bridge requests (code=${code}, signal=${signal}).${this.stderrSuffix()}`,
        ));
      }
    });
  }

  stderrSuffix() {
    return this.stderr.trim() ? `\n${this.stderr.trim()}` : '';
  }

  handleLine(line) {
    this.stdoutLines.push(line);
    if (line.length === 0) {
      this.fail(new Error('DSH stdout contained a blank non-protocol line.'));
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.fail(new Error(`DSH stdout was not Bridge JSON-RPC: ${error.message}: ${line}`));
      return;
    }
    if (message?.jsonrpc !== '2.0') {
      this.fail(new Error(`DSH stdout contained a non-Bridge envelope: ${line}`));
      return;
    }
    if (typeof message.id === 'string') {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.fail(new Error(`DSH emitted an unexpected response id ${message.id}.`));
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error.message ?? 'DSH bridge request failed.');
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
    this.fail(new Error(`DSH stdout contained an invalid Bridge JSON-RPC message: ${line}`));
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

  async request(method, params = {}) {
    this.start();
    if (this.protocolFailure) throw this.protocolFailure;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`DSH is not running.${this.stderrSuffix()}`);
    }
    const id = `canary-${this.nextId++}`;
    return new Promise((resolveRequest, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(
          `Timed out waiting for DSH bridge ${method} after ${this.options.timeoutMs}ms.${this.stderrSuffix()}`,
        ));
      }, this.options.timeoutMs);
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

  async waitForExit(timeoutMs) {
    const result = await waitForExit(this.child, timeoutMs);
    this.exitResult ??= result;
    return this.exitResult;
  }

  assertStdoutPurity() {
    assert.equal(this.protocolFailure, null, this.protocolFailure?.message);
    assert.equal(ansiSequence.test(this.rawStdout), false, 'DSH stdout contained ANSI control sequences.');
    assert.ok(this.stdoutLines.length >= 5, 'DSH emitted fewer Bridge messages than requests sent.');
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

export async function runDshBridgeCanary(options = {}) {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  const binaryPath = await resolveDshBinary(options.binaryPath);
  const dshVersion = await installedDshVersion(binaryPath);
  const canaryRoot = await mkdtemp(join(tmpdir(), 'gian-dsh-bridge-canary-'));
  const workspace = join(canaryRoot, 'workspace');
  let client;
  let processGroupId;

  try {
    await mkdir(workspace, { recursive: true });
    const profile = await createIsolatedProfile(
      canaryRoot,
      options.bridgePackageDir ?? bridgePackageDir,
    );
    client = new DshBridgeClient({
      binaryPath,
      cwd: workspace,
      environment: isolatedEnvironment(profile.home),
      timeoutMs,
    });

    const initialized = await client.request('initialize', {
      protocol: { name: 'gian.dsh.bridge', versions: ['1.0'] },
      host: { name: 'Gian DSH canary', version: '0.0.0' },
    });
    assert.equal(initialized?.protocol?.version, '1.0');
    assert.equal(initialized?.plugin?.id, 'ai.deepseek.harness');
    assert.equal(initialized?.runtime?.package, '@deepseek-ai/dsh');
    assert.equal(initialized?.runtime?.version, dshVersion);

    const catalog = await client.request('catalog.list');
    assert.equal(typeof catalog?.catalogRevision, 'string');
    assert.ok(Array.isArray(catalog?.providers));
    assert.ok(Array.isArray(catalog?.models));

    const sessionId = `gian-canary-${randomUUID()}`;
    const created = await client.request('session.create', {
      sessionId,
      workspace: { cwd: workspace, roots: [workspace] },
      config: {},
    });
    assert.equal(created?.session?.id, sessionId);
    assert.equal(typeof created?.session?.nativeId, 'string');
    assert.equal(created?.session?.state, 'idle');

    processGroupId = client.child?.pid;
    assert.ok(Number.isInteger(processGroupId) && processGroupId > 0);
    const liveProcesses = await listProcessGroup(processGroupId);
    assert.ok(liveProcesses.some(process => process.pid === processGroupId));

    const closed = await client.request('session.close', { sessionId });
    assert.equal(closed?.ok, true);
    const shutdown = await client.request('shutdown');
    assert.equal(shutdown?.ok, true);

    const exit = await client.waitForExit(shutdownTimeoutMs);
    assert.equal(exit.code, 0, `DSH exited with signal ${exit.signal}.${client.stderrSuffix()}`);
    assert.equal(exit.signal, null);
    client.assertStdoutPurity();

    const remainingProcesses = await waitForEmptyProcessGroup(processGroupId, 2_000);
    assert.deepEqual(
      remainingProcesses,
      [],
      `DSH process group ${processGroupId} left residual processes: ${JSON.stringify(remainingProcesses)}`,
    );

    return {
      runtime: {
        package: '@deepseek-ai/dsh',
        version: dshVersion,
        binary: relative(rootDir, binaryPath),
        profile: 'gian',
        bundles: ['@deepseek-ai/dsh-base', '@gian/dsh-bridge'],
      },
      quotaConsuming: false,
      modelTurnsSent: 0,
      lifecycle: ['initialize', 'catalog.list', 'session.create', 'session.close', 'shutdown'],
      stdoutPurity: {
        jsonRpcLines: client.stdoutLines.length,
        notifications: client.notifications.length,
        bannerFree: true,
        ansiFree: true,
      },
      processTree: {
        processGroupId,
        observedProcesses: liveProcesses.length,
        residualProcesses: 0,
      },
      stderrBytes: Buffer.byteLength(client.stderr),
    };
  } finally {
    await client?.forceStop();
    if (processGroupId) await waitForEmptyProcessGroup(processGroupId, 2_000).catch(() => []);
    await rm(canaryRoot, { recursive: true, force: true });
  }
}

export async function main() {
  const summary = await runDshBridgeCanary();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => {
    process.stderr.write(`DSH bridge canary failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  });
}
