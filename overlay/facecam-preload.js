const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('facecam', {
  frame: (image) => ipcRenderer.send('facecam-frame', image),
  status: (status) => ipcRenderer.send('facecam-status', status),
  onStart: (cb) => ipcRenderer.on('facecam-capture-start', (_e, data) => cb(data)),
  onStop: (cb) => ipcRenderer.on('facecam-capture-stop', () => cb()),
});
