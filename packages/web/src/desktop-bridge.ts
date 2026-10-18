import type {
  GianBrowserApi,
  GianResourcePickerApi,
  GianScreenshotApi,
  GitHubDesktopAuthApi,
} from '@gian/shared';

export interface GianDesktopNotificationPreferences {
  /** Device-level only: OS consent and sound. User-level master/kind
   *  switches live in the Host config (`notifications` settings section)
   *  and gate the attention signal before it reaches any device. */
  desktop: boolean;
  sound: boolean;
}

export interface GianDesktopNotificationState {
  supported: boolean;
  preferences: GianDesktopNotificationPreferences;
  lastError: 'delivery_failed' | 'withdraw_failed' | null;
  /** Persistent registry write failure (0.6.7): delivered-notification ids
   *  could not be persisted; exact withdrawal may degrade until it heals. */
  registryError: 'persist_failed' | null;
}

export type GianDesktopNavigationTarget =
  | {
      type: 'session';
      sessionId: string;
      turn: number;
      kind: 'turn-completed' | 'approval' | 'question' | 'error';
      /** Canonical Inbox occurrence behind the notification (0.6.7 attention
       *  contract). Carried through untouched — the ack path compares the
       *  exact object, and main reads precisely this generation itself. */
      inboxRef?: { id: string; generation: number };
    }
  | {
      type: 'schedule';
      scheduleId: string;
      runId: string;
    }
  /** A newly opened schedule confirmation (0.6.7): no turn — the exact
   *  confirmation id + control session + Inbox ref. The ack path compares
   *  the full object; Main reads precisely this generation itself. */
  | {
      type: 'schedule_confirmation';
      confirmationId: string;
      controlSessionId: string;
      sessionName?: string;
      inboxRef: { id: string; generation: number };
    }
  | { type: 'settings'; section: 'updates' };

export interface GianDesktopUpdateState {
  status: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error';
  trigger: 'manual' | 'automatic' | null;
  update: {
    version: string;
    releaseName: string | null;
    releaseDate: string | null;
  } | null;
  progress: {
    percent: number;
    transferred: number;
    total: number;
    bytesPerSecond: number;
  } | null;
  error: string | null;
}

export interface GianDesktopNavigationApi {
  ready: () => Promise<GianDesktopNavigationTarget | null>;
  acknowledge: (target: GianDesktopNavigationTarget) => Promise<boolean>;
  onTarget: (listener: (target: GianDesktopNavigationTarget) => void) => () => void;
}

export interface GianDesktopNotificationsApi {
  native: boolean;
  getState: () => Promise<GianDesktopNotificationState>;
  updatePreferences: (preferences: GianDesktopNotificationPreferences) => Promise<GianDesktopNotificationState>;
  /** `locale` is the UI-selected language (0.6.7): main localizes the
   *  semantic attention event with it instead of the OS locale. Additive —
   *  older main processes ignore the field. */
  setContext: (context: { visibleSessionId: string | null; locale?: string }) => Promise<boolean>;
  openSystemSettings: () => Promise<boolean>;
  onStateChanged: (listener: (state: GianDesktopNotificationState) => void) => () => void;
}

export interface GianDesktopUpdaterApi {
  getState: () => Promise<GianDesktopUpdateState>;
  check: () => Promise<{ trigger: 'manual'; state: GianDesktopUpdateState }>;
  install: () => Promise<boolean>;
  onStateChanged: (listener: (state: GianDesktopUpdateState) => void) => () => void;
}

export interface GianDesktopZoomApi {
  get: () => Promise<number | null>;
  set: (percent: number) => Promise<number | null>;
  onChanged: (listener: (percent: number) => void) => () => void;
}

export interface GianDesktopBridge {
  appVariant?: 'production' | 'development';
  appVersion?: string;
  platform?: string;
  retryConnection?: () => Promise<boolean>;
  openLogs?: () => Promise<string>;
  restartApp?: () => Promise<boolean>;
  setDockIcon?: (dataUrl: string) => Promise<boolean>;
  setFrameVibrancy?: (theme: 'light' | 'warm' | 'dark', system: boolean) => Promise<boolean>;
  navigation?: GianDesktopNavigationApi;
  notifications?: GianDesktopNotificationsApi;
  updater?: GianDesktopUpdaterApi;
  browser?: GianBrowserApi;
  screenshot?: GianScreenshotApi;
  resources?: GianResourcePickerApi;
  zoom?: GianDesktopZoomApi;
  githubAuth?: GitHubDesktopAuthApi;
}

declare global {
  interface Window {
    gianDesktop?: GianDesktopBridge;
  }
}

export function desktopBridge(): GianDesktopBridge | undefined {
  return window.gianDesktop;
}
