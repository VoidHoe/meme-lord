const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('memedrop', {
  // Renderer → Main
  getSettings:      ()           => ipcRenderer.invoke('get-settings'),
  saveSettings:     (settings)   => ipcRenderer.invoke('save-settings', settings),
  openSettings:     ()           => ipcRenderer.send('open-settings'),
  checkForUpdates:  ()    => ipcRenderer.invoke('check-for-updates'),

  // Main → Renderer (drops)
  onDrop:           (cb) => ipcRenderer.on('drop',             (_e, data)     => cb(data)),
  onSettingsChanged:(cb) => ipcRenderer.on('settings-changed', (_e, settings) => cb(settings)),
  onUpdateStatus:   (cb) => ipcRenderer.on('update-status',   (_e, msg)      => cb(msg)),
});
