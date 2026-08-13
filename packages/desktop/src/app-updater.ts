import type {
  AppUpdater as ElectronUpdater6,
  ProgressInfo,
  UpdateCheckResult as ElectronUpdateCheckResult,
  UpdateDownloadedEvent,
  UpdateInfo,
} from 'electron-updater';

export const DEFAULT_UPDATE_STARTUP_DELAY_MS = 15_000;
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;

export type AppUpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error';

export type AppUpdateTrigger = 'manual' | 'automatic';

export interface AppUpdateInfo {
  readonly version: string;
  readonly releaseName: string | null;
  readonly releaseDate: string | null;
}

export interface AppUpdateProgress {
  readonly percent: number;
  readonly transferred: number;
  readonly total: number;
  readonly bytesPerSecond: number;
}

export interface AppUpdateState {
  readonly status: AppUpdateStatus;
  /** The check that produced this state. Null before the first enabled check. */
  readonly trigger: AppUpdateTrigger | null;
  readonly update: AppUpdateInfo | null;
  readonly progress: AppUpdateProgress | null;
  /** A display-safe summary. Raw updater errors are never exposed here. */
  readonly error: string | null;
}

export interface AppUpdateCheckOutcome {
  /** The trigger requested by this caller, even when it joined another check. */
  readonly trigger: AppUpdateTrigger;
  readonly state: AppUpdateState;
}

interface ElectronUpdaterEvents {
  readonly 'checking-for-update': () => void;
  readonly 'update-available': (info: UpdateInfo) => void;
  readonly 'update-not-available': (info: UpdateInfo) => void;
  readonly 'download-progress': (progress: ProgressInfo) => void;
  readonly 'update-downloaded': (event: UpdateDownloadedEvent) => void;
  readonly error: (error: Error, message?: string) => void;
}

/**
 * The electron-updater 6.x surface used by Gian. Keeping this boundary small
 * makes the controller testable without loading Electron or touching a feed.
 */
export interface ElectronUpdaterAdapter {
  autoDownload: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<ElectronUpdateCheckResult | null>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on<Event extends keyof ElectronUpdaterEvents>(
    event: Event,
    listener: ElectronUpdaterEvents[Event],
  ): unknown;
}

type AssertElectronUpdaterAdapter<Value extends ElectronUpdaterAdapter> = Value;
/** Compile-time proof that electron-updater 6.x satisfies the injected seam. */
export type ElectronUpdater6Adapter = AssertElectronUpdaterAdapter<ElectronUpdater6>;

export interface AppUpdaterScheduler {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface AppUpdateLogger {
  warn(message: string): void;
}

export interface AppUpdateControllerOptions {
  updater: ElectronUpdaterAdapter;
  isPackaged: boolean;
  signedRelease: boolean;
  platform: NodeJS.Platform;
  variant: 'production' | 'development';
  /** An explicit product or test override. Disabled is fail-closed. */
  disabled?: boolean;
  startupDelayMs?: number;
  checkIntervalMs?: number;
  scheduler?: AppUpdaterScheduler;
  logger?: AppUpdateLogger;
}

export interface AppUpdateRuntime {
  isPackaged: boolean;
  signedRelease: boolean;
  platform: NodeJS.Platform;
  variant: 'production' | 'development';
  disabled?: boolean;
}

export type AppUpdateStateListener = (state: AppUpdateState) => void;

const defaultScheduler: AppUpdaterScheduler = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
};

const noOpLogger: AppUpdateLogger = {
  warn: () => undefined,
};

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function immutableState(state: AppUpdateState): AppUpdateState {
  return Object.freeze({
    ...state,
    update: state.update ? Object.freeze({ ...state.update }) : null,
    progress: state.progress ? Object.freeze({ ...state.progress }) : null,
  });
}

function updateInfo(info: UpdateInfo): AppUpdateInfo {
  return {
    version: info.version,
    releaseName: info.releaseName?.trim() || null,
    releaseDate: info.releaseDate?.trim() || null,
  };
}

function updateProgress(progress: ProgressInfo): AppUpdateProgress {
  return {
    percent: Math.min(100, finiteNonNegative(progress.percent)),
    transferred: finiteNonNegative(progress.transferred),
    total: finiteNonNegative(progress.total),
    bytesPerSecond: finiteNonNegative(progress.bytesPerSecond),
  };
}

function safeUrl(raw: string): string {
  try {
    const value = new URL(raw);
    value.username = '';
    value.password = '';
    value.search = '';
    value.hash = '';
    return value.toString();
  } catch {
    return '[redacted-url]';
  }
}

/**
 * Error text may contain signed feed URLs, authorization headers, or local
 * temporary paths. Only this bounded, redacted form may cross into app state.
 */
