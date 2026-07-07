const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  petted: () => ipcRenderer.send('pet-petted'),
  onState: (cb) => ipcRenderer.on('pet-state', (_e, data) => cb(data)),
  onSetSkin: (cb) => ipcRenderer.on('set-skin', (_e, name) => cb(name)),
  onSay: (cb) => ipcRenderer.on('pet-say', (_e, text) => cb(text)),
  onCheer: (cb) => ipcRenderer.on('pet-cheer', () => cb()),
  onPop: (cb) => ipcRenderer.on('pet-pop', () => cb()),
  onNap: (cb) => ipcRenderer.on('pet-nap', (_e, on) => cb(on)),
  onTrick: (cb) => ipcRenderer.on('pet-trick', (_e, t) => cb(t)),
  onWeather: (cb) => ipcRenderer.on('pet-weather', (_e, b) => cb(b)),
  getAlarms: () => ipcRenderer.invoke('alarms-get'),
  setAlarms: (list) => ipcRenderer.send('alarms-set', list),
  closeAlarmWin: () => ipcRenderer.send('alarm-close-window'),
  getProfile: () => ipcRenderer.invoke('profile-get'),
  setProfile: (p) => ipcRenderer.send('profile-set', p),
  closeSettings: () => ipcRenderer.send('settings-close'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (pos) => ipcRenderer.send('drag-move', pos),
  dragEnd: () => ipcRenderer.send('drag-end'),
  hover: (on) => ipcRenderer.send('pet-hover', !!on),
});
