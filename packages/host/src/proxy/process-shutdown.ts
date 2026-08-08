import type { ChildProcess } from 'node:child_process';

const SHUTDOWN_GRACE_MS = 500;
const PROCESS_GROUP_POLL_MS = 20;

export interface ProxyProcessShutdownState {
  /** Once TERM/KILL escalation has been attempted, a later retry may only
   * verify ESRCH. The numeric PGID could have been reused by an unrelated
   * process group, so signalling it again would be unsafe. */
  readonly escalationAttempted: boolean;
  /** Once absence was observed, this exact process tree is terminal even if
   * the numeric PGID later resolves to an unrelated live group. */
  readonly absenceObserved: boolean;
  observeAbsence(): void;
  /** Atomically mark the first signalling escalation. False means another
   * path already signalled this numeric PGID and callers must only verify. */
  beginEscalation(): boolean;
}

export function createProxyProcessShutdownState(): ProxyProcessShutdownState {
  let escalationAttempted = false;
  let absenceObserved = false;
  return {
    get escalationAttempted() {
      return escalationAttempted;
    },
    get absenceObserved() {
      return absenceObserved;
    },
    observeAbsence() {
      absenceObserved = true;
    },
    beginEscalation() {
      if (absenceObserved || escalationAttempted) return false;
      escalationAttempted = true;
      return true;
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function errnoCode(error: unknown): string | undefined {
  return error instanceof Error
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

/**
 * A detached child is its process-group leader on POSIX. The leader exiting is
 * not sufficient evidence that its vendor CLI descendants have stopped: they
 * retain the original PGID after being re-parented. Signal 0 is the only
 * completion check used on POSIX so a runtime lease cannot be released while
 * any member of that group still exists.
 */
function processGroupIsEmpty(groupId: number): boolean {
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

async function waitUntil(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return check();
    await delay(Math.min(PROCESS_GROUP_POLL_MS, remaining));
  }
  return true;
}

/**
 * Bound a Proxy shutdown and do not return until the process tree exited.
 * All Gian Proxy hosts are detached process-group leaders so escalation also
 * terminates any vendor CLI child that failed to drain during the RPC.
 */
export async function shutdownProxyProcess(input: {
  child: Pick<ChildProcess, 'pid' | 'kill'>;
  isExited: () => boolean;
  requestShutdown?: () => Promise<unknown>;
  label: string;
  state?: ProxyProcessShutdownState;
  /** Internal test seams for PGID reuse simulations. */
  probeProcessGroupEmpty?: (groupId: number) => boolean;
  signalProcessGroup?: (groupId: number, signal: NodeJS.Signals) => void;
}): Promise<void> {
  const state = input.state ?? createProxyProcessShutdownState();
  const childPid = input.child.pid;
  const groupId = process.platform !== 'win32'
    && childPid !== undefined
    && Number.isInteger(childPid)
    && childPid > 0
    ? childPid
    : null;
  const processTreeExited = (): boolean => {
    if (state.absenceObserved) return true;
    const exited = groupId !== null
      ? input.isExited() && (
          input.probeProcessGroupEmpty?.(groupId) ?? processGroupIsEmpty(groupId)
        )
      : input.isExited();
    if (exited) state.observeAbsence();
    return exited;
  };

  if (processTreeExited()) return;

  if (state.escalationAttempted) {
    if (await waitUntil(processTreeExited, SHUTDOWN_GRACE_MS)) return;
    throw new Error(
      `${input.label} process group is still present after a prior shutdown escalation; refusing to signal a potentially reused PGID.`,
    );
  }

  const signalGroup = (signal: NodeJS.Signals): void => {
    if (groupId !== null) {
      try {
        if (input.signalProcessGroup) input.signalProcessGroup(groupId, signal);
        else process.kill(-groupId, signal);
      } catch { /* checked below */ }
    }
    // Keep a direct-child fallback for non-POSIX platforms and for platforms
    // where detached process groups are unavailable. POSIX completion still
    // requires kill(-pgid, 0) to report ESRCH.
    try { input.child.kill(signal); } catch { /* checked below */ }
  };

  if (input.requestShutdown && !input.isExited()) {
    const acknowledged = await Promise.race([
      Promise.resolve().then(input.requestShutdown).then(() => true, () => false),
      delay(SHUTDOWN_GRACE_MS).then(() => false),
    ]);
    if (acknowledged && await waitUntil(processTreeExited, SHUTDOWN_GRACE_MS)) return;
    if (processTreeExited()) return;
  }

  // A concurrent forceKill/shutdown can have escalated while the graceful
  // request above was awaiting. Never signal the same numeric PGID twice.
  if (!state.beginEscalation()) {
    if (await waitUntil(processTreeExited, SHUTDOWN_GRACE_MS)) return;
    throw new Error(
      `${input.label} process group is still present after a prior shutdown escalation; refusing to signal a potentially reused PGID.`,
    );
  }
  signalGroup('SIGTERM');
  if (await waitUntil(processTreeExited, SHUTDOWN_GRACE_MS)) return;
  signalGroup('SIGKILL');
  if (await waitUntil(processTreeExited, SHUTDOWN_GRACE_MS)) return;
  throw new Error(`${input.label} process group did not exit after shutdown escalation.`);
}