export function sanitizeUpdateError(error: unknown): string {
  const fallback = 'The update could not be completed.';
  const raw = error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : fallback;

  const sanitized = raw
    .replace(/\bhttps?:\/\/[^\s"'<>]+/giu, safeUrl)
    .replace(
      /(\b(?:authorization|proxy-authorization|access[_-]?token|token|api[_-]?key|password)\b\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/giu,
      '$1[redacted]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
    .replace(
      /\b(?:github_pat_[A-Za-z0-9_]{12,}|gh[pousr]_[A-Za-z0-9_]{12,})\b/gu,
      '[redacted]',
    )
    .replace(
      /(?:\/Users\/|\/home\/|\/private\/var\/folders\/|[A-Za-z]:\\Users\\)[^\s"'<>]+/gu,
      '[redacted-path]',
    )
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 500);

  return sanitized || fallback;
}

export function shouldEnableAppUpdates(runtime: AppUpdateRuntime): boolean {
  return runtime.isPackaged
    && runtime.signedRelease
    && runtime.platform === 'darwin'
    && runtime.variant === 'production'
    && runtime.disabled !== true;
}

export class AppUpdateController {
  private readonly updater: ElectronUpdaterAdapter;
  private readonly enabled: boolean;
  private readonly startupDelayMs: number;
  private readonly checkIntervalMs: number;
  private readonly scheduler: AppUpdaterScheduler;
  private readonly logger: AppUpdateLogger;
  private readonly listeners = new Set<AppUpdateStateListener>();
  private state: AppUpdateState;
  private started = false;
  private startupTimer: unknown = null;
  private intervalTimer: unknown = null;
  private activeCheck: Promise<AppUpdateState> | null = null;
  private activeTrigger: AppUpdateTrigger | null = null;

  constructor(options: AppUpdateControllerOptions) {
    this.updater = options.updater;
    this.enabled = shouldEnableAppUpdates(options);
    this.startupDelayMs = options.startupDelayMs
      ?? DEFAULT_UPDATE_STARTUP_DELAY_MS;
    this.checkIntervalMs = options.checkIntervalMs
      ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.logger = options.logger ?? noOpLogger;

    if (!Number.isFinite(this.startupDelayMs) || this.startupDelayMs < 0) {
      throw new RangeError('startupDelayMs must be a finite non-negative number');
    }
    if (!Number.isFinite(this.checkIntervalMs) || this.checkIntervalMs <= 0) {
      throw new RangeError('checkIntervalMs must be a finite positive number');
    }

    this.state = immutableState({
      status: this.enabled ? 'idle' : 'disabled',
      trigger: null,
      update: null,
      progress: null,
      error: null,
    });

    if (!this.enabled) return;

    this.updater.autoDownload = true;
    this.updater.allowPrerelease = false;
    this.updater.allowDowngrade = false;
    // A native updater can stage installation before Electron emits
    // before-quit. Keep this off so every replacement is armed only after the
    // main process has observed the managed Host exit.
    this.updater.autoInstallOnAppQuit = false;
    this.bindUpdaterEvents();
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getState(): AppUpdateState {
    return this.state;
  }

  /** Subscriptions receive the current immutable snapshot immediately. */
  subscribe(listener: AppUpdateStateListener): () => void {
    this.listeners.add(listener);
    this.notifyListener(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Starts the delayed automatic check and its recurring schedule. Repeated
   * calls are idempotent. Manual checks do not require start().
   */
  start(): boolean {
    if (!this.enabled || this.started) return false;
    this.started = true;
    this.startupTimer = this.scheduler.setTimeout(() => {
      this.startupTimer = null;
      if (!this.started) return;
      this.runScheduledCheck();
      if (!this.started) return;
      this.intervalTimer = this.scheduler.setInterval(() => {
        if (this.started) this.runScheduledCheck();
      }, this.checkIntervalMs);
    }, this.startupDelayMs);
    return true;
  }

  /** Stops both timers. An already-running updater operation is left intact. */
  stop(): void {
    this.started = false;
    if (this.startupTimer !== null) {
      this.scheduler.clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    if (this.intervalTimer !== null) {
      this.scheduler.clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
  }

  /**
   * Returns a structured result instead of displaying UI. Main may display a
   * manual result; scheduled automatic failures remain state-only and silent.
   */
  async checkForUpdates(
    trigger: AppUpdateTrigger = 'manual',
  ): Promise<AppUpdateCheckOutcome> {
    if (!this.enabled) return { trigger, state: this.state };

    // Once a release is downloading or ready, another feed request is neither
    // useful nor safe. Each caller still receives its own trigger in the result.
    if (
      this.state.status === 'available'
      || this.state.status === 'downloading'
      || this.state.status === 'downloaded'
    ) {
      return { trigger, state: this.state };
    }

    const operation = this.activeCheck ?? this.beginCheck(trigger);
    return { trigger, state: await operation };
  }

  /** Installs only after electron-updater has confirmed a complete download. */
  install(): boolean {
    if (!this.enabled || this.state.status !== 'downloaded') return false;
    try {
      this.updater.quitAndInstall(false, true);
      return true;
    } catch (error) {
      this.transition({
        status: 'error',
        trigger: 'manual',
        update: this.state.update,
        progress: this.state.progress,
        error: sanitizeUpdateError(error),
      });
      return false;
    }
  }

  private bindUpdaterEvents(): void {
    this.updater.on('checking-for-update', () => {
      if (this.state.status !== 'checking') {
        this.transition(this.checkingState());
      }
    });
    this.updater.on('update-available', info => {
      this.markAvailable(info);
    });
    this.updater.on('update-not-available', info => {
      if (this.state.status === 'downloaded') return;
      this.transition({
        status: 'up-to-date',
        trigger: this.eventTrigger(),
        update: updateInfo(info),
        progress: null,
        error: null,
      });
    });
    this.updater.on('download-progress', progress => {
      if (this.state.status === 'downloaded') return;
      this.transition({
        status: 'downloading',
        trigger: this.eventTrigger(),
        update: this.state.update,
        progress: updateProgress(progress),
        error: null,
      });
    });
    this.updater.on('update-downloaded', event => {
      this.transition({
        status: 'downloaded',
        trigger: this.eventTrigger(),
        update: updateInfo(event),
        progress: this.state.progress,
        error: null,
      });
    });
    this.updater.on('error', error => {
      this.markError(error);
    });
  }

  private beginCheck(trigger: AppUpdateTrigger): Promise<AppUpdateState> {
    this.activeTrigger = trigger;
    let resolveOperation: ((state: AppUpdateState) => void) | undefined;
    const operation = new Promise<AppUpdateState>(resolve => {
      resolveOperation = resolve;
    });
    // Publish the flight before performCheck emits its synchronous "checking"
    // state. A state subscriber may itself request a check and must join this
    // operation rather than start a re-entrant feed request.
    this.activeCheck = operation;
    void this.performCheck(trigger).then(state => resolveOperation?.(state));
    void operation.finally(() => {
      if (this.activeCheck !== operation) return;
      this.activeCheck = null;
      if (
        this.state.status !== 'available'
        && this.state.status !== 'downloading'
      ) {
        this.activeTrigger = null;
      }
    });
    return operation;
  }

  private async performCheck(trigger: AppUpdateTrigger): Promise<AppUpdateState> {
    this.transition({
      status: 'checking',
      trigger,
      update: null,
      progress: null,
      error: null,
    });

    try {
      const result = await this.updater.checkForUpdates();
      this.applyCheckResult(result);
    } catch (error) {
      // electron-updater normally emits "error" and rejects. The catch also
      // covers adapters that only reject, without exposing the raw exception.
      if (this.state.status !== 'error') this.markError(error);
    }
    return this.state;
  }

  private applyCheckResult(result: ElectronUpdateCheckResult | null): void {
    if (this.state.status !== 'checking') return;
    if (result === null) {
      this.markError('The update service is unavailable.');
      return;
    }
    if (result.isUpdateAvailable) {
      this.markAvailable(result.updateInfo);
      return;
    }
    this.transition({
      status: 'up-to-date',
      trigger: this.eventTrigger(),
      update: updateInfo(result.updateInfo),
      progress: null,
      error: null,
    });
  }

  private markAvailable(info: UpdateInfo): void {
    if (this.state.status === 'downloaded') return;
    const trigger = this.eventTrigger();
    const update = updateInfo(info);
    this.transition({
      status: 'available',
      trigger,
      update,
      progress: null,
      error: null,
    });
    // autoDownload is always true. There is no download-start event in the
    // electron-updater 6.x contract, so make that transition explicit.
    this.transition({
      status: 'downloading',
      trigger,
      update,
      progress: null,
      error: null,
    });
  }

  private markError(error: unknown): void {
    const safeError = sanitizeUpdateError(error);
    this.logger.warn(`[desktop-updater] ${safeError}`);
    this.transition({
      status: 'error',
      trigger: this.eventTrigger(),
      update: this.state.update,
      progress: this.state.progress,
      error: safeError,
    });
  }

  private checkingState(): AppUpdateState {
    return {
      status: 'checking',
      trigger: this.eventTrigger(),
      update: null,
      progress: null,
      error: null,
    };
  }

  private eventTrigger(): AppUpdateTrigger {
    return this.activeTrigger ?? this.state.trigger ?? 'automatic';
  }

  private runScheduledCheck(): void {
    // checkForUpdates catches updater failures, so this cannot create an
    // unhandled rejection or an automatic modal/error surface.
    void this.checkForUpdates('automatic');
  }

  private transition(next: AppUpdateState): void {
    this.state = immutableState(next);
    for (const listener of this.listeners) this.notifyListener(listener);
  }

  private notifyListener(listener: AppUpdateStateListener): void {
    try {
      listener(this.state);
    } catch (error) {
      this.logger.warn(
        `[desktop-updater] state listener failed: ${sanitizeUpdateError(error)}`,
      );
    }
  }
}
