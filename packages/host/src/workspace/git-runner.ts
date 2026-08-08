import { spawn } from 'node:child_process';

export type GitCommandErrorKind =
  | 'aborted'
  | 'authentication'
  | 'command'
  | 'not-found'
  | 'not-repository'
  | 'output-limit'
  | 'timeout';

export class GitCommandError extends Error {
  readonly kind: GitCommandErrorKind;
  readonly args: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout: string;

  constructor(input: {
    kind: GitCommandErrorKind;
    args: readonly string[];
    message: string;
    exitCode?: number | null;
    stderr?: string;
    stdout?: string;
  }) {
    super(input.message);
    this.name = 'GitCommandError';
    this.kind = input.kind;
    this.args = input.args;
    this.exitCode = input.exitCode ?? null;
    this.stderr = input.stderr ?? '';
    this.stdout = input.stdout ?? '';
  }
}

export interface RunGitOptions {
  /** Non-zero exit codes which are part of normal command semantics. */
  acceptExitCodes?: readonly number[];
  /** Abort propagation from the caller. */
  signal?: AbortSignal;
  /** Optional stdin bytes. An empty string is still written and closed. */
  stdin?: string | Buffer;
  /** Maximum captured stderr bytes. Excess stderr is discarded. */
  maxStderrBytes?: number;
  /** Maximum captured stdout bytes. Defaults to 4 MiB. */
  maxStdoutBytes?: number;
  /** Return the prefix and mark it truncated instead of throwing at the cap. */
  truncateStdout?: boolean;
  /** Wall-clock deadline. Defaults to 10 seconds. */
  timeoutMs?: number;
}

export interface GitCommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
  truncated: boolean;
}

export function classifyGitFailure(stderr: string): GitCommandErrorKind {
  const normalized = stderr.toLowerCase();
  if (
    normalized.includes('authentication failed')
    || normalized.includes('could not read username')
    || normalized.includes('could not read password')
    || normalized.includes('unable to read askpass response')
    || normalized.includes('terminal prompts disabled')
    || normalized.includes('permission denied (publickey)')
  ) return 'authentication';
  if (normalized.includes('not a git repository')) return 'not-repository';
  if (
    normalized.includes('unknown revision')
    || normalized.includes('bad object')
    || normalized.includes('needed a single revision')
    || normalized.includes('ambiguous argument')
  ) return 'not-found';
  return 'command';
}

/**
 * Run Git without blocking Host's event loop.
 *
 * The child has no shell, cannot prompt for credentials, is bounded by time
 * and output size, and is always reaped after timeout/abort/output overflow.
 */
export function runGit(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<GitCommandResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const maxStdoutBytes = options.maxStdoutBytes ?? 4 * 1024 * 1024;
  const maxStderrBytes = options.maxStderrBytes ?? 256 * 1024;
  const accepted = new Set(options.acceptExitCodes ?? []);

  if (options.signal?.aborted) {
    return Promise.reject(new GitCommandError({
      kind: 'aborted',
      args,
      message: 'Git command aborted before start',
    }));
  }

  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], {
      env: {
        ...process.env,
        GIT_ASKPASS: '/usr/bin/false',
        GIT_TERMINAL_PROMPT: '0',
        SSH_ASKPASS: '/usr/bin/false',
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let forcedKind: GitCommandErrorKind | null = null;
    let settled = false;
    let hardKillTimer: NodeJS.Timeout | null = null;

    const stopChild = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      hardKillTimer = setTimeout(() => child.kill('SIGKILL'), 250);
      hardKillTimer.unref();
    };

    const onAbort = (): void => {
      forcedKind = 'aborted';
      stopChild();
    };

    const timer = setTimeout(() => {
      forcedKind = 'timeout';
      stopChild();
    }, timeoutMs);
    timer.unref();
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };

    const stdoutText = (): string => Buffer.concat(stdoutChunks).toString('utf8');
    const stderrText = (): string => Buffer.concat(stderrChunks).toString('utf8');

    child.stdout.on('data', (raw: Buffer) => {
      if (truncated) return;
      const remaining = Math.max(0, maxStdoutBytes - stdoutBytes);
      if (raw.length <= remaining) {
        stdoutChunks.push(raw);
        stdoutBytes += raw.length;
        return;
      }
      if (remaining > 0) stdoutChunks.push(raw.subarray(0, remaining));
      stdoutBytes = maxStdoutBytes;
      truncated = true;
      if (!options.truncateStdout) forcedKind = 'output-limit';
      stopChild();
    });

    child.stderr.on('data', (raw: Buffer) => {
      const remaining = Math.max(0, maxStderrBytes - stderrBytes);
      if (remaining === 0) return;
      const kept = raw.subarray(0, remaining);
      stderrChunks.push(kept);
      stderrBytes += kept.length;
    });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new GitCommandError({
        kind: forcedKind ?? 'command',
        args,
        message: err.message,
        stderr: stderrText(),
        stdout: stdoutText(),
      }));
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      cleanup();
      const stdout = stdoutText();
      const stderr = stderrText();
      if (truncated && options.truncateStdout) {
        resolve({ exitCode: code ?? 0, stdout, stderr, truncated: true });
        return;
      }
      if (forcedKind) {
        reject(new GitCommandError({
          kind: forcedKind,
          args,
          exitCode: code,
          message:
            forcedKind === 'timeout' ? `Git command timed out after ${timeoutMs}ms`
            : forcedKind === 'aborted' ? 'Git command aborted'
            : `Git output exceeded ${maxStdoutBytes} bytes`,
          stderr,
          stdout,
        }));
        return;
      }
      if (code === 0 || (code !== null && accepted.has(code))) {
        resolve({ exitCode: code ?? 0, stdout, stderr, truncated: false });
        return;
      }
      const kind = classifyGitFailure(stderr);
      reject(new GitCommandError({
        kind,
        args,
        exitCode: code,
        message: stderr.trim() || `Git exited with code ${code ?? 'unknown'}`,
        stderr,
        stdout,
      }));
    });

    // A command may exit before consuming stdin (for example an invalid
    // revision). EPIPE is part of child teardown, not a Host-level crash.
    child.stdin.on('error', () => undefined);
    if (options.stdin === undefined) child.stdin.end();
    else child.stdin.end(options.stdin);
  });
}
