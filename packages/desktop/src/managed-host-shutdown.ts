import type { ChildProcess } from 'node:child_process';

export const MANAGED_HOST_SHUTDOWN_TIMEOUT_MS = 15_000;

export interface ManagedHostShutdownScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type ManagedHostShutdownResult = 'exited' | 'timed-out';

const defaultScheduler: ManagedHostShutdownScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Ask the parent-managed Host to close terminals and Provider process trees,
 * then wait a bounded interval for its process to exit. The caller owns the
 * policy after timeout; this helper never sends an unbounded/destructive kill.
 */
export async function stopManagedHostGracefully(
  child: ChildProcess,
  options: {
    timeoutMs?: number;
    scheduler?: ManagedHostShutdownScheduler;
  } = {},
): Promise<ManagedHostShutdownResult> {
  if (child.exitCode !== null || child.signalCode !== null) return 'exited';
  const timeoutMs = options.timeoutMs ?? MANAGED_HOST_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
    throw new RangeError('timeoutMs must be a finite non-negative number');
  }
  const scheduler = options.scheduler ?? defaultScheduler;

  return new Promise(resolve => {
    let settled = false;
    let timer: unknown = null;
    const finish = (result: 'exited' | 'timed-out') => {
      if (settled) return;
      settled = true;
      child.off('exit', onExit);
      if (timer !== null) scheduler.clearTimeout(timer);
      resolve(result);
    };
    const onExit = () => { finish('exited'); };
    child.once('exit', onExit);
    timer = scheduler.setTimeout(() => { finish('timed-out'); }, timeoutMs);

    try { child.stdin?.end(); } catch {}
    try { child.kill('SIGTERM'); } catch {}

    // A mocked or already-reaped process may update synchronously without an
    // exit event. Observe that state after signalling as a final fast path.
    if (child.exitCode !== null || child.signalCode !== null) finish('exited');
  });
}

/**
 * Reuse one graceful shutdown request per child across competing quit intents.
 * A timeout stops waiting, but the permanent exit observation remains valid so
 * a later retry neither signals twice nor misses a late child exit.
 */
export class ManagedHostDrainCoordinator {
  private readonly exits = new WeakMap<ChildProcess, Promise<void>>();

  constructor(
    private readonly options: {
      timeoutMs?: number;
      scheduler?: ManagedHostShutdownScheduler;
    } = {},
  ) {}

  stop = async (child: ChildProcess): Promise<ManagedHostShutdownResult> => {
    if (child.exitCode !== null || child.signalCode !== null) return 'exited';
    const timeoutMs = this.options.timeoutMs ?? MANAGED_HOST_SHUTDOWN_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError('timeoutMs must be a finite non-negative number');
    }
    const scheduler = this.options.scheduler ?? defaultScheduler;
    let exited = this.exits.get(child);
    if (!exited) {
      let observeExit!: () => void;
      exited = new Promise<void>(resolve => { observeExit = resolve; });
      this.exits.set(child, exited);
      child.once('exit', observeExit);
      try { child.stdin?.end(); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      if (child.exitCode !== null || child.signalCode !== null) observeExit();
    }

    return new Promise(resolve => {
      let settled = false;
      let timer: unknown = null;
      const finish = (result: ManagedHostShutdownResult) => {
        if (settled) return;
        settled = true;
        if (timer !== null) scheduler.clearTimeout(timer);
        resolve(result);
      };
      void exited.then(() => { finish('exited'); });
      timer = scheduler.setTimeout(() => { finish('timed-out'); }, timeoutMs);
    });
  };
}

export interface ManagedHostQuitGateCallbacks {
  onReleased(): void;
  onBlocked(): void;
}

export type ManagedHostReplacementResult = 'started' | 'blocked' | 'failed';

/**
 * Drain-first state machine for app.relaunch()/quitAndInstall(). Electron may
 * remember either replacement before before-quit is emitted, so callers must
 * invoke the replacement only from the `exited` branch here.
 */
export class ManagedHostReplacementGate {
  private phase: 'idle' | 'draining' | 'armed' = 'idle';
  private pending: Promise<ManagedHostReplacementResult> | null = null;

  constructor(
    private readonly shutdown: (
      child: ChildProcess,
    ) => Promise<ManagedHostShutdownResult> = stopManagedHostGracefully,
  ) {}

  isDraining(): boolean {
    return this.phase === 'draining';
  }

  isArmed(): boolean {
    return this.phase === 'armed';
  }

  run(
    child: ChildProcess | null,
    startReplacement: () => boolean,
  ): Promise<ManagedHostReplacementResult> {
    if (this.phase === 'armed') return Promise.resolve('started');
    if (this.pending) return this.pending;

    this.phase = 'draining';
    const shutdown = !child
      || child.exitCode !== null
      || child.signalCode !== null
      ? Promise.resolve<ManagedHostShutdownResult>('exited')
      : this.shutdown(child);

    let operation!: Promise<ManagedHostReplacementResult>;
    operation = shutdown.then(
      result => {
        if (result !== 'exited') {
          this.phase = 'idle';
          return 'blocked' as const;
        }
        this.phase = 'armed';
        try {
          if (startReplacement()) return 'started' as const;
        } catch {}
        this.phase = 'idle';
        return 'failed' as const;
      },
      () => {
        this.phase = 'idle';
        return 'blocked' as const;
      },
    ).finally(() => {
      if (this.pending === operation) this.pending = null;
    });
    this.pending = operation;
    return operation;
  }
}

/** Electron-independent before-quit state machine. */
export class ManagedHostQuitGate {
  private released = false;
  private pending: Promise<void> | null = null;

  constructor(
    private readonly shutdown: (
      child: ChildProcess,
    ) => Promise<ManagedHostShutdownResult> = stopManagedHostGracefully,
  ) {}

  isDraining(): boolean {
    return this.pending !== null;
  }

  /** Returns true when the current before-quit event must be prevented. */
  intercept(
    child: ChildProcess | null,
    callbacks: ManagedHostQuitGateCallbacks,
  ): boolean {
    if (
      this.released
      || !child
      || child.exitCode !== null
      || child.signalCode !== null
    ) {
      return false;
    }
    if (this.pending) return true;

    const safelyNotify = (callback: () => void) => {
      // Electron callbacks can throw while the app is already tearing down.
      // Their failure must not reverse a successfully released gate or invoke
      // the opposite callback a second time.
      try { callback(); } catch {}
    };
    const operation = this.shutdown(child).then(
      result => {
        if (result === 'exited') {
          this.released = true;
          safelyNotify(callbacks.onReleased);
          return;
        }
        safelyNotify(callbacks.onBlocked);
      },
      () => { safelyNotify(callbacks.onBlocked); },
    ).finally(() => {
      if (this.pending === operation) this.pending = null;
    });
    this.pending = operation;
    return true;
  }
}
