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
  lastError: 'delivery_failed' | null;
}

export type GianDesktopNavigationTarget =
  | {
      type: 'session';
      sessionId: string;
      turn: number;
      kind: 'turn-completed' | 'approval' | 'question' | 'error';
    }
  | {
      type: 'schedule';
      scheduleId: string;
      runId: string;
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
  setContext: (context: { visibleSessionId: string | null }) => Promise<boolean>;
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
  retryConnection?: () => Promise<boolean>;
  openLogs?: () => Promise<string>;
  restartApp?: () => Promise<boolean>;
  setDockIcon?: (dataUrl: string) => Promise<boolean>;
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
