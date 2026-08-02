import type { GitHubDesktopAuthApi } from '@gian/shared';

export interface GianDesktopBridge {
  appVariant?: 'production' | 'development';
  retryConnection?: () => Promise<boolean>;
  openLogs?: () => Promise<string>;
  setDockIcon?: (dataUrl: string) => Promise<boolean>;
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
