import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { access, mkdtemp, realpath, stat } from 'node:fs/promises';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import type { DomainCode } from '@gian/proxy-protocol';

import { AntigravityRuntimeError } from './errors.js';
import { resolveGeminiHome } from './home.js';

/**
 * Installed `agy` model catalog.
 *
 * The evidenced query is `agy --output-format json models`: the flag is before
 * the subcommand, stdin is closed, and the process is not an ACP session and
 * not a prompt. A non-empty `HOME` must be the OS account home before any
 * Gemini-root override is considered. Only that account's default `~/.gemini`
 * is allowed. A managed home fails before spawn. This does not set
 * `GEMINI_HOME` to isolate the CLI, and it does not read credential files.
 * Production queries use a private empty temporary directory, created after
 * that home guard and removed after process cleanup, so a project config in
 * the caller's working directory is not picked up. That directory is not an
 * auth root and is not a performance bound.
 *
 * Production discovery is the user install, then Homebrew, then `/usr/local`.
 * It does not search `PATH`. Tests inject absolute candidates instead of a
 * Host provider variable.
 */

/** Flag before the `models` subcommand. This is not a prompt and not ACP. */
export const ANTIGRAVITY_CLI_MODELS_ARGS = ['--output-format', 'json', 'models'] as const;

/**
 * Metadata-query budget. A successful `models` query can take longer than
 * 20 seconds and still return before any prompt. Callers may inject a
 * shorter deadline. This does not change ACP prompt or auth RPC deadlines,
 * and this module does not retry.
 */
export const ANTIGRAVITY_CLI_MODELS_TIMEOUT_MS = 60_000;

/** One JSON document. Model lists are small; overflow is discarded, not returned. */
export const ANTIGRAVITY_CLI_MODELS_MAX_OUTPUT_BYTES = 256 * 1024;

/** How long to wait for the owned process group to disappear after SIGKILL. */
export const ANTIGRAVITY_CLI_MODELS_STOP_MS = 1_000;

/** Raw `models` array length. Oversized documents are rejected, not truncated. */
export const ANTIGRAVITY_CLI_MODELS_MAX_COUNT = 128;

const MODEL_ID_MAX_LENGTH = 128;
const MODEL_LABEL_MAX_LENGTH = 256;
const GEMINI_MODEL_PREFIX = 'gemini';

export type AntigravityCliHelperSource = 'official-user' | 'official-system' | 'injected';

export type AntigravityCliModelsFailure =
  | 'helper_missing'
  | 'home_not_default'
  | 'models_unavailable'
  | 'invalid_response'
  | 'query_failed'
  | 'timeout'
  | 'output_limit'
  | 'cancelled'
  | 'cleanup_failed'
  | 'busy';

export interface AntigravityCliHelperCandidate {
  path: string;
  source: AntigravityCliHelperSource;
}

/**
 * Identity of the helper that produced a catalog.
 * `path` is the regular file after symlink resolution. `dev` and `ino` plus
 * `size` and `mtimeMs` let a later cache notice an in-place replacement
 * without reading the binary or any auth file beside it.
 */
export interface AntigravityCliHelperIdentity {
  path: string;
  source: AntigravityCliHelperSource;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export interface AntigravityCliModelOption {
  id: string;
  label: string;
}

export interface AntigravityCliModelsResult {
  helper: AntigravityCliHelperIdentity;
  models: readonly AntigravityCliModelOption[];
}

/** Internal diagnostics contain no helper output, environment, paths or raw errors. */
export interface AntigravityCliModelsCleanupDiagnostic {
  phase: 'abort-signal' | 'leader-deadline' | 'reap-signal' | 'reap-deadline' | 'stop-deadline';
  code: string | null;
}

type CleanupDiagnosticSink = (diagnostic: AntigravityCliModelsCleanupDiagnostic) => void;

export interface AntigravityCliModelsOptions {
  /** Copied into the child at `list()` time. Never logged. */
  env?: NodeJS.ProcessEnv;
  /**
   * Explicit working directory for tests. Production leaves this unset and
   * allocates an empty temporary directory for that query only.
   */
  cwd?: string;
  /**
   * Absolute helper paths. When set, including to an empty list, they replace
   * production discovery. This is the test injection point.
   */
  candidates?: readonly string[];
  /** OS user home for the default-home guard and `~/.local/bin/agy`. */
  osUserHome?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  stopMs?: number;
  signal?: AbortSignal;
  /** Internal test injection; production does not log cleanup diagnostics. */
  onCleanupDiagnostic?: CleanupDiagnosticSink;
}

interface ResolvedConfig {
  env: NodeJS.ProcessEnv;
  /** Null allocates a private directory inside each `list()` call. */
  cwd: string | null;
  osUserHome: string;
  candidates: readonly string[] | null;
  timeoutMs: number;
  maxOutputBytes: number;
  stopMs: number;
  onCleanupDiagnostic: CleanupDiagnosticSink | null;
}

interface LeaderExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export class AntigravityCliModelsError extends AntigravityRuntimeError {
  readonly failure: AntigravityCliModelsFailure;
  readonly domainCode: DomainCode;
  readonly retryable = false;

