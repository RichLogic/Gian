const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
import type { GianBrowserBounds, GianBrowserProjectTarget, GianBrowserState } from '@gian/shared';

const appVariant = process.argv.includes('--gian-desktop-variant=development')
  ? 'development'
  : 'production';

contextBridge.exposeInMainWorld(
  'gianDesktop',
  Object.freeze({
    appVariant,
    retryConnection: () => ipcRenderer.invoke('desktop:retry-connection'),
    openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
    restartApp: () => ipcRenderer.invoke('desktop:restart-app'),
    setDockIcon: (dataUrl: string) => ipcRenderer.invoke('desktop:set-dock-icon', dataUrl),
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
      subscribe: (listener: (tabId: string, state: GianBrowserState) => void) => {
        const wrapped = (_event: Electron.IpcRendererEvent, tabId: string, state: GianBrowserState) =>
          listener(tabId, state);
        ipcRenderer.on('desktop:browser:state', wrapped);
        return () => ipcRenderer.removeListener('desktop:browser:state', wrapped);
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
