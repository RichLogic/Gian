import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  terminateGraceMs?: number;
  maxBufferBytes?: number;
  acceptableExitCodes?: readonly number[];
  signal?: AbortSignal;
}

export class CommandExecutionError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly aborted: boolean;

  constructor(params: {
    message: string;
    command: string;
    args: readonly string[];
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut?: boolean;
    aborted?: boolean;
    cause?: unknown;
  }) {
    super(params.message, params.cause === undefined ? undefined : { cause: params.cause });
    this.name = 'CommandExecutionError';
    this.command = params.command;
    this.args = params.args;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
    this.exitCode = params.exitCode;
    this.signal = params.signal;
    this.timedOut = params.timedOut ?? false;
    this.aborted = params.aborted ?? false;
  }
}

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_TERMINATE_GRACE_MS = 250;
const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

/**
 * Run one child process without blocking the Node event loop.
 *
 * On POSIX the child becomes a process-group leader. Deadline, abort, and
 * output-overflow cleanup signal the whole group so helper processes spawned
 * by git (credential helpers, ssh, hooks) cannot outlive the request. Cleanup
 * starts with SIGTERM and escalates to SIGKILL after a short grace period.
 */
export function runCommand(
  command: string,
  args: readonly string[],
  options: RunCommandOptions = {},
): Promise<CommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const acceptableExitCodes = new Set(options.acceptableExitCodes ?? [0]);

  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive finite number');
  }
  if (!Number.isFinite(terminateGraceMs) || terminateGraceMs < 0) {
    throw new TypeError('terminateGraceMs must be a non-negative finite number');
  }
  if (!Number.isFinite(maxBufferBytes) || maxBufferBytes <= 0) {
    throw new TypeError('maxBufferBytes must be a positive finite number');
  }
  if (options.signal?.aborted) {
    return Promise.reject(new CommandExecutionError({
      message: `${command} was aborted`,
      command,
      args,
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      aborted: true,
    }));
  }

  return new Promise<CommandResult>((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(command, [...args], {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminating = false;
    let failure: {
      message: string;
      timedOut?: boolean;
      aborted?: boolean;
      cause?: unknown;
    } | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let forceSettleTimer: NodeJS.Timeout | null = null;

    const output = () => ({
      stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
      stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8'),
    });

    const signalProcess = (signal: NodeJS.Signals): void => {
      if (child.pid == null) return;
      try {
        if (detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // The process may already have exited between the state check and kill.
      }
    };

    const clearResources = (): void => {
      clearTimeout(deadlineTimer);
      if (killTimer) clearTimeout(killTimer);
      if (forceSettleTimer) clearTimeout(forceSettleTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const rejectFailure = (
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearResources();
      const captured = output();
      const stderr = captured.stderr.trim();
      const reason = (failure?.message ?? stderr)
        || `${command} exited with code ${exitCode ?? 'unknown'}`;
      reject(new CommandExecutionError({
        message: reason,
        command,
        args,
        stdout: captured.stdout,
        stderr: captured.stderr,
        exitCode,
        signal: exitSignal,
        timedOut: failure?.timedOut,
        aborted: failure?.aborted,
        cause: failure?.cause,
      }));
    };

    const terminate = (nextFailure: NonNullable<typeof failure>): void => {
      if (!failure) failure = nextFailure;
      if (terminating) return;
      terminating = true;
      signalProcess('SIGTERM');
      killTimer = setTimeout(() => signalProcess('SIGKILL'), terminateGraceMs);
      killTimer.unref();
      // Defensive final settlement for a platform/process that never reports
      // close even after SIGKILL. Cleanup has already been attempted twice.
      forceSettleTimer = setTimeout(
        () => rejectFailure(null, 'SIGKILL'),
        terminateGraceMs + 1_000,
      );
      forceSettleTimer.unref();
    };

    const append = (target: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (terminating) return;
      target.push(chunk);
      if (stream === 'stdout') stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > maxBufferBytes) {
        terminate({ message: `${command} exceeded ${maxBufferBytes} bytes of output` });
      }
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      append(stdoutChunks, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), 'stdout');
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      append(stderrChunks, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), 'stderr');
    });

    child.once('error', error => {
      failure = { message: `${command} failed to start: ${error.message}`, cause: error };
      // Node normally follows a spawn error with close. Keep a fallback so a
      // broken platform implementation cannot strand the request.
      forceSettleTimer = setTimeout(() => rejectFailure(null, null), 0);
    });

    child.once('close', (exitCode, exitSignal) => {
      if (settled) return;
      if (!failure && exitCode != null && acceptableExitCodes.has(exitCode)) {
        settled = true;
        clearResources();
        const captured = output();
        resolve({ ...captured, exitCode });
        return;
      }
      rejectFailure(exitCode, exitSignal);
    });

    const onAbort = (): void => {
      terminate({ message: `${command} was aborted`, aborted: true });
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener('abort', onAbort, { once: true });

    const deadlineTimer = setTimeout(() => {
      terminate({
        message: `${command} timed out after ${timeoutMs}ms`,
        timedOut: true,
      });
    }, timeoutMs);
    deadlineTimer.unref();
  });
}

type SemaphoreFailure = 'timed_out' | 'aborted' | 'queue_full';

class SemaphoreAcquisitionError extends Error {
  constructor(readonly reason: SemaphoreFailure) {
    super(`semaphore acquisition ${reason.replace('_', ' ')}`);
    this.name = 'SemaphoreAcquisitionError';
  }
}

interface SemaphoreWaiter {
  resolve: (release: () => void) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class Semaphore {
  private active = 0;
  private readonly waiting: SemaphoreWaiter[] = [];

  constructor(private readonly limit: number) {}

  acquire(options: {
    timeoutMs: number;
    signal?: AbortSignal;
    maxWaiters: number;
  }): Promise<() => void> {
    if (options.signal?.aborted) {
      return Promise.reject(new SemaphoreAcquisitionError('aborted'));
    }
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    if (this.waiting.length >= options.maxWaiters) {
      return Promise.reject(new SemaphoreAcquisitionError('queue_full'));
    }

    return new Promise<() => void>((resolveWaiter, rejectWaiter) => {
      const removeAndReject = (waiter: SemaphoreWaiter, reason: SemaphoreFailure): void => {
        const index = this.waiting.indexOf(waiter);
        if (index < 0) return;
        this.waiting.splice(index, 1);
        clearTimeout(waiter.timer);
        if (waiter.signal && waiter.onAbort) {
          waiter.signal.removeEventListener('abort', waiter.onAbort);
        }
        rejectWaiter(new SemaphoreAcquisitionError(reason));
      };
      const waiter = {} as SemaphoreWaiter;
      waiter.resolve = resolveWaiter;
      waiter.signal = options.signal;
      waiter.timer = setTimeout(
        () => removeAndReject(waiter, 'timed_out'),
        options.timeoutMs,
      );
      if (options.signal) {
        waiter.onAbort = () => removeAndReject(waiter, 'aborted');
        options.signal.addEventListener('abort', waiter.onAbort, { once: true });
      }
      this.waiting.push(waiter);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) {
      clearTimeout(next.timer);
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      // A released permit transfers directly to this waiter, so `active`
      // stays at the limit instead of admitting a newcomer out of FIFO order.
      next.resolve(() => this.release());
      return;
    }
    this.active -= 1;
  }
}

/** A single Host-wide cap for Git subprocess fan-out. */
export const GIT_MAX_CONCURRENCY = 4;
export const GIT_MAX_WAITERS = 128;
const gitSemaphore = new Semaphore(GIT_MAX_CONCURRENCY);

export class GitQueueFullError extends Error {
  constructor() {
    super('Git subprocess queue is full');
    this.name = 'GitQueueFullError';
  }
}

export const REPO_MUTATION_LOCK_TIMEOUT_MS = 5_000;
export const REPO_MUTATION_MAX_WAITERS = 32;

export type RepoMutationLockFailure = 'timed_out' | 'aborted' | 'queue_full';

export class RepoMutationLockError extends Error {
  constructor(readonly reason: RepoMutationLockFailure) {
    const message = reason === 'timed_out'
      ? 'repository mutation lock timed out'
      : reason === 'aborted'
        ? 'repository mutation lock was aborted'
        : 'repository mutation queue is full';
    super(message);
    this.name = 'RepoMutationLockError';
  }
}

export interface RepoMutationLockOptions {
  /** Maximum time resolving repository identity and waiting for ownership. */
  timeoutMs?: number;
  /** Cancels only lock acquisition. Mutations already holding the lock continue. */
  signal?: AbortSignal;
  /** Per-request admission ceiling for already queued waiters. */
  maxWaiters?: number;
}

interface RepoMutationWaiter {
  resolve: (release: () => void) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

interface RepoMutationState {
  held: boolean;
  waiters: RepoMutationWaiter[];
}

// Git protects individual on-disk writes, but a logical mutation can span
// several subprocesses (for example checkout -> merge). Keep a bounded FIFO
// queue per canonical Git common-dir so another Host mutation cannot slip
// between those steps. This lock sits outside the subprocess semaphore:
// different repositories may still use the available Git slots concurrently.
const repoMutationStates = new Map<string, RepoMutationState>();

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return value;
}

function settleRepoIdentityBefore<T>(
  operation: Promise<T>,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new RepoMutationLockError('aborted'));
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return Promise.reject(new RepoMutationLockError('timed_out'));

  return new Promise<T>((resolveResult, rejectResult) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      finish(() => rejectResult(new RepoMutationLockError('aborted')));
    };
    const timer = setTimeout(
      () => finish(() => rejectResult(new RepoMutationLockError('timed_out'))),
      remainingMs,
    );
    signal?.addEventListener('abort', onAbort, { once: true });
    operation.then(
      value => finish(() => resolveResult(value)),
      error => finish(() => rejectResult(error)),
    );
  });
}

