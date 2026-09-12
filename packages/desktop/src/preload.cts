const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
import type {
  GianBrowserBounds,
  GianBrowserCreateTabInput,
  GianBrowserElementCapture,
  GianBrowserFindOptions,
  GianBrowserFindResult,
  GianBrowserDownloadsSnapshot,
  GianBrowserExtension,
  GianBrowserExtensionsSnapshot,
  GianBrowserPreferences,
  GianBrowserPermissionDecision,
  GianBrowserPermissionsSnapshot,
  GianBrowserProjectTarget,
  GianBrowserState,
  GianBrowserTabsSnapshot,
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
      createTab: (input?: GianBrowserCreateTabInput) =>
        ipcRenderer.invoke('desktop:browser:create-tab', input),
      listTabs: () => ipcRenderer.invoke('desktop:browser:list-tabs'),
      listDownloads: () => ipcRenderer.invoke('desktop:browser:list-downloads'),
      cancelDownload: (downloadId: string) =>
        ipcRenderer.invoke('desktop:browser:cancel-download', downloadId),
      revealDownload: (downloadId: string) =>
        ipcRenderer.invoke('desktop:browser:reveal-download', downloadId),
      listPermissionRequests: () =>
        ipcRenderer.invoke('desktop:browser:list-permission-requests'),
      respondPermission: (requestId: string, decision: GianBrowserPermissionDecision) =>
        ipcRenderer.invoke('desktop:browser:respond-permission', requestId, decision),
      listExtensions: () => ipcRenderer.invoke('desktop:browser:list-extensions'),
      installExtension: (): Promise<GianBrowserExtension | null> =>
        ipcRenderer.invoke('desktop:browser:install-extension'),
      setExtensionEnabled: (extensionKey: string, enabled: boolean) =>
        ipcRenderer.invoke('desktop:browser:set-extension-enabled', extensionKey, enabled),
      removeExtension: (extensionKey: string) =>
        ipcRenderer.invoke('desktop:browser:remove-extension', extensionKey),
      configure: (preferences: GianBrowserPreferences) =>
        ipcRenderer.invoke('desktop:browser:configure', preferences),
      getState: (tabId: string) => ipcRenderer.invoke('desktop:browser:get-state', tabId),
      navigate: (tabId: string, url: string) => ipcRenderer.invoke('desktop:browser:navigate', tabId, url),
      openProject: (tabId: string, target: GianBrowserProjectTarget) =>
        ipcRenderer.invoke('desktop:browser:open-project', tabId, target),
      goBack: (tabId: string) => ipcRenderer.invoke('desktop:browser:back', tabId),
      goForward: (tabId: string) => ipcRenderer.invoke('desktop:browser:forward', tabId),
      reload: (tabId: string) => ipcRenderer.invoke('desktop:browser:reload', tabId),
      recover: (tabId: string) => ipcRenderer.invoke('desktop:browser:recover', tabId),
      stop: (tabId: string) => ipcRenderer.invoke('desktop:browser:stop', tabId),
      findInPage: (tabId: string, text: string, options?: GianBrowserFindOptions) =>
        ipcRenderer.send('desktop:browser:find', tabId, text, options),
      stopFindInPage: (tabId: string) => ipcRenderer.invoke('desktop:browser:stop-find', tabId),
      openDevTools: (tabId: string) => ipcRenderer.invoke('desktop:browser:open-devtools', tabId),
      setLayout: (tabId: string, bounds: GianBrowserBounds, visible: boolean) =>
        ipcRenderer.invoke('desktop:browser:set-layout', tabId, bounds, visible),
      setBackground: (tabId: string, cssColor: string) =>
        ipcRenderer.invoke('desktop:browser:set-background', tabId, cssColor),
      setZoom: (tabId: string, factor: number) =>
        ipcRenderer.invoke('desktop:browser:set-zoom', tabId, factor),
      openExternal: (tabId: string) => ipcRenderer.invoke('desktop:browser:open-external', tabId),
      closeTab: (tabId: string) => ipcRenderer.invoke('desktop:browser:close-tab', tabId),
      clearData: () => ipcRenderer.invoke('desktop:browser:clear-data'),
      setInspectMode: (tabId: string, enabled: boolean) =>
        ipcRenderer.invoke('desktop:browser:set-inspect-mode', tabId, enabled),
      subscribeTabs: (listener: (snapshot: GianBrowserTabsSnapshot) => void) => {
        const wrapped = (_event: Electron.IpcRendererEvent, snapshot: GianBrowserTabsSnapshot) =>
          listener(snapshot);
        ipcRenderer.on('desktop:browser:tabs', wrapped);
        return () => ipcRenderer.removeListener('desktop:browser:tabs', wrapped);
      },
      subscribePresentationRequested: (listener: (tabId: string) => void) => {
        const wrapped = (_event: Electron.IpcRendererEvent, tabId: string) => listener(tabId);
        ipcRenderer.on('desktop:browser:presentation-requested', wrapped);
        return () => ipcRenderer.removeListener('desktop:browser:presentation-requested', wrapped);
      },
      subscribe: (listener: (tabId: string, state: GianBrowserState) => void) => {
        const wrapped = (_event: Electron.IpcRendererEvent, tabId: string, state: GianBrowserState) =>
          listener(tabId, state);
        ipcRenderer.on('desktop:browser:state', wrapped);
        return () => ipcRenderer.removeListener('desktop:browser:state', wrapped);
      },
      subscribeFind: (listener: (tabId: string, result: GianBrowserFindResult) => void) => {
        const wrapped = (
          _event: Electron.IpcRendererEvent,
          tabId: string,
          result: GianBrowserFindResult,
        ) => listener(tabId, result);
        ipcRenderer.on('desktop:browser:find-result', wrapped);
        return () => ipcRenderer.removeListener('desktop:browser:find-result', wrapped);
      },
      subscribeFindRequested: (listener: (tabId: string) => void) => {
        const wrapped = (_event: Electron.IpcRendererEvent, tabId: string) => listener(tabId);
        ipcRenderer.on('desktop:browser:find-requested', wrapped);
        return () => ipcRenderer.removeListener('desktop:browser:find-requested', wrapped);
      },
      subscribeAddressRequested: (listener: (tabId: string) => void) => {
        const wrapped = (_event: Electron.IpcRendererEvent, tabId: string) => listener(tabId);
        ipcRenderer.on('desktop:browser:address-requested', wrapped);
        return () => ipcRenderer.removeListener('desktop:browser:address-requested', wrapped);
      },
      subscribeDownloads: (listener: (snapshot: GianBrowserDownloadsSnapshot) => void) => {
        const wrapped = (
          _event: Electron.IpcRendererEvent,
          snapshot: GianBrowserDownloadsSnapshot,
        ) => listener(snapshot);
        ipcRenderer.on('desktop:browser:downloads', wrapped);
        return () => ipcRenderer.removeListener('desktop:browser:downloads', wrapped);
      },
      subscribePermissions: (listener: (snapshot: GianBrowserPermissionsSnapshot) => void) => {
        const wrapped = (
          _event: Electron.IpcRendererEvent,
          snapshot: GianBrowserPermissionsSnapshot,
        ) => listener(snapshot);
        ipcRenderer.on('desktop:browser:permissions', wrapped);
        return () => ipcRenderer.removeListener('desktop:browser:permissions', wrapped);
      },
      subscribeExtensions: (listener: (snapshot: GianBrowserExtensionsSnapshot) => void) => {
        const wrapped = (
          _event: Electron.IpcRendererEvent,
          snapshot: GianBrowserExtensionsSnapshot,
        ) => listener(snapshot);
        ipcRenderer.on('desktop:browser:extensions', wrapped);
        return () => ipcRenderer.removeListener('desktop:browser:extensions', wrapped);
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
