const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlayAPI', {
  reload:              () => ipcRenderer.send('overlay-reload'),
  clearCacheAndReload: () => ipcRenderer.send('overlay-clear-cache-reload'),
});