async function canonicalPath(
  path: string,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<string> {
  const absolute = resolve(path);
  if (signal?.aborted) throw new RepoMutationLockError('aborted');
  if (Date.now() >= deadlineAt) throw new RepoMutationLockError('timed_out');
  try {
    return await settleRepoIdentityBefore(realpath(absolute), deadlineAt, signal);
  } catch (error) {
    if (error instanceof RepoMutationLockError) throw error;
    return absolute;
  }
}

/**
 * Resolve aliases and linked worktrees to the same repository identity.
 * A non-repository path is still lockable (for initialization/adoption), so
 * an ordinary rev-parse failure falls back to its canonical filesystem path.
 */
async function repoMutationKey(
  repoPath: string,
  deadlineAt: number,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new RepoMutationLockError('aborted');
  const path = await canonicalPath(repoPath, deadlineAt, signal);
  try {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) throw new RepoMutationLockError('timed_out');
    const result = await runGit(['rev-parse', '--git-common-dir'], {
      cwd: path,
      timeoutMs: Math.min(2_000, remainingMs),
      ...(signal ? { signal } : {}),
    });
    if (signal?.aborted) throw new RepoMutationLockError('aborted');
    const commonDir = result.stdout.trim();
    return commonDir
      ? canonicalPath(resolve(path, commonDir), deadlineAt, signal)
      : path;
  } catch (error) {
    if (signal?.aborted) throw new RepoMutationLockError('aborted');
    if (error instanceof CommandExecutionError
      && error.exitCode != null && !error.timedOut && !error.aborted) {
      return path;
    }
    throw error;
  }
}

