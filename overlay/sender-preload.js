const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sender', {
  getSettings:    ()                 => ipcRenderer.invoke('get-settings'),
  saveSettings:   (settings)         => ipcRenderer.invoke('save-settings', settings),
  sendDrop:       (payload)          => ipcRenderer.invoke('send-drop', payload),
  uploadAudio:    (buf)              => ipcRenderer.invoke('upload-audio', buf),
  uploadMedia:    (buf, mime)        => ipcRenderer.invoke('upload-media', { buffer: buf, mimeType: mime }),
  getUsers:       ()                 => ipcRenderer.invoke('get-users'),
  searchGifs:     (query)            => ipcRenderer.invoke('search-gifs', query),
  getFavorites:   ()                 => ipcRenderer.invoke('get-favorites'),
  saveFavorite:   (fav)              => ipcRenderer.invoke('save-favorite', fav),
  deleteFavorite: (id)               => ipcRenderer.invoke('delete-favorite', id),
  getHistory:     ()                 => ipcRenderer.invoke('get-history'),
  clearHistory:   ()                 => ipcRenderer.invoke('clear-history'),
  close:          ()                 => ipcRenderer.send('close-sender'),
});
