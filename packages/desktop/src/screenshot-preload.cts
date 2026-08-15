const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld(
  'gianScreenshotOverlay',
  Object.freeze({
    getCapture: () => ipcRenderer.invoke('desktop:screenshot-overlay:get-capture'),
    claim: (captureId: string) =>
      ipcRenderer.invoke('desktop:screenshot-overlay:claim', captureId),
    cancel: () => ipcRenderer.invoke('desktop:screenshot-overlay:cancel'),
    /** The frozen desktop has been decoded and drawn; the window can be shown
     * without a black flash. */
    painted: () => ipcRenderer.send('desktop:screenshot-overlay:painted'),
    /** A new capture is ready; re-fetch and redraw without reloading the page. */
    onRefresh: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on('desktop:screenshot-overlay:refresh', handler);
      return () => ipcRenderer.removeListener('desktop:screenshot-overlay:refresh', handler);
    },
    complete: (captureId: string, bytes: Uint8Array) => {
      if (typeof captureId !== 'string' || !(bytes instanceof Uint8Array)) {
        return Promise.resolve(false);
      }
      return ipcRenderer.invoke('desktop:screenshot-overlay:complete', captureId, bytes);
    },
  }),
);
