const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sender', {
  sendDrop:    (payload)              => ipcRenderer.invoke('send-drop', payload),
  uploadAudio: (audioBuffer)          => ipcRenderer.invoke('upload-audio', audioBuffer),
  uploadMedia: (buffer, mimeType)     => ipcRenderer.invoke('upload-media', { buffer, mimeType }),
  getUsers:    ()                     => ipcRenderer.invoke('get-users'),
  close:       ()                     => ipcRenderer.send('close-sender'),
});
