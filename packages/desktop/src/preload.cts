const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

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
    githubAuth: Object.freeze({
      getState: () => ipcRenderer.invoke('desktop:github-auth:get-state'),
      start: () => ipcRenderer.invoke('desktop:github-auth:start'),
      finish: () => ipcRenderer.invoke('desktop:github-auth:finish'),
      cancel: () => ipcRenderer.invoke('desktop:github-auth:cancel'),
      signOut: () => ipcRenderer.invoke('desktop:github-auth:sign-out'),
    }),
  }),
);
