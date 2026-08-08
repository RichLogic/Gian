import type { GianBrowserApi, GitHubDesktopAuthApi } from '@gian/shared';

export interface GianDesktopZoomApi {
  get: () => Promise<number | null>;
  set: (percent: number) => Promise<number | null>;
  onChanged: (listener: (percent: number) => void) => () => void;
}

export interface GianDesktopBridge {
  appVariant?: 'production' | 'development';
  retryConnection?: () => Promise<boolean>;
  openLogs?: () => Promise<string>;
  restartApp?: () => Promise<boolean>;
  setDockIcon?: (dataUrl: string) => Promise<boolean>;
  browser?: GianBrowserApi;
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
