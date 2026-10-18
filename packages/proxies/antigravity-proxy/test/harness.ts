import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface, type Interface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import { HostProtocolValidator } from '@gian/proxy-protocol';

import { harnessBasenames, serverBasenames } from '../src/runtime/layout.js';

export interface OutgoingLine {
  kind: 'result' | 'error' | 'notification';
  id?: string;
  method?: string;
  payload: Record<string, unknown>;
}

interface Reader {
  match: (line: OutgoingLine) => boolean;
  resolve: (line: OutgoingLine) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const REQUEST_TIMEOUT_MS = 8_000;
const EXIT_TIMEOUT_MS = 10_000;

function requiredName(names: readonly string[]): string {
  const name = names[0];
  if (name === undefined) throw new Error('missing runtime basename');
  return name;
}

export function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const parent = dirname(here);
  return basename(here) === 'test' && basename(parent) === 'dist' ? dirname(parent) : parent;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function pluginVersion(): string {
  const raw = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')) as { version?: string };
  if (typeof raw.version !== 'string' || raw.version.length === 0) {
    throw new Error('Antigravity package version is unavailable.');
  }
  return raw.version;
}

export function compiledSpawnPath(): string {
  const spawnPath = join(packageRoot(), 'dist', 'src', 'cli', 'spawn.js');
  if (!existsSync(spawnPath)) throw new Error(`Compiled proxy entry is missing: ${spawnPath}`);
  return spawnPath;
}

function classify(payload: Record<string, unknown>): OutgoingLine {
  if (typeof payload.method === 'string') {
    return { kind: 'notification', method: payload.method, payload };
  }
  const id = typeof payload.id === 'string' ? payload.id : undefined;
  if (payload.error !== undefined) return { kind: 'error', ...(id === undefined ? {} : { id }), payload };
  return { kind: 'result', ...(id === undefined ? {} : { id }), payload };
}

function observed<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => undefined);
  return promise;
}

/** Bounded stdio client. The test process environment is never replaced. */
class LineSession {
  readonly child: ChildProcessWithoutNullStreams;
  readonly validator: HostProtocolValidator | undefined;
  private readonly originalHome: string | undefined;
  private readonly directory: string;
  private readonly reader: Interface;
  private readonly pending: OutgoingLine[] = [];
  private readonly readers: Reader[] = [];
  private readonly timers = new Set<NodeJS.Timeout>();
  private stderr = '';
  private disposed = false;
  private protocolError: Error | undefined;