  constructor(failure: AntigravityCliModelsFailure) {
    super(failureMessage(failure));
    this.name = 'AntigravityCliModelsError';
    this.failure = failure;
    this.domainCode = failureDomain(failure);
  }
}

/**
 * Default install locations, in selection order.
 * `~/.local/bin/agy`, then `/opt/homebrew/bin/agy`, then `/usr/local/bin/agy`.
 */
export function antigravityCliHelperCandidates(osUserHome: string): readonly AntigravityCliHelperCandidate[] {
  assertAbsolutePath(osUserHome);
  return [
    { path: join(osUserHome, '.local', 'bin', 'agy'), source: 'official-user' },
    { path: '/opt/homebrew/bin/agy', source: 'official-system' },
    { path: '/usr/local/bin/agy', source: 'official-system' },
  ];
}

/**
 * One installed-CLI catalog query.
 * `stop()` aborts an in-flight query, reaps its process group, and rejects
 * later `list()` calls. The adapter can hold this object across shutdown.
 */
export class AntigravityCliModels {
  private readonly config: ResolvedConfig;
  private readonly externalSignal: AbortSignal | null;
  private closed = false;
  private inflight: Promise<AntigravityCliModelsResult> | null = null;
  private abortInFlight: (() => void) | null = null;
  private stopPromise: Promise<void> | null = null;

  constructor(options: AntigravityCliModelsOptions = {}) {
    const resolved = resolveConfig(options);
    this.config = resolved.config;
    this.externalSignal = resolved.signal;
  }

  list(): Promise<AntigravityCliModelsResult> {
    if (this.closed) return Promise.reject(new AntigravityCliModelsError('cancelled'));
    if (this.inflight) return Promise.reject(new AntigravityCliModelsError('busy'));
    const controller = new AbortController();
    const onExternal = (): void => controller.abort();
    if (this.externalSignal?.aborted) controller.abort();
    else this.externalSignal?.addEventListener('abort', onExternal, { once: true });
    this.abortInFlight = () => controller.abort();
    const promise = this.execute(controller.signal).finally(() => {
      this.externalSignal?.removeEventListener('abort', onExternal);
      this.abortInFlight = null;
      if (this.inflight === promise) this.inflight = null;
    });
    this.inflight = promise;
    return promise;
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.closed = true;
    const running = this.inflight;
    this.abortInFlight?.();
    this.stopPromise = settleStop(running, this.config.stopMs, this.config.onCleanupDiagnostic);
    return this.stopPromise;
  }

  /** Re-check the default-home guard without spawning. */
  assertDefaultHome(): Promise<void> {
    return assertDefaultCliHome({ ...this.config.env }, this.config.osUserHome);
  }

  /**
   * Resolve the helper that `list()` would select now.
   * A missing candidate returns null and does not spawn.
   */
  async resolveSelectedHelper(): Promise<AntigravityCliHelperIdentity | null> {
    try {
      return await selectHelper(candidateSpecs(this.config));
    } catch (error) {
      if (error instanceof AntigravityCliModelsError && error.failure === 'helper_missing') return null;
      throw error;
    }
  }

