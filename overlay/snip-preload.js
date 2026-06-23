const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('snip', {
  onInit:     (cb)   => ipcRenderer.on('snip-init', (_e, data) => cb(data)),
  sendRegion: (bytes) => ipcRenderer.send('snip-region', bytes),
  cancel:     ()     => ipcRenderer.send('snip-cancel'),
});
