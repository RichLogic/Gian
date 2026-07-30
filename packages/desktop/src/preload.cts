const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld(
  'gianDesktop',
  Object.freeze({
    retryConnection: () => ipcRenderer.invoke('desktop:retry-connection'),
    openLogs: () => ipcRenderer.invoke('desktop:open-logs'),
    setDockIcon: (dataUrl: string) => ipcRenderer.invoke('desktop:set-dock-icon', dataUrl),
  }),
);