function acquireRepoMutationLock(
  key: string,
  options: RepoMutationLockOptions,
): Promise<() => void> {
  const timeoutMs = positiveFinite(
    options.timeoutMs ?? REPO_MUTATION_LOCK_TIMEOUT_MS,
    'timeoutMs',
  );
  const maxWaiters = positiveFinite(
    options.maxWaiters ?? REPO_MUTATION_MAX_WAITERS,
    'maxWaiters',
  );
  if (!Number.isInteger(maxWaiters)) {
    throw new TypeError('maxWaiters must be an integer');
  }
  if (options.signal?.aborted) {
    return Promise.reject(new RepoMutationLockError('aborted'));
  }

  let state = repoMutationStates.get(key);
  if (!state) {
    state = { held: false, waiters: [] };
    repoMutationStates.set(key, state);
  }

  const releaseNext = (): void => {
    const currentState = repoMutationStates.get(key);
    if (currentState !== state) return;
    const next = state.waiters.shift();
    if (next) {
      clearTimeout(next.timer);
      if (next.signal && next.onAbort) {
        next.signal.removeEventListener('abort', next.onAbort);
      }
      next.resolve(releaseNext);
      return;
    }
    state.held = false;
    repoMutationStates.delete(key);
  };

  if (!state.held) {
    state.held = true;
    return Promise.resolve(releaseNext);
  }
  if (state.waiters.length >= maxWaiters) {
    return Promise.reject(new RepoMutationLockError('queue_full'));
  }

  return new Promise<() => void>((resolveWaiter, rejectWaiter) => {
    const removeAndReject = (waiter: RepoMutationWaiter, reason: RepoMutationLockFailure): void => {
      const index = state.waiters.indexOf(waiter);
      if (index < 0) return;
      state.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener('abort', waiter.onAbort);
      }
      rejectWaiter(new RepoMutationLockError(reason));
    };
    const waiter = {} as RepoMutationWaiter;
    waiter.resolve = resolveWaiter;
    waiter.signal = options.signal;
    waiter.timer = setTimeout(() => removeAndReject(waiter, 'timed_out'), timeoutMs);
    if (options.signal) {
      waiter.onAbort = () => removeAndReject(waiter, 'aborted');
      options.signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    state.waiters.push(waiter);
  });
}