  private async execute(signal: AbortSignal): Promise<AntigravityCliModelsResult> {
    const env = { ...this.config.env };
    await assertDefaultCliHome(env, this.config.osUserHome);
    if (signal.aborted || this.closed) throw new AntigravityCliModelsError('cancelled');
    const helper = await selectHelper(candidateSpecs(this.config));
    if (signal.aborted || this.closed) throw new AntigravityCliModelsError('cancelled');
    const ownedCwd = this.config.cwd === null ? await createIsolatedQueryCwd() : null;
    let result: AntigravityCliModelsResult | undefined;
    let queryError: unknown;
    try {
      if (signal.aborted || this.closed) throw new AntigravityCliModelsError('cancelled');
      const cwd = ownedCwd ?? this.config.cwd;
      if (cwd === null) throw new AntigravityCliModelsError('query_failed');
      result = await runQuery(helper, env, { ...this.config, cwd }, signal);
    } catch (error) {
      queryError = error;
    }
    if (ownedCwd !== null && !await removeIsolatedQueryCwd(ownedCwd)) {
      if (queryError instanceof AntigravityCliModelsError) throw queryError;
      throw new AntigravityCliModelsError('cleanup_failed');
    }
    if (queryError !== undefined) throw queryError;
    if (result === undefined) throw new AntigravityCliModelsError('query_failed');
    return result;
  }
}

export function listAntigravityCliModels(
  options: AntigravityCliModelsOptions = {},
): Promise<AntigravityCliModelsResult> {
  return new AntigravityCliModels(options).list();
}

function resolveConfig(options: AntigravityCliModelsOptions): {
  config: ResolvedConfig;
  signal: AbortSignal | null;
} {
  const osUserHome = options.osUserHome ?? defaultOsUserHome();
  const cwd = options.cwd === undefined ? null : options.cwd;
  assertAbsolutePath(osUserHome);
  if (cwd !== null) assertAbsolutePath(cwd);
  return {
    config: {
      env: options.env ?? process.env,
      cwd,
      osUserHome,
      candidates: options.candidates ?? null,
      timeoutMs: requireBound(options.timeoutMs, ANTIGRAVITY_CLI_MODELS_TIMEOUT_MS),
      maxOutputBytes: requireBound(options.maxOutputBytes, ANTIGRAVITY_CLI_MODELS_MAX_OUTPUT_BYTES),
      onCleanupDiagnostic: options.onCleanupDiagnostic ?? null,
      stopMs: requireBound(options.stopMs, ANTIGRAVITY_CLI_MODELS_STOP_MS),
    },
    signal: options.signal ?? null,
  };
}

function candidateSpecs(config: ResolvedConfig): readonly AntigravityCliHelperCandidate[] {
  if (config.candidates !== null) {
    return config.candidates.map((path) => ({ path, source: 'injected' as const }));
  }
  return antigravityCliHelperCandidates(config.osUserHome);
}

async function selectHelper(
  candidates: readonly AntigravityCliHelperCandidate[],
): Promise<AntigravityCliHelperIdentity> {
  for (const candidate of candidates) {
    const resolved = await inspectHelper(candidate);
    if (resolved) return resolved;
  }
  throw new AntigravityCliModelsError('helper_missing');
}

async function inspectHelper(
  candidate: AntigravityCliHelperCandidate,
): Promise<AntigravityCliHelperIdentity | null> {
  if (typeof candidate.path !== 'string' || !isAbsolute(candidate.path) || candidate.path.includes('\0')) {
    return null;
  }
  try {
    const path = await realpath(candidate.path);
    if (!isAbsolute(path)) return null;
    const info = await stat(path);
    if (!info.isFile()) return null;
    if (process.platform !== 'win32') await access(path, constants.X_OK);
    return {
      path,
      source: candidate.source,
      dev: info.dev,
      ino: info.ino,
      size: info.size,
      mtimeMs: info.mtimeMs,
    };
  } catch {
    return null;
  }
}

/**
 * A non-empty `HOME` is compared with the OS account home before any
 * `GIAN_AGENT_HOME` or `GEMINI_HOME` override. An empty or absent `HOME`
 * keeps the OS default. The effective Gemini root must still be that
 * account's `~/.gemini`. There is no fallback onto another home, and the
 * child environment is not rewritten.
 */
async function assertDefaultCliHome(env: NodeJS.ProcessEnv, osUserHome: string): Promise<void> {
  try {
    const configuredHome = env.HOME;
    if (typeof configuredHome === 'string' && configuredHome !== '') {
      const actual = await canonicalPath(configuredHome);
      const expected = await canonicalPath(osUserHome);
      if (actual !== expected) throw new AntigravityCliModelsError('home_not_default');
    }
    const official = await canonicalPath(join(osUserHome, '.gemini'));
    const effective = await canonicalPath(resolveGeminiHome(env));
    if (effective !== official) throw new AntigravityCliModelsError('home_not_default');
    for (const key of ['GIAN_AGENT_HOME', 'GEMINI_HOME'] as const) {
      const explicit = await explicitHome(env, key);
      if (explicit !== null && explicit !== official) {
        throw new AntigravityCliModelsError('home_not_default');
      }
    }
  } catch (error) {
    if (error instanceof AntigravityCliModelsError) throw error;
    throw new AntigravityCliModelsError('home_not_default');
  }
}

function defaultOsUserHome(): string {
  try {
    const home = userInfo().homedir;
    if (typeof home === 'string' && isAbsolute(home) && !home.includes('\0')) return home;
  } catch {
    // The account database did not provide a home directory.
  }
  return homedir();
}

async function explicitHome(
  env: NodeJS.ProcessEnv,
  key: 'GIAN_AGENT_HOME' | 'GEMINI_HOME',
): Promise<string | null> {
  const value = env[key];
  if (value === undefined || value === '') return null;
  const probe: NodeJS.ProcessEnv = {};
  if (typeof env.HOME === 'string') probe.HOME = env.HOME;
  probe[key] = value;
  return canonicalPath(resolveGeminiHome(probe));
}

async function canonicalPath(input: string): Promise<string> {
  if (!isAbsolute(input) || input.includes('\0')) {
    throw new AntigravityCliModelsError('home_not_default');
  }
  const missing: string[] = [];
  let current = resolve(input);
  for (;;) {
    try {
      const real = await realpath(current);
      if (!isAbsolute(real)) throw new AntigravityCliModelsError('home_not_default');
      return missing.length === 0 ? real : join(real, ...missing);
    } catch (error) {
      if (error instanceof AntigravityCliModelsError) throw error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw new AntigravityCliModelsError('home_not_default');
    }
    const parent = dirname(current);
    if (parent === current) return current;
    missing.unshift(basename(current));
    current = parent;
  }
}

async function runQuery(
  helper: AntigravityCliHelperIdentity,
  env: NodeJS.ProcessEnv,
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<AntigravityCliModelsResult> {
  const cwd = config.cwd;
  if (cwd === null) throw new AntigravityCliModelsError('query_failed');
  if (signal.aborted) throw new AntigravityCliModelsError('cancelled');
  const child = spawn(helper.path, [...ANTIGRAVITY_CLI_MODELS_ARGS], {
    cwd,
    env: { ...env, PWD: cwd },
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const pid = child.pid ?? -1;
  const release = ownGroup(pid);
  const chunks: Buffer[] = [];
  let received = 0;
  let failure: AntigravityCliModelsError | null = null;
  let done = false;
  let queryTimer: NodeJS.Timeout | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined;
  const stdout = child.stdout;
  const stderr = child.stderr;
  const leaderExit = waitForLeader(child);
  const takeBytes = (chunk: Buffer | string): Buffer => (
    Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
  );
  let detachStreams: () => void = () => undefined;
  // Registered in the spawn turn, before the leader outcome is awaited.
  // Leader exit is not EOF: a descendant can still write or hold the pipe.
  let streamsDone = Promise.resolve();
  const outcome = new Promise<LeaderExit>((resolveExit, rejectExit) => {
    let leaderSettled = false;
    const finishOk = (event: LeaderExit): void => {
      if (leaderSettled) return;
      leaderSettled = true;
      resolveExit(event);
    };
    const finishErr = (error: AntigravityCliModelsError): void => {
      if (leaderSettled) return;
      leaderSettled = true;
      rejectExit(error);
    };
    const beginCleanup = (error: AntigravityCliModelsError): void => {
      if (done) return;
      if (failure === null || error.failure === 'cleanup_failed') failure = error;
      chunks.length = 0;
      received = 0;
      if (leaderSettled || cleanupTimer) return;
      if (pid > 0) {
        try {
          signalOwnedGroup(pid, 'SIGKILL');
        } catch (error) {
          cleanupDiagnostic(config.onCleanupDiagnostic, 'abort-signal', error);
          finishErr(new AntigravityCliModelsError('cleanup_failed'));
          return;
        }
      }
      cleanupTimer = setTimeout(() => {
        cleanupDiagnostic(config.onCleanupDiagnostic, 'leader-deadline');
        finishErr(failure?.failure === 'cleanup_failed'
          ? failure
          : new AntigravityCliModelsError('cleanup_failed'));
      }, config.stopMs);
    };
    const onAbort = (): void => beginCleanup(new AntigravityCliModelsError('cancelled'));
    const onStdout = (chunk: Buffer | string): void => {
      if (done || failure) return;
      const bytes = takeBytes(chunk);
      received += bytes.byteLength;
      if (received > config.maxOutputBytes) {
        beginCleanup(new AntigravityCliModelsError('output_limit'));
        return;
      }
      chunks.push(bytes);
    };
    const onStderr = (chunk: Buffer | string): void => {
      if (done || failure) return;
      received += takeBytes(chunk).byteLength;
      if (received > config.maxOutputBytes) beginCleanup(new AntigravityCliModelsError('output_limit'));
    };
    const onStdoutError = (): void => beginCleanup(new AntigravityCliModelsError('query_failed'));
    stdout?.on('data', onStdout);
    stdout?.on('error', onStdoutError);
    stderr?.on('data', onStderr);
    stderr?.on('error', () => undefined);
    streamsDone = Promise.all([streamSettled(stdout), streamSettled(stderr)]).then(() => undefined);
    queryTimer = setTimeout(() => beginCleanup(new AntigravityCliModelsError('timeout')), config.timeoutMs);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    leaderExit.then((event) => {
      if (queryTimer) clearTimeout(queryTimer);
      if (cleanupTimer) clearTimeout(cleanupTimer);
      finishOk(event);
    }, () => {
      finishErr(new AntigravityCliModelsError('cleanup_failed'));
    });
    detachStreams = () => {
      signal.removeEventListener('abort', onAbort);
      stdout?.off('data', onStdout);
      stdout?.off('error', onStdoutError);
      stderr?.off('data', onStderr);
    };
  });
  try {
    const event = await outcome;
    if (!(await finishesWithin(streamsDone, config.stopMs))) {
      failure ??= new AntigravityCliModelsError('query_failed');
    }
    const text = failure === null ? Buffer.concat(chunks).toString('utf8') : '';
    chunks.length = 0;
    if (pid > 0 && failure?.failure !== 'cleanup_failed') {
      try {
        await reapOwnedGroup(pid, config.stopMs, config.onCleanupDiagnostic);
      } catch (error) {
        failure = error instanceof AntigravityCliModelsError
          ? error
          : new AntigravityCliModelsError('cleanup_failed');
      }
    }
    if (signal.aborted) failure ??= new AntigravityCliModelsError('cancelled');
    if (failure) throw failure;
    if (event.error !== undefined || event.signal !== null || event.code !== 0) {
      throw new AntigravityCliModelsError('query_failed');
    }
    return { helper, models: parseModelsDocument(text) };
  } finally {
    done = true;
    if (queryTimer) clearTimeout(queryTimer);
    if (cleanupTimer) clearTimeout(cleanupTimer);
    detachStreams();
    release();
    chunks.length = 0;
    closePipes(child);
  }
}

function parseModelsDocument(text: string): AntigravityCliModelOption[] {
  const trimmed = text.trim();
  if (trimmed === '') throw new AntigravityCliModelsError('invalid_response');
  let value: unknown;
  try {
    value = JSON.parse(trimmed) as unknown;
  } catch {
    throw new AntigravityCliModelsError('invalid_response');
  }
  if (!isRecord(value) || value.status !== 'SUCCESS') {
    throw new AntigravityCliModelsError('invalid_response');
  }
  const command = value.command;
  if (!isRecord(command) || command.name !== 'models' || !isRecord(command.data)) {
    throw new AntigravityCliModelsError('invalid_response');
  }
  const models = command.data.models;
  if (!Array.isArray(models) || models.length > ANTIGRAVITY_CLI_MODELS_MAX_COUNT) {
    throw new AntigravityCliModelsError('invalid_response');
  }
  const seen = new Map<string, string>();
  const options: AntigravityCliModelOption[] = [];
  for (const entry of models) {
    const row = strictModelRow(entry);
    if (!row.id.startsWith(GEMINI_MODEL_PREFIX)) continue;
    const previous = seen.get(row.id);
    if (previous !== undefined) {
      if (previous !== row.label) throw new AntigravityCliModelsError('invalid_response');
      continue;
    }
    seen.set(row.id, row.label);
    options.push(row);
  }
  if (options.length === 0) throw new AntigravityCliModelsError('models_unavailable');
  return options;
}

function strictModelRow(entry: unknown): AntigravityCliModelOption {
  if (!isRecord(entry) || !isModelId(entry.id) || !isModelLabel(entry.label)) {
    throw new AntigravityCliModelsError('invalid_response');
  }
  return { id: entry.id, label: entry.label };
}

function isModelId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MODEL_ID_MAX_LENGTH) return false;
  if (!/^[\x21-\x7e]+$/.test(value)) return false;
  return !value.includes('/') && !value.includes('\\') && !value.includes('?')
    && !value.includes('#') && !value.includes('%');
}

function isModelLabel(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MODEL_LABEL_MAX_LENGTH) return false;
  if (value.trim() !== value) return false;
  if (/[\u0000-\u001f\u007f]/.test(value)) return false;
  return !value.includes('://');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function waitForLeader(child: ChildProcess): Promise<LeaderExit> {
  return new Promise((resolveExit) => {
    let settled = false;
    const finish = (event: LeaderExit): void => {
      if (settled) return;
      settled = true;
      resolveExit(event);
    };
    child.once('error', (error) => finish({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => finish({ code, signal }));
  });
}

function ownGroup(pid: number): () => void {
  if (pid <= 0) return () => undefined;
  let released = false;
  const onExit = (): void => {
    if (released) return;
    try {
      signalOwnedGroup(pid, 'SIGKILL');
    } catch {
      // The parent is already exiting.
    }
  };
  process.on('exit', onExit);
  return () => {
    if (released) return;
    released = true;
    process.removeListener('exit', onExit);
  };
}

/** @internal Exported for deterministic signal/probe race regressions. */
export async function reapOwnedGroup(
  pid: number,
  budgetMs: number,
  onDiagnostic: CleanupDiagnosticSink | null = null,
): Promise<void> {
  if (process.platform === 'win32' || pid <= 0) return;
  if (!groupHasMembers(pid)) return;
  const started = Date.now();
  try {
    signalOwnedGroup(pid, 'SIGKILL');
  } catch (error) {
    cleanupDiagnostic(onDiagnostic, 'reap-signal', error);
    // Abort may already have killed this group. A second signal racing its
    // teardown is not proof of survivors; only a confirmed absent group is
    // success. Keep the existing bounded wait, without retrying the signal.
  }
  for (;;) {
    if (!groupHasMembers(pid)) return;
    if (Date.now() - started >= budgetMs) {
      cleanupDiagnostic(onDiagnostic, 'reap-deadline');
      throw new AntigravityCliModelsError('cleanup_failed');
    }
    await delay(20);
  }
}

function cleanupDiagnostic(
  sink: CleanupDiagnosticSink | null,
  phase: AntigravityCliModelsCleanupDiagnostic['phase'],
  error?: unknown,
): void {
  if (sink === null) return;
  const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
  try {
    sink({ phase, code: typeof code === 'string' && /^E[A-Z0-9_]{1,31}$/.test(code) ? code : null });
  } catch {
    // Diagnostics never change cleanup or cancellation semantics.
  }
}

function signalOwnedGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
}

function groupHasMembers(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function streamSettled(stream: ChildProcess['stdout']): Promise<void> {
  if (stream === null || stream.readableEnded) return Promise.resolve();
  return new Promise((resolveStream) => {
    const finish = (): void => resolveStream();
    stream.once('end', finish);
    stream.once('close', finish);
    stream.once('error', finish);
  });
}

function closePipes(child: ChildProcess): void {
  for (const stream of [child.stdout, child.stderr, child.stdin]) {
    if (!stream) continue;
    stream.on('error', () => undefined);
    stream.destroy();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function finishesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<boolean>((resolveDeadline) => {
    timer = setTimeout(() => resolveDeadline(false), timeoutMs);
  });
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settleStop(
  running: Promise<AntigravityCliModelsResult> | null,
  deadlineMs: number,
  onDiagnostic: CleanupDiagnosticSink | null,
): Promise<void> {
  if (running === null) return;
  let timer: NodeJS.Timeout | undefined;
  const watched = running.then(() => undefined, (error: unknown) => error);
  try {
    const outcome = await Promise.race([
      watched,
      new Promise<AntigravityCliModelsError>((resolveDeadline) => {
        timer = setTimeout(() => {
          cleanupDiagnostic(onDiagnostic, 'stop-deadline');
          resolveDeadline(new AntigravityCliModelsError('cleanup_failed'));
        }, deadlineMs);
      }),
    ]);
    if (outcome instanceof AntigravityCliModelsError && outcome.failure === 'cleanup_failed') throw outcome;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** One empty directory per query. Failure here stays a fixed sentence. */
async function createIsolatedQueryCwd(): Promise<string> {
  try {
    return await mkdtemp(join(tmpdir(), 'agy-models-query-'));
  } catch {
    throw new AntigravityCliModelsError('query_failed');
  }
}

/** After process cleanup. False means the private directory is still present. */
async function removeIsolatedQueryCwd(path: string): Promise<boolean> {
  try {
    await fsPromises.rm(path, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function assertAbsolutePath(path: string): void {
  if (!isAbsolute(path) || path.includes('\0')) {
    throw new AntigravityRuntimeError('Antigravity CLI model query options are invalid.');
  }
}

function requireBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AntigravityRuntimeError('Antigravity CLI model query options are invalid.');
  }
  return value;
}

/** Fixed proxy-local sentences. Host and Web select a reason token, not this text. */
function failureMessage(failure: AntigravityCliModelsFailure): string {
  switch (failure) {
    case 'helper_missing':
      return 'Antigravity CLI helper is not installed.';
    case 'home_not_default':
      return 'Antigravity CLI model query requires the default Gemini home.';
    case 'models_unavailable':
      return 'Antigravity CLI returned no Gemini models.';
    case 'invalid_response':
      return 'Antigravity CLI model query returned an unexpected response.';
    case 'query_failed':
      return 'Antigravity CLI model query failed.';
    case 'timeout':
      return 'Antigravity CLI model query timed out.';
    case 'output_limit':
      return 'Antigravity CLI model query exceeded its output limit.';
    case 'cancelled':
      return 'Antigravity CLI model query was cancelled.';
    case 'cleanup_failed':
      return 'Antigravity CLI model query process cleanup failed.';
    case 'busy':
      return 'Antigravity CLI model query is already running.';
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}

function failureDomain(failure: AntigravityCliModelsFailure): DomainCode {
  switch (failure) {
    case 'helper_missing':
    case 'models_unavailable':
      return 'RUNTIME_UNAVAILABLE';
    case 'cancelled':
      return 'CANCELLED';
    case 'home_not_default':
    case 'invalid_response':
    case 'query_failed':
    case 'timeout':
    case 'output_limit':
    case 'cleanup_failed':
    case 'busy':
      return 'RUNTIME_ERROR';
    default: {
      const exhaustive: never = failure;
      return exhaustive;
    }
  }
}