  constructor(
    child: ChildProcessWithoutNullStreams,
    directory: string,
    validator: HostProtocolValidator | undefined,
    originalHome: string | undefined,
  ) {
    this.child = child;
    this.directory = directory;
    this.validator = validator;
    this.originalHome = originalHome;
    this.reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.onLine(line));
    this.reader.on('error', () => undefined);
    child.stdin.on('error', () => undefined);
    child.stdout.on('error', () => undefined);
    child.stderr.on('error', () => undefined);
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = `${this.stderr}${chunk.toString()}`.slice(-2_000);
    });
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code, signal) => {
      if (this.disposed || this.readers.length === 0) return;
      this.fail(new Error(`proxy exited (${code ?? signal}) before the test finished.${this.detail()}`));
    });
  }

  private detail(): string {
    return this.stderr === '' ? '' : ` stderr: ${this.stderr}`;
  }

  private onLine(line: string): void {
    const trimmed = line.trim();
    if (trimmed === '') return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(trimmed) as Record<string, unknown>;
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error('Proxy stdout was not JSON.'));
      return;
    }
    if (this.validator) {
      try {
        this.validator.acceptLine(trimmed);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error('HostProtocolValidator rejected a proxy line.'));
        return;
      }
    }
    this.push(classify(payload));
  }

  private push(line: OutgoingLine): void {
    const index = this.readers.findIndex((reader) => reader.match(line));
    if (index < 0) {
      this.pending.push(line);
      return;
    }
    const reader = this.readers[index];
    this.readers.splice(index, 1);
    if (!reader) return;
    clearTimeout(reader.timer);
    this.timers.delete(reader.timer);
    reader.resolve(line);
  }

  private fail(error: Error, record = true): void {
    if (record) this.protocolError ??= error;
    for (const reader of this.readers.splice(0)) {
      clearTimeout(reader.timer);
      this.timers.delete(reader.timer);
      reader.reject(error);
    }
  }

  private raiseIfFailed(): void {
    if (this.protocolError) throw this.protocolError;
  }

  pendingLines(): readonly OutgoingLine[] {
    return this.pending;
  }

  take(
    match: (line: OutgoingLine) => boolean,
    timeoutMs = REQUEST_TIMEOUT_MS,
    label = 'proxy line',
  ): Promise<OutgoingLine> {
    this.raiseIfFailed();
    const existing = this.pending.findIndex(match);
    if (existing >= 0) {
      const line = this.pending[existing];
      this.pending.splice(existing, 1);
      if (line) return Promise.resolve(line);
    }
    return observed(new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.readers.findIndex((reader) => reader.timer === timer);
        if (index >= 0) this.readers.splice(index, 1);
        this.timers.delete(timer);
        reject(new Error(`${label} timed out.${this.detail()}`));
      }, timeoutMs);
      this.timers.add(timer);
      this.readers.push({ match, resolve, reject, timer });
    }));
  }

  request(
    method: string,
    params: Record<string, unknown>,
    id: string,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<OutgoingLine> {
    this.raiseIfFailed();
    if (!this.validator) throw new Error('This proxy session is not checked by HostProtocolValidator.');
    this.validator.registerRequest({ jsonrpc: '2.0', id, method, params });
    const pending = this.take(
      (item) => (item.kind === 'result' || item.kind === 'error') && item.id === id,
      timeoutMs,
      method,
    );
    try {
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    } catch (error) {
      this.fail(error instanceof Error ? error : new Error(`${method} write failed`));
    }
    return observed(pending.then((line) => {
      if (line.kind === 'error') {
        throw new Error(`${method} failed: ${JSON.stringify(line.payload.error)}`);
      }
      return line;
    }));
  }

  nextObject(timeoutMs = REQUEST_TIMEOUT_MS): Promise<Record<string, unknown>> {
    return observed(this.take(() => true, timeoutMs, 'stdout line').then((line) => line.payload));
  }

  endInput(): void {
    if (this.child.stdin.writable) this.child.stdin.end();
  }

  waitForExit(timeoutMs = EXIT_TIMEOUT_MS): Promise<number | null> {
    const finished = this.child.exitCode !== null || this.child.signalCode !== null
      ? Promise.resolve(this.child.exitCode)
      : new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.child.off('exit', onExit);
          this.timers.delete(timer);
          reject(new Error(`proxy process did not exit.${this.detail()}`));
        }, timeoutMs);
        this.timers.add(timer);
        const onExit = (code: number | null): void => {
          clearTimeout(timer);
          this.timers.delete(timer);
          resolve(code);
        };
        this.child.once('exit', onExit);
      });
    return finished.then((code) => {
      this.raiseIfFailed();
      return code;
    }, (error: Error) => {
      this.raiseIfFailed();
      throw error;
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
    });
  }

  async waitUntilDead(pid: number, timeoutMs = 1_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (alive(pid)) {
      if (Date.now() >= deadline) {
        throw new Error(`Owned process ${pid} was still alive after ${timeoutMs}ms.`);
      }
      await this.delay(50);
    }
  }

  async dispose(pidPath?: string): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.fail(new Error('stdio harness disposed'), false);
    this.reader.close();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.endInput();
      await this.waitForExit(1_000).catch(() => undefined);
      if (this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill('SIGKILL');
        await this.waitForExit(1_000).catch(() => undefined);
      }
    }
    if (pidPath !== undefined && existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, 'utf8'));
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ }
      }
    }
    rmSync(this.directory, { recursive: true, force: true });
    this.raiseIfFailed();
    if (process.env.HOME !== this.originalHome) {
      throw new Error('The test mutated process.env.HOME.');
    }
  }
}

