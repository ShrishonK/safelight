'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('native', {
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  readFiles: (paths) => ipcRenderer.invoke('file:read', paths),
  saveAs: (defaultName, filters, bytes) => ipcRenderer.invoke('dialog:save', { defaultName, filters, bytes }),
  chooseFolder: () => ipcRenderer.invoke('dialog:folder'),
  writeInto: (dir, name, bytes) => ipcRenderer.invoke('file:write', { dir, name, bytes }),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  storeGet: () => ipcRenderer.invoke('store:get'),
  storeSet: (obj) => ipcRenderer.invoke('store:set', obj),
  info: () => ipcRenderer.invoke('app:info'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, files) => cb(files))
});
