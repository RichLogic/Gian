import { spawn, type ChildProcess } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { once } from 'node:events';

import { readNdjsonLines } from '@gian/proxy-protocol';

import type { AgentUpdateLease } from '../agents/update-lock.js';
import {
  createProxyProcessShutdownState,
  shutdownProxyProcess,
} from './process-shutdown.js';

export interface ProtectedChildExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ProtectedProxyChildContext {
  child: ChildProcess;
  iterator: AsyncIterator<string>;
  deadline: Promise<never>;
  isExited: () => boolean;
  waitForExit: () => Promise<ProtectedChildExit>;
  exit: () => ProtectedChildExit | null;
  processFailureDetail: () => string;
  stdout: () => string;
  stdoutOverflow: () => boolean;
}

export const MAX_PROTECTED_CHILD_STDOUT_BYTES = 64 * 1024;

export async function runProtectedProxyChild<T>(input: {
  label: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  protector: AgentUpdateLease;
  timeoutMs: number;
  probeDirectory?: string;
  allowAlreadyEmpty?: boolean;
  collectStdout?: boolean;
  shutdownProcess?: typeof shutdownProxyProcess;
  work: (context: ProtectedProxyChildContext) => Promise<T>;
}): Promise<T> {
  let reservation: Awaited<ReturnType<AgentUpdateLease['reserveProcessGroup']>>;
  try {
    reservation = await input.protector.reserveProcessGroup();
  } catch (error) {
    if (input.probeDirectory) {
      try {
        await rm(input.probeDirectory, { recursive: true, force: true });
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `${input.label} reservation cleanup failed.`,
        );
      }
    }
    throw error;
  }

  let child: ChildProcess;
  try {
    child = spawn(process.execPath, input.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: input.env,
    });
  } catch (error) {
    await reservation.cancelBeforeSpawn();
    if (input.probeDirectory) {
      await rm(input.probeDirectory, { recursive: true, force: true });
    }
    throw error;
  }

  const groupId = child.pid;
  let registered = false;
  let registrationAlreadyEmpty = false;
  let exited = false;
  let spawnFailed = false;
  let spawnError: Error | null = null;
  let stdinError: Error | null = null;
  let stderr = '';
  let stdout = '';
  let stdoutBytes = 0;
  let stdoutOverflow = false;
  let exitResult: ProtectedChildExit | null = null;
  const exitPromise = new Promise<ProtectedChildExit>((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      exitResult = { code, signal };
      resolve(exitResult);
    });
  });
  const stdoutClosed = !input.collectStdout || !child.stdout
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
      child.stdout!.once('end', () => resolve());
      child.stdout!.once('error', () => resolve());
    });
  const waitForExit = (): Promise<ProtectedChildExit> => (
    Promise.all([exitPromise, stdoutClosed]).then(([exit]) => exit)
  );
  child.once('error', (error) => {
    spawnFailed = true;
    spawnError = error;
    exited = true;
  });
  child.stdin?.on('error', (error) => {
    stdinError = error;
  });
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr = `${stderr}${chunk}`.slice(-8_192);
  });
  if (input.collectStdout) {
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk);
      if (stdoutBytes > MAX_PROTECTED_CHILD_STDOUT_BYTES) {
        stdoutOverflow = true;
        return;
      }
      stdout += chunk;
    });
  }

  const iterator = input.collectStdout || !child.stdout
    ? {
      async next() {
        return { done: true as const, value: undefined as unknown as string };
      },
      async return() {
        return { done: true as const, value: undefined as unknown as string };
      },
    }
    : readNdjsonLines(child.stdout)[Symbol.asyncIterator]();
  let timeout!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error(`${input.label} timed out.`));
    }, input.timeoutMs);
  });
  const processFailureDetail = (): string => (
    spawnError?.message || stdinError?.message || stderr.trim() || 'process exited'
  );

  let operationError: unknown;
  let result: T | undefined;
  try {
    if (groupId === undefined || groupId <= 0) {
      throw new Error(`${input.label} process group is unavailable.`);
    }
    const registration = await reservation.register(groupId);
    registered = registration === 'registered';
    registrationAlreadyEmpty = registration === 'already-empty';
    if (registration === 'already-empty' && !input.allowAlreadyEmpty) {
      throw new Error(`${input.label} process exited before registration.`);
    }
    result = await input.work({
      child,
      iterator,
      deadline,
      isExited: () => exited,
      waitForExit,
      exit: () => exitResult,
      processFailureDetail,
      stdout: () => stdout,
      stdoutOverflow: () => stdoutOverflow,
    });
  } catch (error) {
    operationError = error;
  }

  clearTimeout(timeout);
  await iterator.return?.(undefined);
  try { child.stdin?.end(); } catch { /* pipe already closed */ }
  const cleanupErrors: unknown[] = [];
  let groupConfirmedEmpty = registrationAlreadyEmpty;
  if (!groupConfirmedEmpty) {
    try {
      await (input.shutdownProcess ?? shutdownProxyProcess)({
        child,
        isExited: () => exited,
        label: input.label,
        state: createProxyProcessShutdownState(),
      });
      groupConfirmedEmpty = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (groupConfirmedEmpty) {
    try {
      if (registered) await reservation.release();
      else if (groupId !== undefined) await reservation.releaseUnregistered(groupId);
      else if (spawnFailed) await reservation.cancelBeforeSpawn();
      else {
        throw new Error(
          `${input.label} has no verifiable process group; retaining its pending reservation.`,
        );
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (input.probeDirectory) {
    try {
      await rm(input.probeDirectory, { recursive: true, force: true });
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (operationError || cleanupErrors.length > 0) {
    if (cleanupErrors.length === 0) throw operationError;
    throw new AggregateError(
      operationError ? [operationError, ...cleanupErrors] : cleanupErrors,
      `${input.label} cleanup failed.`,
    );
  }
  return result as T;
}

export async function writeJsonRpc(
  child: ChildProcess,
  payload: unknown,
  deadline: Promise<never>,
): Promise<void> {
  const frame = `${JSON.stringify(payload)}\n`;
  if (!child.stdin) throw new Error('Protected child stdin is unavailable.');
  if (!child.stdin.write(frame)) {
    await Promise.race([once(child.stdin, 'drain').then(() => undefined), deadline]);
  }
}
