const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
import type {
  GianBrowserBounds,
  GianBrowserElementCapture,
  GianBrowserProjectTarget,
  GianBrowserState,
  PickComposerResourcesResult,
  GianScreenshotCapture,
  GianScreenshotErrorCode,
  GianScreenshotPreferences,
  GianScreenshotTarget,
} from '@gian/shared';

const appVariant = process.argv.includes('--gian-desktop-variant=development')
  ? 'development'
  : 'production';
const signedRelease = process.argv.includes('--gian-desktop-signed-release=true');
const versionArgument = process.argv.find(argument =>
  argument.startsWith('--gian-desktop-version='));
const appVersion = versionArgument?.slice('--gian-desktop-version='.length) || undefined;

contextBridge.exposeInMainWorld(
  'gianDesktop',
  Object.freeze({
    appVariant,
    appVersion,
    retryConnection: () => ipcRenderer.invoke('desktop:retry-connection'),
    openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
    restartApp: () => ipcRenderer.invoke('desktop:restart-app'),
    setDockIcon: (dataUrl: string) => ipcRenderer.invoke('desktop:set-dock-icon', dataUrl),
    resources: Object.freeze({
      pick: () => ipcRenderer.invoke('desktop:resources:pick') as Promise<PickComposerResourcesResult | null>,
    }),
    screenshot: Object.freeze({
      setTarget: (target: GianScreenshotTarget | null) =>
        ipcRenderer.invoke('desktop:screenshot:set-target', target),
      start: () => ipcRenderer.invoke('desktop:screenshot:start'),
      getState: () => ipcRenderer.invoke('desktop:screenshot:get-state'),
      getPreferences: () => ipcRenderer.invoke('desktop:screenshot:get-preferences'),
      setPreferences: (preferences: GianScreenshotPreferences) =>
        ipcRenderer.invoke('desktop:screenshot:set-preferences', preferences),
      onCaptured: (listener: (capture: GianScreenshotCapture) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, capture: GianScreenshotCapture) =>
          listener(capture);
        ipcRenderer.on('desktop:screenshot:captured', handler);
        return () => ipcRenderer.removeListener('desktop:screenshot:captured', handler);
      },
      onError: (listener: (error: GianScreenshotErrorCode) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, error: GianScreenshotErrorCode) =>
          listener(error);
        ipcRenderer.on('desktop:screenshot:error', handler);
        return () => ipcRenderer.removeListener('desktop:screenshot:error', handler);
      },
    }),
    navigation: Object.freeze({
      ready: () => ipcRenderer.invoke('desktop:navigation:ready'),
      acknowledge: (target: unknown) => ipcRenderer.invoke('desktop:navigation:ack', target),
      onTarget: (listener: (target: unknown) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, target: unknown) => listener(target);
        ipcRenderer.on('desktop:navigation', handler);
        return () => ipcRenderer.removeListener('desktop:navigation', handler);
      },
    }),
    notifications: Object.freeze({
      native: appVariant === 'production' && signedRelease,
      getState: () => ipcRenderer.invoke('desktop:notifications:get-state'),
      updatePreferences: (preferences: unknown) =>
        ipcRenderer.invoke('desktop:notifications:update-preferences', preferences),
      setContext: (context: unknown) =>
        ipcRenderer.invoke('desktop:notifications:set-context', context),
      openSystemSettings: () => ipcRenderer.invoke('desktop:notifications:open-settings'),
      onStateChanged: (listener: (state: unknown) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
        ipcRenderer.on('desktop:notifications-state', handler);
        return () => ipcRenderer.removeListener('desktop:notifications-state', handler);
      },
    }),
    updater: Object.freeze({
      getState: () => ipcRenderer.invoke('desktop:updater:get-state'),
      check: () => ipcRenderer.invoke('desktop:updater:check'),
      install: () => ipcRenderer.invoke('desktop:updater:install'),
      onStateChanged: (listener: (state: unknown) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, state: unknown) => listener(state);
        ipcRenderer.on('desktop:updater-state', handler);
        return () => ipcRenderer.removeListener('desktop:updater-state', handler);
      },
    }),
    browser: Object.freeze({
      getState: (tabId: string) => ipcRenderer.invoke('desktop:browser:get-state', tabId),
      navigate: (tabId: string, url: string) => ipcRenderer.invoke('desktop:browser:navigate', tabId, url),
      openProject: (tabId: string, target: GianBrowserProjectTarget) =>
        ipcRenderer.invoke('desktop:browser:open-project', tabId, target),
      goBack: (tabId: string) => ipcRenderer.invoke('desktop:browser:back', tabId),
      goForward: (tabId: string) => ipcRenderer.invoke('desktop:browser:forward', tabId),
      reload: (tabId: string) => ipcRenderer.invoke('desktop:browser:reload', tabId),
      stop: (tabId: string) => ipcRenderer.invoke('desktop:browser:stop', tabId),
      setLayout: (tabId: string, bounds: GianBrowserBounds, visible: boolean) =>
        ipcRenderer.invoke('desktop:browser:set-layout', tabId, bounds, visible),
      openExternal: (tabId: string) => ipcRenderer.invoke('desktop:browser:open-external', tabId),
      closeTab: (tabId: string) => ipcRenderer.invoke('desktop:browser:close-tab', tabId),
      clearData: () => ipcRenderer.invoke('desktop:browser:clear-data'),
      setInspectMode: (tabId: string, enabled: boolean) =>
        ipcRenderer.invoke('desktop:browser:set-inspect-mode', tabId, enabled),
      subscribe: (listener: (tabId: string, state: GianBrowserState) => void) => {
        const wrapped = (_event: Electron.IpcRendererEvent, tabId: string, state: GianBrowserState) =>
          listener(tabId, state);
        ipcRenderer.on('desktop:browser:state', wrapped);
        return () => ipcRenderer.removeListener('desktop:browser:state', wrapped);
      },
      subscribeElement: (listener: (tabId: string, capture: GianBrowserElementCapture) => void) => {
        const wrapped = (
          _event: Electron.IpcRendererEvent,
          tabId: string,
          capture: GianBrowserElementCapture,
        ) => listener(tabId, capture);
        ipcRenderer.on('desktop:browser:element', wrapped);
        return () => ipcRenderer.removeListener('desktop:browser:element', wrapped);
      },
    }),
    zoom: Object.freeze({
      get: () => ipcRenderer.invoke('desktop:zoom:get'),
      set: (percent: number) => ipcRenderer.invoke('desktop:zoom:set', percent),
      onChanged: (listener: (percent: number) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, percent: number) => listener(percent);
        ipcRenderer.on('desktop:zoom-changed', handler);
        return () => ipcRenderer.removeListener('desktop:zoom-changed', handler);
      },
    }),
    githubAuth: Object.freeze({
      getState: () => ipcRenderer.invoke('desktop:github-auth:get-state'),
      start: () => ipcRenderer.invoke('desktop:github-auth:start'),
      finish: () => ipcRenderer.invoke('desktop:github-auth:finish'),
      cancel: () => ipcRenderer.invoke('desktop:github-auth:cancel'),
      signOut: () => ipcRenderer.invoke('desktop:github-auth:sign-out'),
    }),
  }),
);
