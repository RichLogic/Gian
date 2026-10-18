import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execPath } from 'node:process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { AntigravityAcpClient } from '../src/runtime/acp-client.js';
import type { RuntimeStopped } from '../src/contracts.js';
import { AntigravityCleanupError, AntigravityRuntimeError } from '../src/runtime/errors.js';
import { harnessBasenames, serverBasenames } from '../src/runtime/layout.js';
import {
  stopOwnedProcess,
  type AntigravityProcessExit,
} from '../src/runtime/process-transport.js';

const skipWindows = { skip: process.platform === 'win32' };

function requiredName(names: readonly string[]): string {
  const name = names[0];
  if (name === undefined) throw new Error('missing runtime basename');
  return name;
}

/** Compiled tests live in dist/test. The .mjs fixture stays in the source tree. */
function sourceFixturePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const parent = dirname(here);
  const testDir = basename(here) === 'test' && basename(parent) === 'dist'
    ? join(parent, '..', 'test')
    : here;
  return join(testDir, 'fixtures', 'fake-antigravity-acp.mjs');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function serverWrapper(fixture: string): string {
  return `#!/bin/sh\nexec ${shellQuote(execPath)} ${shellQuote(fixture)} "$@"\n`;
}

async function installedFake(root: string): Promise<{ server: string; harness: string }> {
  const directory = join(root, 'extract');
  const server = join(directory, requiredName(serverBasenames()));
  const harness = join(directory, requiredName(harnessBasenames()));
  await mkdir(directory, { recursive: true });
  await writeFile(server, serverWrapper(sourceFixturePath()), { mode: 0o755 });
  await chmod(server, 0o755);
  await writeFile(harness, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await chmod(harness, 0o755);
  return { server, harness };
}

function idleLeader(): ChildProcess {
  return {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stdin: null,
  } as unknown as ChildProcess;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function readPid(path: string): Promise<number> {
  const pid = Number(await readFile(path, 'utf8'));
  assert.equal(Number.isInteger(pid), true);
  assert.equal(pid > 0, true);
  return pid;
}

async function killPid(pid: number): Promise<void> {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already exited.
  }
}

test('reaps a descendant after the leader exits on its own', skipWindows, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-orphan-'));
  const descendantPath = join(root, 'descendant.pid');
  const { server } = await installedFake(root);
  const client = new AntigravityAcpClient({
    binaryPath: server,
    cwd: dirname(server),
    gracefulStopMs: 1_000,
    env: {
      HOME: root,
      PATH: '',
      FAKE_AGY_ORPHAN: '1',
      FAKE_AGY_DESCENDANT_PID: descendantPath,
    },
  });
  const stopped = deferred<RuntimeStopped>();
  client.on('runtimeStopped', (event) => stopped.resolve(event));
  let descendant = 0;
  try {
    await client.ensureStarted();
    descendant = await readPid(descendantPath);
    const event = await stopped.promise;
    assert.equal(event.expected, false);
    assert.equal(processAlive(descendant), false);
  } finally {
    await client.stop().catch(() => undefined);
    if (descendant > 0) await killPid(descendant);
    await rm(root, { recursive: true, force: true });
  }
});

