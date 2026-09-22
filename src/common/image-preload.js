const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('imgAPI', {
  copyText:  function(text)   { ipcRenderer.send('clipboard-write', text); },
  setPinned: function(pinned) { ipcRenderer.send('image-win-pinned', !!pinned); },
});
