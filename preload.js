const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  petted: () => ipcRenderer.send('pet-petted'),
  onState: (cb) => ipcRenderer.on('pet-state', (_e, data) => cb(data)),
  onSetSkin: (cb) => ipcRenderer.on('set-skin', (_e, name) => cb(name)),
  onSay: (cb) => ipcRenderer.on('pet-say', (_e, text) => cb(text)),
  onCheer: (cb) => ipcRenderer.on('pet-cheer', () => cb()),
  getAlarms: () => ipcRenderer.invoke('alarms-get'),
  setAlarms: (list) => ipcRenderer.send('alarms-set', list),
  closeAlarmWin: () => ipcRenderer.send('alarm-close-window'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (pos) => ipcRenderer.send('drag-move', pos),
  dragEnd: () => ipcRenderer.send('drag-end'),
  hover: (on) => ipcRenderer.send('pet-hover', !!on),
});
