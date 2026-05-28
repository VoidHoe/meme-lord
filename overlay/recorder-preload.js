const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorder', {
  onStart:      (cb) => ipcRenderer.on('start-recording',   (_e, deviceId) => cb(deviceId)),
  onStop:       (cb) => ipcRenderer.on('stop-recording',    () => cb()),
  onEnumerate:  (cb) => ipcRenderer.on('enumerate-devices', () => cb()),
  sendData:     (buf)     => ipcRenderer.send('recording-data',  buf),
  sendError:    (msg)     => ipcRenderer.send('recording-error', msg),
  sendDevices:  (devices) => ipcRenderer.send('audio-devices',   devices),
});
