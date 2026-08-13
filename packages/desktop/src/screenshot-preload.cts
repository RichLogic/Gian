const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld(
  'gianScreenshotOverlay',
  Object.freeze({
    getCapture: () => ipcRenderer.invoke('desktop:screenshot-overlay:get-capture'),
    claim: (captureId: string) =>
      ipcRenderer.invoke('desktop:screenshot-overlay:claim', captureId),
    cancel: () => ipcRenderer.invoke('desktop:screenshot-overlay:cancel'),
    complete: (captureId: string, bytes: Uint8Array) => {
      if (typeof captureId !== 'string' || !(bytes instanceof Uint8Array)) {
        return Promise.resolve(false);
      }
      return ipcRenderer.invoke('desktop:screenshot-overlay:complete', captureId, bytes);
    },
  }),
);
