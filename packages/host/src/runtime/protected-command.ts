import { spawn, type ChildProcess } from 'node:child_process';
import {
  createProxyProcessShutdownState,
  shutdownProxyProcess,
} from '../proxy/process-shutdown.js';
import type { RuntimeProcessGroupProtector } from './types.js';

export interface ProtectedCommandOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
  label: string;
  protector?: RuntimeProcessGroupProtector;
  /** Internal test seam for proving already-empty registrations never enter
   * a signalling shutdown path. */
  shutdownProcess?: typeof shutdownProxyProcess;
}

/**
 * Spawn a command as a POSIX process-group leader under a pre-published claim
 * reservation. Success is returned only after both the leader has exited and
 * kill(-pgid, 0) reports ESRCH. Failure retains the reservation whenever that
 * proof cannot be established.
 */
export async function runProtectedCommand(
  options: ProtectedCommandOptions,
): Promise<{ stdout: string; stderr: string }> {
  if (options.protector && process.platform === 'win32') {
    throw new Error(`${options.label} protected process groups require POSIX.`);
  }

  const reservation = await options.protector?.reserveProcessGroup();
  let child: ChildProcess | undefined;
  let groupId: number | undefined;
  let registered = false;
  let exited = false;
  let groupConfirmedEmpty = false;
  let reservationReleased = false;
  let registrationAlreadyEmpty = false;
  let spawnFailed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const shutdownState = createProxyProcessShutdownState();

  try {
    let stdout = '';
    let stderr = '';
    let buffered = 0;
    let settle!: (value: { stdout: string; stderr: string }) => void;
    let fail!: (error: unknown) => void;
    let settled = false;
    const completion = new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const rejectOnce = (error: unknown): void => {
      if (settled) return;
      settled = true;
      fail(error);
    };
    const resolveOnce = (): void => {
      if (settled) return;
      settled = true;
      settle({ stdout, stderr });
    };

    child = spawn(options.command, options.args, {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env,
    });
    groupId = child.pid;
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      buffered += Buffer.byteLength(text);
      if (buffered > options.maxBuffer) {
        rejectOnce(new Error(`${options.label} output exceeded its limit.`));
        return;
      }
      stdout += text;
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      buffered += Buffer.byteLength(text);
      if (buffered > options.maxBuffer) {
        rejectOnce(new Error(`${options.label} output exceeded its limit.`));
        return;
      }
      stderr += text;
    });
    child.once('error', error => {
      spawnFailed = true;
      exited = true;
      rejectOnce(error);
    });
    child.once('exit', () => {
      exited = true;
    });
    // Node's `close` follows `exit` only after the stdio streams have closed.
    // Resolve from here so a final data chunk delivered after `exit` is not
    // omitted from version/installer output. The command timeout still bounds
    // descendants that inherit and keep those descriptors open.
    child.once('close', (code, signal) => {
      exited = true;
      if (code === 0) resolveOnce();
      else rejectOnce(new Error(
        `${options.label} exited with ${code === null ? `signal ${signal ?? 'unknown'}` : `code ${code}`}.`,
      ));
    });
    timeout = setTimeout(() => {
      rejectOnce(new Error(`${options.label} timed out.`));
    }, options.timeoutMs);
    void completion.catch(() => undefined);

    if (groupId === undefined || groupId <= 0) {
      throw new Error(`${options.label} process group is unavailable.`);
    }
    const registration = await reservation?.register(groupId);
    registered = registration === 'registered';
    registrationAlreadyEmpty = registration === 'already-empty';
    if (registrationAlreadyEmpty) groupConfirmedEmpty = true;
    const result = await completion;
    if (!groupConfirmedEmpty) {
      await (options.shutdownProcess ?? shutdownProxyProcess)({
        child,
        isExited: () => exited,
        label: options.label,
        state: shutdownState,
      });
      groupConfirmedEmpty = true;
    }
    if (reservation) {
      if (registered) await reservation.release();
      else if (registrationAlreadyEmpty) await reservation.releaseUnregistered(groupId);
      else throw new Error(`${options.label} process-group registration did not complete.`);
      reservationReleased = true;
    }
    return result;
  } catch (error) {
    const cleanupErrors: unknown[] = [];
    if (child && !groupConfirmedEmpty) {
      try {
        await (options.shutdownProcess ?? shutdownProxyProcess)({
          child,
          isExited: () => exited,
          label: options.label,
          state: shutdownState,
        });
        groupConfirmedEmpty = true;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    } else if (!child) {
      groupConfirmedEmpty = true;
    }

    if (reservation && groupConfirmedEmpty && !reservationReleased) {
      try {
        if (registered) {
          await reservation.release();
        } else if (groupId !== undefined && groupId > 0) {
          await reservation.releaseUnregistered(groupId);
        } else if (!child || spawnFailed) {
          await reservation.cancelBeforeSpawn();
        } else {
          throw new Error(
            `${options.label} spawned without a verifiable process group; retaining its pending reservation.`,
          );
        }
        reservationReleased = true;
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `${options.label} cleanup could not prove its process group exited.`,
      );
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
