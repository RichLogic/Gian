import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable, Transform } from 'node:stream';

import {
  ClientSideConnection,
  ndJsonStream,
  type Client,
} from '@agentclientprotocol/sdk';

import {
  AcpFrameLimitError,
  AntigravityCleanupError,
  AntigravityRuntimeError,
  asError,
} from './errors.js';
import {
  ACP_MAX_FRAME_BYTES,
  assertOutboundFrame,
  consumeFrameBytes,
  type FrameCursor,
} from './frames.js';
import { antigravityChildEnv } from './home.js';
import { assertServerExecutable, resolvePairedHarness } from './layout.js';

export interface AntigravityProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}

export interface AntigravityProcessTransport {
  connection: ClientSideConnection;
  exit: Promise<AntigravityProcessExit>;
  stop(options?: { force?: boolean }): Promise<void>;
}

/**
 * One ACP server and the process group it leads.
 * The official server owns harness descendants in that group. Leader exit does
 * not release ownership: the group is signaled by its id and must be empty
 * before stop resolves. The wait after SIGKILL is bounded by `gracefulStopMs`.
 * If that deadline passes, stop rejects. A failed signal is included when the
 * leader still has not exited. The parent hook keeps ownership until the
 * group reap finishes. This never uses a provider-wide pkill. Windows cannot
 * address the group and can only signal the leader handle.
 */
export async function spawnAntigravityProcess(
  client: Client,
  options: {
    binaryPath: string;
    cwd: string;
    env: NodeJS.ProcessEnv | undefined;
    gracefulStopMs: number;
  },
): Promise<AntigravityProcessTransport> {
  await assertServerExecutable(options.binaryPath);
  const harnessPath = await resolvePairedHarness(options.binaryPath);
  const childEnv = antigravityChildEnv(
    options.env ? { ...process.env, ...options.env } : { ...process.env },
  );
  childEnv.ANTIGRAVITY_HARNESS_PATH = harnessPath;

  const child = spawn(options.binaryPath, [], {
    cwd: options.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const stdin = child.stdin;
  const stdout = child.stdout;
  const stderr = child.stderr;
  if (!stdin || !stdout || !stderr) {
    const pid = child.pid;
    if (pid !== undefined && pid > 0) {
      try {
        signalOwnedGroup(pid, 'SIGKILL');
      } catch {
        // The spawn error is reported below.
      }
    }
    throw new AntigravityRuntimeError('Antigravity ACP stdio pipes were not created.');
  }

  let released = false;
  const onParentExit = (): void => {
    if (released) return;
    const pid = child.pid;
    if (pid === undefined || pid <= 0) return;
    try {
      signalOwnedGroup(pid, 'SIGKILL');
    } catch {
      // A parent exit cannot report failure asynchronously.
    }
  };
  process.on('exit', onParentExit);
  const releaseOwnership = (): void => {
    if (released) return;
    released = true;
    process.removeListener('exit', onParentExit);
  };

  const leaderExit = waitForLeader(child);
  let frameError: Error | undefined;
  const exit = leaderExit.then(async (event) => {
    const pid = child.pid;
    if (pid !== undefined && pid > 0) await reapOwnedGroup(pid, options.gracefulStopMs);
    releaseOwnership();
    if (frameError && !event.error) return { ...event, error: frameError };
    return event;
  });

  stdin.on('error', () => undefined);
  stderr.on('data', () => undefined);
  stderr.on('error', () => undefined);

  const failFrame = (error: AcpFrameLimitError): void => {
    frameError ??= error;
    const pid = child.pid;
    if (pid === undefined || pid <= 0) return;
    try {
      signalOwnedGroup(pid, 'SIGKILL');
    } catch {
      // Group reap reports the failure.
    }
  };
  const limitedStdout = limitStdout(stdout, ACP_MAX_FRAME_BYTES, failFrame);
  const stream = ndJsonStream(
    boundWritable(Writable.toWeb(stdin) as WritableStream<Uint8Array>, ACP_MAX_FRAME_BYTES, failFrame),
    Readable.toWeb(limitedStdout) as ReadableStream<Uint8Array>,
  );
  const connection = new ClientSideConnection(() => client, stream);
  let stopping: Promise<void> | null = null;

  return {
    connection,
    exit,
    stop(stopOptions) {
      const force = stopOptions?.force === true;
      if (force) {
        const pid = child.pid;
        if (pid !== undefined && pid > 0) {
          try {
            signalOwnedGroup(pid, 'SIGKILL');
          } catch {
            // stopOwnedProcess awaits group reap and surfaces a remaining group.
          }
        }
      }
      stopping ??= stopOwnedProcess(child, leaderExit, exit, options.gracefulStopMs, force);
      return stopping;
    },
  };
}

function limitStdout(
  source: Readable,
  maxBytes: number,
  onLimit: (error: AcpFrameLimitError) => void,
): Readable {
  const state: FrameCursor = { current: 0 };
  const limiter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        consumeFrameBytes(state, chunk, maxBytes);
        callback(null, chunk);
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
  limiter.on('error', (error: Error) => {
    source.unpipe(limiter);
    if (error instanceof AcpFrameLimitError) onLimit(error);
  });
  source.on('error', () => undefined);
  source.pipe(limiter);
  return limiter;
}

function boundWritable(
  inner: WritableStream<Uint8Array>,
  maxBytes: number,
  onLimit: (error: AcpFrameLimitError) => void,
): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        assertOutboundFrame(chunk, maxBytes);
      } catch (error) {
        if (error instanceof AcpFrameLimitError) onLimit(error);
        throw error;
      }
      const writer = inner.getWriter();
      try {
        await writer.write(chunk);
      } finally {
        writer.releaseLock();
      }
    },
    async close() {
      await inner.close();
    },
    async abort(reason) {
      await inner.abort(reason);
    },
  });
}