function spawnCompiled(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  nodeArgs: readonly string[] = [],
): ChildProcessWithoutNullStreams {
  const child = spawn(process.execPath, [...nodeArgs, compiledSpawnPath(), ...args], {
    cwd: packageRoot(),
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    child.kill('SIGKILL');
    throw new Error('Proxy stdio pipes were not created.');
  }
  return child as ChildProcessWithoutNullStreams;
}

export interface DirectProxyOptions {
  args?: readonly string[];
  extraEnv?: Readonly<Record<string, string>>;
  validate: boolean;
}

interface DirectChild {
  directory: string;
  isolatedPath: string;
  pluginVersion: string;
  session: LineSession;
}

function startDirect(options: DirectProxyOptions): DirectChild {
  const originalHome = process.env.HOME;
  const version = pluginVersion();
  compiledSpawnPath();
  const directory = mkdtempSync(join(tmpdir(), 'agy-direct-'));
  const isolatedPath = join(directory, 'path');
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    mkdirSync(isolatedPath, { recursive: true });
    child = spawnCompiled(options.args ?? [], {
      PATH: isolatedPath,
      HOME: directory,
      TMPDIR: directory,
      ...options.extraEnv,
    });
    return {
      directory,
      isolatedPath,
      pluginVersion: version,
      session: new LineSession(
        child,
        directory,
        options.validate ? new HostProtocolValidator({
          pluginId: 'io.gian.antigravity',
          pluginVersion: version,
          processScope: 'shared',
        }) : undefined,
        originalHome,
      ),
    };
  } catch (error) {
    child?.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Self-test and bootstrap child. No ACP server is installed. */
export class DirectProxy {
  readonly directory: string;
  readonly isolatedPath: string;
  readonly pluginVersion: string;
  private readonly session: LineSession;

  constructor(options: DirectProxyOptions) {
    const started = startDirect(options);
    this.directory = started.directory;
    this.isolatedPath = started.isolatedPath;
    this.pluginVersion = started.pluginVersion;
    this.session = started.session;
  }

  request(
    method: string,
    params: Record<string, unknown>,
    id: string,
    timeoutMs?: number,
  ): Promise<OutgoingLine> {
    return this.session.request(method, params, id, timeoutMs);
  }

  nextObject(timeoutMs?: number): Promise<Record<string, unknown>> {
    return this.session.nextObject(timeoutMs);
  }

  endInput(): void {
    this.session.endInput();
  }

  waitForExit(timeoutMs?: number): Promise<number | null> {
    return this.session.waitForExit(timeoutMs);
  }

  dispose(): Promise<void> {
    return this.session.dispose();
  }
}

export interface StdioHarnessOptions {
  /** Models JSON for a fake `agy` at the temp account's `~/.local/bin/agy`. */
  coldCatalogStdout?: string;
}

interface PairedChild {
  directory: string;
  workspace: string;
  serverPath: string;
  harnessPath: string;
  fixturePath: string;
  isolatedPath: string;
  pluginVersion: string;
  child: ChildProcessWithoutNullStreams;
  session: LineSession;
  pidPath: string;
  logPath: string;
  reportPath: string;
  cliCountPath?: string;
}

function installOsHomeFixture(directory: string): { nodeArgs: string[]; countPath: string } {
  const helper = join(directory, '.local', 'bin', 'agy');
  const fixture = join(packageRoot(), 'test', 'fixtures', 'fake-antigravity-cli-models.mjs');
  if (!existsSync(fixture)) throw new Error(`CLI model fixture is missing: ${fixture}`);
  mkdirSync(join(directory, '.local', 'bin'), { recursive: true });
  writeFileSync(
    helper,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`,
    { mode: 0o755 },
  );
  chmodSync(helper, 0o755);
  const countPath = join(directory, 'cli-count');
  const preload = join(directory, 'os-home-preload.cjs');
  writeFileSync(preload, `'use strict';
const os = require('node:os');
const { syncBuiltinESMExports } = require('node:module');
const home = ${JSON.stringify(directory)};
const baseUserInfo = os.userInfo;
Object.defineProperty(os, 'userInfo', {
  configurable: true,
  enumerable: true,
  writable: true,
  value: function userInfo(options) {
    const info = baseUserInfo(options);
    return Object.assign({}, info, { homedir: home });
  },
});
Object.defineProperty(os, 'homedir', {
  configurable: true,
  enumerable: true,
  writable: true,
  value: function homedir() {
    return home;
  },
});
syncBuiltinESMExports();
`);
  return { nodeArgs: ['--require', preload], countPath };
}

function startPaired(options: StdioHarnessOptions = {}): PairedChild {
  const originalHome = process.env.HOME;
  const version = pluginVersion();
  compiledSpawnPath();
  const fixturePath = join(packageRoot(), 'test', 'fixtures', 'fake-antigravity-session.mjs');
  if (!existsSync(fixturePath)) throw new Error(`Session fixture is missing: ${fixturePath}`);
  const directory = mkdtempSync(join(tmpdir(), 'agy-stdio-'));
  const workspace = join(directory, 'workspace');
  const isolatedPath = join(directory, 'path');
  const extract = join(directory, 'extract');
  const serverPath = join(extract, requiredName(serverBasenames()));
  const harnessPath = join(extract, requiredName(harnessBasenames()));
  const pidPath = join(directory, 'fake.pid');
  const logPath = join(directory, 'fake.log');
  const reportPath = join(directory, 'fake-report.json');
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    mkdirSync(workspace, { recursive: true });
    mkdirSync(isolatedPath, { recursive: true });
    mkdirSync(extract, { recursive: true });
    writeFileSync(
      serverPath,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixturePath)} "$@"\n`,
      { mode: 0o755 },
    );
    writeFileSync(harnessPath, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const coldStdout = options.coldCatalogStdout;
    const coldCatalog = coldStdout === undefined ? undefined : installOsHomeFixture(directory);
    const childEnv: NodeJS.ProcessEnv = {
      PATH: isolatedPath,
      HOME: directory,
      TMPDIR: directory,
      FAKE_SESSION_PID: pidPath,
      FAKE_SESSION_LOG: logPath,
      FAKE_SESSION_REPORT: reportPath,
    };
    if (coldCatalog !== undefined && coldStdout !== undefined) {
      childEnv.FAKE_AGY_CLI_STDOUT = coldStdout;
      childEnv.FAKE_AGY_CLI_COUNT = coldCatalog.countPath;
    }
    child = spawnCompiled(
      ['--antigravity-bin', serverPath],
      childEnv,
      coldCatalog?.nodeArgs ?? [],
    );
    return {
      directory,
      workspace,
      serverPath,
      harnessPath,
      fixturePath,
      isolatedPath,
      pluginVersion: version,
      child,
      pidPath,
      logPath,
      reportPath,
      ...(coldCatalog === undefined ? {} : { cliCountPath: coldCatalog.countPath }),
      session: new LineSession(
        child,
        directory,
        new HostProtocolValidator({
          pluginId: 'io.gian.antigravity',
          pluginVersion: version,
          processScope: 'shared',
        }),
        originalHome,
      ),
    };
  } catch (error) {
    child?.kill('SIGKILL');
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Compiled spawn.js against one paired fake ACP server. */
export class StdioHarness {
  readonly directory: string;
  readonly workspace: string;
  readonly serverPath: string;
  readonly harnessPath: string;
  readonly fixturePath: string;
  readonly isolatedPath: string;
  readonly pluginVersion: string;
  readonly child: ChildProcessWithoutNullStreams;
  private readonly session: LineSession;
  private readonly pidPath: string;
  private readonly logPath: string;
  private readonly reportPath: string;
  private readonly cliCountPath: string | undefined;

  constructor(options: StdioHarnessOptions = {}) {
    const started = startPaired(options);
    this.directory = started.directory;
    this.workspace = started.workspace;
    this.serverPath = started.serverPath;
    this.harnessPath = started.harnessPath;
    this.fixturePath = started.fixturePath;
    this.isolatedPath = started.isolatedPath;
    this.pluginVersion = started.pluginVersion;
    this.child = started.child;
    this.session = started.session;
    this.pidPath = started.pidPath;
    this.logPath = started.logPath;
    this.reportPath = started.reportPath;
    this.cliCountPath = started.cliCountPath;
  }

  cliSpawnCount(): number {
    if (this.cliCountPath === undefined || !existsSync(this.cliCountPath)) return 0;
    return readFileSync(this.cliCountPath, 'utf8').split('\n').filter((line) => line.length > 0).length;
  }

  request(
    method: string,
    params: Record<string, unknown>,
    id: string,
    timeoutMs?: number,
  ): Promise<OutgoingLine> {
    return this.session.request(method, params, id, timeoutMs);
  }

  take(
    match: (line: OutgoingLine) => boolean,
    timeoutMs?: number,
    label?: string,
  ): Promise<OutgoingLine> {
    return this.session.take(match, timeoutMs, label);
  }

  pendingLines(): readonly OutgoingLine[] {
    return this.session.pendingLines();
  }

  endInput(): void {
    this.session.endInput();
  }

  waitForExit(timeoutMs?: number): Promise<number | null> {
    return this.session.waitForExit(timeoutMs);
  }

  waitUntilDead(pid: number, timeoutMs?: number): Promise<void> {
    return this.session.waitUntilDead(pid, timeoutMs);
  }

  runtimeLog(): string[] {
    if (!existsSync(this.logPath)) return [];
    return readFileSync(this.logPath, 'utf8').split('\n').filter((line) => line.length > 0);
  }

  launchReport(): {
    HOME: string | null;
    PATH: string | null;
    execPath: string;
    script: string;
    harness: string | null;
  } {
    return JSON.parse(readFileSync(this.reportPath, 'utf8')) as {
      HOME: string | null;
      PATH: string | null;
      execPath: string;
      script: string;
      harness: string | null;
    };
  }

  fakePid(): number {
    const pid = Number(readFileSync(this.pidPath, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Fake ACP pid was not recorded.');
    return pid;
  }

  dispose(): Promise<void> {
    return this.session.dispose(this.pidPath);
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
