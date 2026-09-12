import { spawn } from 'node:child_process';

export interface BoundedCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface BoundedCommandHooks {
  probeProcessGroup?: (groupId: number) => boolean;
  signalProcessGroup?: (groupId: number, signal: NodeJS.Signals) => void;
}

export interface BoundedCommandOptions {
  timeoutMs?: number;
  terminateGraceMs?: number;
  maxBufferBytes?: number;
  env?: NodeJS.ProcessEnv;
  hooks?: BoundedCommandHooks;
}

export class BoundedCommandError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;

  constructor(params: {
    message: string;
    command: string;
    args: readonly string[];
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut?: boolean;
  }) {
    super(params.message);
    this.name = 'BoundedCommandError';
    this.command = params.command;
    this.args = params.args;
    this.stdout = params.stdout;
    this.stderr = params.stderr;
    this.exitCode = params.exitCode;
    this.signal = params.signal;
    this.timedOut = params.timedOut ?? false;
  }
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_TERMINATE_GRACE_MS = 250;
const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024;
const GROUP_POLL_MS = 20;

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
}

export function processGroupIsEmpty(groupId: number): boolean {
  try {
    process.kill(-groupId, 0);
    return false;
  } catch (error) {
    const code = errnoCode(error);
    if (code === 'ESRCH') return true;
    if (code === 'EPERM') return false;
    throw error;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * One-settle bounded probe command. POSIX children are process-group
 * leaders. The first ESRCH on a numeric PGID permanently disables further
 * probes and signals for that group. TERM→KILL stays armed only while the
 * original group is continuously present.
 */
export function runBoundedCommand(
  command: string,
  args: readonly string[],
  options: BoundedCommandOptions = {},
): Promise<BoundedCommandResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const terminateGraceMs = options.terminateGraceMs ?? DEFAULT_TERMINATE_GRACE_MS;
  const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;
  const hooks = options.hooks;

  return new Promise<BoundedCommandResult>((resolve, reject) => {
    const detached = process.platform !== 'win32';
    const child = spawn(command, [...args], {
      detached,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ?? process.env,
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let terminating = false;
    let timedOut = false;
    let overflowed = false;
    let absenceObserved = false;
    let escalationAttempted = false;
    let killTimer: NodeJS.Timeout | null = null;
    const deadGroups = new Set<number>();

    const captured = () => ({
      stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString('utf8'),
      stderr: Buffer.concat(stderrChunks, stderrBytes).toString('utf8'),
    });

    const markAbsent = (groupId: number): void => {
      deadGroups.add(groupId);
      absenceObserved = true;
    };

    const probeEmpty = (groupId: number): boolean => {
      if (deadGroups.has(groupId)) return true;
      try {
        const empty = hooks?.probeProcessGroup
          ? hooks.probeProcessGroup(groupId)
          : processGroupIsEmpty(groupId);
        if (empty) markAbsent(groupId);
        return empty;
      } catch (error) {
        if (errnoCode(error) === 'ESRCH') {
          markAbsent(groupId);
          return true;
        }
        throw error;
      }
    };

    const signalProcess = (signal: NodeJS.Signals): void => {
      if (child.pid == null || deadGroups.has(child.pid)) return;
      try {
        if (hooks?.signalProcessGroup && detached) {
          hooks.signalProcessGroup(child.pid, signal);
          return;
        }
        if (detached) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (error) {
        if (errnoCode(error) === 'ESRCH') markAbsent(child.pid);
      }
    };

    const clearTimers = (): void => {
      clearTimeout(deadlineTimer);
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    };

    const finishReject = (
      message: string,
      exitCode: number | null,
      exitSignal: NodeJS.Signals | null,
    ): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      const output = captured();
      reject(new BoundedCommandError({
        message,
        command,
        args,
        stdout: output.stdout,
        stderr: output.stderr,
        exitCode,
        signal: exitSignal,
        timedOut,
      }));
    };

    const finishResolve = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimers();
      resolve({ ...captured(), exitCode });
    };

    const terminate = (): void => {
      if (terminating) return;
      terminating = true;
      if (!absenceObserved) {
        escalationAttempted = true;
        signalProcess('SIGTERM');
        killTimer = setTimeout(() => {
          if (!absenceObserved) signalProcess('SIGKILL');
        }, terminateGraceMs);
        killTimer.unref();
      }
    };

    const append = (target: Buffer[], chunk: Buffer, stream: 'stdout' | 'stderr'): void => {
      if (overflowed) return;
      target.push(chunk);
      if (stream === 'stdout') stdoutBytes += chunk.length;
      else stderrBytes += chunk.length;
      if (stdoutBytes + stderrBytes > maxBufferBytes) {
        overflowed = true;
        terminate();
      }
    };

    child.stdout.on('data', (chunk: Buffer | string) => {
      append(stdoutChunks, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), 'stdout');
    });
    child.stderr.on('data', (chunk: Buffer | string) => {
      append(stderrChunks, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), 'stderr');
    });

    const streamClosed = (stream: typeof child.stdout | typeof child.stderr): Promise<void> => (
      new Promise((resolveStream) => {
        if (stream.readableEnded || stream.destroyed) {
          resolveStream();
          return;
        }
        stream.once('close', () => resolveStream());
      })
    );
    const stdioDrained = Promise.all([
      streamClosed(child.stdout),
      streamClosed(child.stderr),
    ]);

    const waitForGroupEmpty = async (groupId: number, timeoutMs: number): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (!probeEmpty(groupId)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return probeEmpty(groupId);
        await delay(Math.min(GROUP_POLL_MS, remaining));
      }
      return true;
    };

    child.once('error', (error) => {
      finishReject(`${command} failed to start: ${error.message}`, null, null);
    });

    child.once('exit', (exitCode, exitSignal) => {
      void (async () => {
        await stdioDrained;
        const pgid = child.pid;
        const proveEmpty = async (): Promise<boolean> => {
          if (!detached || pgid == null) return true;
          return waitForGroupEmpty(
            pgid,
            terminating ? terminateGraceMs + 1_500 : 2_000,
          );
        };

        if (overflowed || timedOut || terminating) {
          let empty = await proveEmpty();
          if (!empty && !absenceObserved) {
            if (!escalationAttempted) {
              escalationAttempted = true;
              signalProcess('SIGKILL');
            } else {
              signalProcess('SIGKILL');
            }
            empty = await proveEmpty();
          }
          if (settled) return;
          if (!empty) {
            finishReject(`${command} left descendants in its process group`, exitCode, exitSignal);
            return;
          }
          if (overflowed) {
            finishReject(`${command} exceeded ${maxBufferBytes} bytes of output`, exitCode, exitSignal);
            return;
          }
          if (timedOut) {
            finishReject(`${command} timed out after ${timeoutMs}ms`, exitCode, exitSignal);
            return;
          }
          finishReject(`${command} was terminated before a clean exit`, exitCode, exitSignal);
          return;
        }

        const empty = !detached || pgid == null || probeEmpty(pgid);
        if (settled) return;
        if (!empty) {
          terminate();
          const cleaned = await proveEmpty();
          if (settled) return;
          finishReject(
            cleaned
              ? `${command} exited 0 but left a descendant that had to be cleaned`
              : `${command} exited 0 but left descendants in its process group`,
            exitCode,
            exitSignal,
          );
          return;
        }
        if (exitSignal) {
          finishReject(`${command} exited with signal ${exitSignal}`, exitCode, exitSignal);
          return;
        }
        if (exitCode !== 0) {
          finishReject(`${command} exited ${exitCode}`, exitCode, exitSignal);
          return;
        }
        finishResolve(0);
      })().catch((error: unknown) => {
        finishReject(
          error instanceof Error ? error.message : String(error),
          null,
          null,
        );
      });
    });

    const deadlineTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    deadlineTimer.unref();
  });
}