function waitForLeader(child: ChildProcess): Promise<AntigravityProcessExit> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exitEvent: AntigravityProcessExit): void => {
      if (settled) return;
      settled = true;
      resolve(exitEvent);
    };
    child.once('error', (error) => {
      finish({ code: null, signal: null, error });
    });
    child.once('exit', (code, signal) => {
      finish({ code, signal });
    });
  });
}

/**
 * Stop one owned leader. After SIGKILL, `exit` must settle within
 * `gracefulStopMs`. A timed-out or failed kill throws `AntigravityCleanupError`
 * and does not release the parent exit hook; that hook is removed only after
 * the group reap inside `exit` finishes.
 */
export async function stopOwnedProcess(
  child: ChildProcess,
  leaderExit: Promise<AntigravityProcessExit>,
  exit: Promise<AntigravityProcessExit>,
  gracefulStopMs: number,
  force: boolean,
): Promise<void> {
  const pid = child.pid ?? -1;
  let signalError: Error | undefined;
  const signal = (name: NodeJS.Signals): void => {
    if (pid <= 0) return;
    try {
      signalOwnedGroup(pid, name);
    } catch (error) {
      signalError = asError(error);
    }
  };
  if (force || leaderExited(child)) {
    signal('SIGKILL');
  } else {
    try {
      child.stdin?.end();
    } catch {
      // The pipe is already closed.
    }
    if (!(await settlesWithin(leaderExit, gracefulStopMs))) {
      signal('SIGTERM');
      if (!(await settlesWithin(leaderExit, gracefulStopMs))) signal('SIGKILL');
    }
  }
  try {
    await waitForOwnedExit(exit, gracefulStopMs, pid);
  } catch (error) {
    if (signalError) throw new AntigravityCleanupError(signalError);
    throw error;
  }
}

/**
 * Bound the final leader-exit and group-reap wait. Timing out leaves process
 * group ownership with the parent hook.
 */
async function waitForOwnedExit(
  exit: Promise<AntigravityProcessExit>,
  timeoutMs: number,
  pid: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new AntigravityCleanupError(new AntigravityRuntimeError(
        `Antigravity ACP process ${pid} did not exit within ${timeoutMs}ms after SIGKILL.`,
      )));
    }, timeoutMs);
  });
  void deadline.catch(() => undefined);
  try {
    await Promise.race([exit, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function leaderExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/**
 * SIGKILL the owned process group and wait until no member remains.
 * A dead leader does not skip this. Windows has no group signal.
 */
async function reapOwnedGroup(pid: number, budgetMs: number): Promise<void> {
  if (process.platform === 'win32') return;
  signalOwnedGroup(pid, 'SIGKILL');
  const started = Date.now();
  for (;;) {
    if (!groupHasMembers(pid)) return;
    if (Date.now() - started >= budgetMs) {
      throw new AntigravityRuntimeError(
        `Antigravity ACP process group ${pid} still has descendants after SIGKILL.`,
      );
    }
    await delay(20);
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    promise.then(() => finish(true), () => finish(true));
  });
}
