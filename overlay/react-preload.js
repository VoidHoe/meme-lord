const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('react', {
  // Main → Renderer
  onInit: (cb) => ipcRenderer.on('react-init', (_e, d) => cb(d)),   // d = { lastDropper }

  // Renderer → Main
  pick:   (emoji) => ipcRenderer.send('react-pick', { emoji }),
  cancel: ()      => ipcRenderer.send('react-cancel'),
});