test('stop kills a stubborn leader and its harness descendant together', skipWindows, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-group-'));
  const leaderPath = join(root, 'leader.pid');
  const descendantPath = join(root, 'descendant.pid');
  const { server } = await installedFake(root);
  const client = new AntigravityAcpClient({
    binaryPath: server,
    cwd: dirname(server),
    gracefulStopMs: 200,
    env: {
      HOME: root,
      PATH: '',
      FAKE_AGY_STUBBORN: '1',
      FAKE_AGY_PID: leaderPath,
      FAKE_AGY_DESCENDANT_PID: descendantPath,
    },
  });
  let leader = 0;
  let descendant = 0;
  try {
    await client.ensureStarted();
    leader = await readPid(leaderPath);
    descendant = await readPid(descendantPath);
    assert.equal(processAlive(leader), true);
    assert.equal(processAlive(descendant), true);
    await client.stop();
    assert.equal(processAlive(leader), false);
    assert.equal(processAlive(descendant), false);
  } finally {
    if (leader > 0) await killPid(leader);
    if (descendant > 0) await killPid(descendant);
    await client.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('a held prompt stays open until session/cancel and never sends session/close', skipWindows, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-hold-'));
  const logPath = join(root, 'methods.log');
  const { server } = await installedFake(root);
  const client = new AntigravityAcpClient({
    binaryPath: server,
    cwd: dirname(server),
    gracefulStopMs: 1_000,
    env: {
      HOME: root,
      PATH: '',
      FAKE_AGY_HOLD_PROMPT: '1',
      FAKE_AGY_LOG: logPath,
    },
  });
  try {
    await client.ensureStarted();
    const turn = await client.dispatchPrompt({
      sessionId: 's1',
      prompt: [{ type: 'text', text: 'hi' }],
    });
    let settled = false;
    turn.response.then(() => {
      settled = true;
    }, () => {
      settled = true;
    });
    await delay(40);
    assert.equal(settled, false);
    await client.cancel('s1');
    const response = await turn.response;
    assert.equal(response.stopReason, 'cancelled');
    const methods = (await readFile(logPath, 'utf8')).trim().split('\n');
    assert.equal(methods.includes('session/prompt'), true);
    assert.equal(methods.includes('session/cancel'), true);
    assert.equal(methods.includes('session/close'), false);
    assert.equal(methods.includes('authenticate'), false);
    assert.equal(methods.includes('--version'), false);
  } finally {
    await client.stop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test('server wrappers exec the shared source fixture and do not copy it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agy-wrap-'));
  try {
    const first = await installedFake(join(root, 'a'));
    const second = await installedFake(join(root, 'b'));
    const fixture = sourceFixturePath();
    assert.equal(basename(fixture), 'fake-antigravity-acp.mjs');
    assert.equal(basename(dirname(fixture)), 'fixtures');
    assert.equal(basename(dirname(dirname(fixture))), 'test');
    assert.notEqual(basename(dirname(dirname(dirname(fixture)))), 'dist');
    const fixtureText = await readFile(fixture, 'utf8');
    assert.notEqual(first.server, second.server);
    for (const server of [first.server, second.server]) {
      const wrapper = await readFile(server, 'utf8');
      assert.equal(wrapper.startsWith('#!/bin/sh\n'), true);
      assert.equal(wrapper.includes(execPath), true);
      assert.equal(wrapper.includes(fixture), true);
      assert.equal(wrapper.includes('import {'), false);
      assert.notEqual(wrapper, fixtureText);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the post-SIGKILL wait fails closed when the leader never exits', { timeout: 2_000 }, async () => {
  const hung = new Promise<AntigravityProcessExit>(() => undefined);
  const started = Date.now();
  await assert.rejects(
    stopOwnedProcess(idleLeader(), hung, hung, 40, true),
    (error: unknown) => error instanceof AntigravityCleanupError
      && /did not exit within 40ms after SIGKILL/.test(error.message),
  );
  assert.equal(Date.now() - started < 1_000, true);
});

test('stop returns when the owned exit settles and still reports a reap failure', async () => {
  const settled: AntigravityProcessExit = { code: 0, signal: null };
  await stopOwnedProcess(idleLeader(), Promise.resolve(settled), Promise.resolve(settled), 1_000, true);
  const failure = Promise.reject(new AntigravityRuntimeError('group still has descendants'));
  await assert.rejects(
    stopOwnedProcess(
      idleLeader(),
      Promise.resolve({ code: null, signal: 'SIGKILL' }),
      failure,
      1_000,
      true,
    ),
    /group still has descendants/,
  );
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
