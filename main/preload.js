'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('native', {
  openDialog: () => ipcRenderer.invoke('dialog:open'),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  scanFolder: (dir) => ipcRenderer.invoke('folder:scan', dir),
  // File.path was removed from Electron; this is the supported replacement
  pathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  readFiles: (paths) => ipcRenderer.invoke('file:read', paths),
  saveAs: (defaultName, filters, bytes) => ipcRenderer.invoke('dialog:save', { defaultName, filters, bytes }),
  chooseFolder: () => ipcRenderer.invoke('dialog:folder'),
  writeInto: (dir, name, bytes) => ipcRenderer.invoke('file:write', { dir, name, bytes }),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  readAsset: (rel) => ipcRenderer.invoke('asset:read', rel),
  storeGet: () => ipcRenderer.invoke('store:get'),
  storeSet: (obj) => ipcRenderer.invoke('store:set', obj),
  previewGet: (path, want) => ipcRenderer.invoke('preview:get', { path, want }),
  thumbGet: (path) => ipcRenderer.invoke('thumb:get', path),
  thumbPut: (path, bytes) => ipcRenderer.invoke('thumb:put', { path, bytes }),
  editsGet: (paths) => ipcRenderer.invoke('edits:get', paths),
  editsSet: (path, record) => ipcRenderer.invoke('edits:set', { path, record }),
  editsFlushSync: (list) => ipcRenderer.sendSync('edits:flushSync', list),
  info: () => ipcRenderer.invoke('app:info'),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, cmd) => cb(cmd)),
  onOpenFiles: (cb) => ipcRenderer.on('open-files', (_e, files) => cb(files)),
  onOpenFolder: (cb) => ipcRenderer.on('open-folder', (_e, dir) => cb(dir))
});