export async function withRepoMutationLock<T>(
  repoPath: string,
  mutation: () => Promise<T>,
  options: RepoMutationLockOptions = {},
): Promise<T> {
  const timeoutMs = positiveFinite(
    options.timeoutMs ?? REPO_MUTATION_LOCK_TIMEOUT_MS,
    'timeoutMs',
  );
  const deadlineAt = Date.now() + timeoutMs;
  let key: string;
  try {
    key = await repoMutationKey(repoPath, deadlineAt, options.signal);
  } catch (error) {
    if (error instanceof RepoMutationLockError) throw error;
    if (options.signal?.aborted) throw new RepoMutationLockError('aborted');
    if (error instanceof CommandExecutionError && error.timedOut) {
      throw new RepoMutationLockError('timed_out');
    }
    throw error;
  }
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) throw new RepoMutationLockError('timed_out');
  const release = await acquireRepoMutationLock(key, {
    ...options,
    timeoutMs: remainingMs,
  });
  if (options.signal?.aborted) {
    release();
    throw new RepoMutationLockError('aborted');
  }
  if (Date.now() >= deadlineAt) {
    release();
    throw new RepoMutationLockError('timed_out');
  }
  try {
    return await mutation();
  } finally {
    release();
  }
}

export interface RunGitOptions extends RunCommandOptions {
  /** Reject new queued Git work once this many subprocesses are waiting. */
  maxQueueWaiters?: number;
}

export async function runGit(
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<CommandResult> {
  const timeoutMs = positiveFinite(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs');
  const maxQueueWaiters = positiveFinite(
    options.maxQueueWaiters ?? GIT_MAX_WAITERS,
    'maxQueueWaiters',
  );
  if (!Number.isInteger(maxQueueWaiters)) {
    throw new TypeError('maxQueueWaiters must be an integer');
  }
  const startedAt = Date.now();
  let release: () => void;
  try {
    release = await gitSemaphore.acquire({
      timeoutMs,
      maxWaiters: maxQueueWaiters,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (error) {
    if (!(error instanceof SemaphoreAcquisitionError)) throw error;
    if (error.reason === 'queue_full') throw new GitQueueFullError();
    throw new CommandExecutionError({
      message: error.reason === 'aborted'
        ? 'git was aborted while waiting for a subprocess slot'
        : `git timed out after ${timeoutMs}ms while waiting for a subprocess slot`,
      command: 'git',
      args,
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      timedOut: error.reason === 'timed_out',
      aborted: error.reason === 'aborted',
    });
  }

  // A permit may be handed off synchronously just before an abort listener
  // runs. Re-check at the async handoff boundary so canceled Git work cannot
  // spawn and briefly mutate the repository.
  if (options.signal?.aborted) {
    release();
    throw new CommandExecutionError({
      message: 'git was aborted while waiting for a subprocess slot',
      command: 'git',
      args,
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      aborted: true,
    });
  }

  const elapsedMs = Date.now() - startedAt;
  const remainingMs = timeoutMs - elapsedMs;
  if (remainingMs <= 0) {
    release();
    throw new CommandExecutionError({
      message: `git timed out after ${timeoutMs}ms while waiting for a subprocess slot`,
      command: 'git',
      args,
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: null,
      timedOut: true,
    });
  }

  const { maxQueueWaiters: _maxQueueWaiters, ...commandOptions } = options;
  try {
    return await runCommand('git', args, {
      ...commandOptions,
      timeoutMs: remainingMs,
    });
  } finally {
    release();
  }
}

export function commandErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof CommandExecutionError) {
    return error.stderr.trim() || error.message || fallback;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Ordered map with a fixed worker count for non-Git fan-out around scans. */
export async function mapWithConcurrency<T, R>(
  values: readonly T[],
  limit: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError('limit must be a positive integer');
  }
  const result = new Array<R>(values.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      result[index] = await mapper(values[index]!, index);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => worker()),
  );
  return result;
}
