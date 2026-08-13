'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const IS_MAC = process.platform === 'darwin';
const STORE = path.join(app.getPath('userData'), 'safelight.json');

const RAW = ['cr2', 'cr3', 'nef', 'arw', 'raf', 'rw2', 'orf', 'dng', 'pef', 'srw', 'raw', '3fr', 'iiq', 'erf', 'mrw'];
const STILL = ['jpg', 'jpeg', 'png', 'webp', 'fedr'];

let win = null;
let queued = [];          // files handed to us before the window is ready

/* ---------- tiny persistent store ---------- */
function readStore() {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch { return {}; }
}
function writeStore(obj) {
  try { fs.mkdirSync(path.dirname(STORE), { recursive: true }); fs.writeFileSync(STORE, JSON.stringify(obj, null, 2)); }
  catch (e) { console.error('store write failed', e); }
}

/* ---------- window ---------- */
function createWindow() {
  const st = readStore();
  const b = st.bounds || {};
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: b.width || 1500, height: b.height || 940,
    x: b.x, y: b.y,
    minWidth: 1040, minHeight: 660,
    backgroundColor: '#0d1116',
    show: false,
    titleBarStyle: IS_MAC ? 'hiddenInset' : 'default',
    trafficLightPosition: IS_MAC ? { x: 14, y: 13 } : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (queued.length) { send('open-files', queued); queued = []; }
  });
  win.on('close', () => {
    const s = readStore(); s.bounds = win.getNormalBounds(); writeStore(s);
  });
  win.on('closed', () => { win = null; });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}
const menuSend = (cmd) => () => send('menu', cmd);

/* ---------- menus ---------- */
function buildMenu() {
  const template = [];
  if (IS_MAC) template.push({
    label: app.name,
    submenu: [{ role: 'about' }, { type: 'separator' },
    { role: 'services' }, { type: 'separator' },
    { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
    { type: 'separator' }, { role: 'quit' }]
  });
  template.push({
    label: 'File',
    submenu: [
      { label: 'Open photos…', accelerator: 'CmdOrCtrl+O', click: menuSend('open') },
      { label: 'Close photo', accelerator: 'CmdOrCtrl+W', click: menuSend('close-photo') },
      { type: 'separator' },
      { label: 'Export photo…', accelerator: 'CmdOrCtrl+E', click: menuSend('export') },
      { label: 'Export all photos…', accelerator: 'CmdOrCtrl+Shift+E', click: menuSend('export-all') },
      { type: 'separator' },
      { label: 'Convert raw to .fedr…', click: menuSend('convert-raw') },
      { label: 'Save settings sidecar…', click: menuSend('save-sidecar') },
      { label: 'Load settings sidecar…', click: menuSend('load-sidecar') },
      { type: 'separator' },
      IS_MAC ? { role: 'close' } : { role: 'quit' }
    ]
  });
  template.push({
    label: 'Edit',
    submenu: [
      { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: menuSend('undo') },
      { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: menuSend('redo') },
      { type: 'separator' },
      { label: 'Copy settings', accelerator: 'CmdOrCtrl+Alt+C', click: menuSend('copy') },
      { label: 'Paste settings', accelerator: 'CmdOrCtrl+Alt+V', click: menuSend('paste') },
      { label: 'Reset this photo', accelerator: 'CmdOrCtrl+R', click: menuSend('reset') },
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }
    ]
  });
  template.push({
    label: 'View',
    submenu: [
      { label: 'Fit', accelerator: 'CmdOrCtrl+0', click: menuSend('fit') },
      { label: 'Actual size (1:1)', accelerator: 'CmdOrCtrl+1', click: menuSend('one') },
      { label: 'Zoom in', accelerator: 'CmdOrCtrl+Plus', click: menuSend('zoom-in') },
      { label: 'Zoom out', accelerator: 'CmdOrCtrl+-', click: menuSend('zoom-out') },
      { type: 'separator' },
      { label: 'Show original', accelerator: 'CmdOrCtrl+B', click: menuSend('before') },
      { label: 'Show mask overlay', accelerator: 'CmdOrCtrl+M', click: menuSend('overlay') },
      { type: 'separator' },
      { label: 'Next photo', accelerator: 'CmdOrCtrl+Right', click: menuSend('next') },
      { label: 'Previous photo', accelerator: 'CmdOrCtrl+Left', click: menuSend('prev') },
      { type: 'separator' },
      { role: 'togglefullscreen' }, { role: 'toggleDevTools' }, { role: 'reload' }
    ]
  });
  template.push({
    label: 'Window',
    submenu: IS_MAC ? [{ role: 'minimize' }, { role: 'zoom' }, { type: 'separator' }, { role: 'front' }]
      : [{ role: 'minimize' }, { role: 'close' }]
  });
  template.push({
    label: 'Help',
    submenu: [
      { label: 'Keyboard shortcuts', click: menuSend('help') },
      { label: 'Open the manual', click: () => shell.openExternal('https://github.com/') }
    ]
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------- IPC ---------- */
ipcMain.handle('dialog:open', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Open photos',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'All photos', extensions: [...STILL, ...RAW] },
      { name: 'Camera raw', extensions: RAW },
      { name: 'Standard images', extensions: STILL }
    ]
  });
  if (r.canceled) return [];
  return r.filePaths.map(readOne).filter(Boolean);
});

function readOne(p) {
  try { return { path: p, name: path.basename(p), bytes: fs.readFileSync(p) }; }
  catch (e) { console.error('read failed', p, e); return null; }
}
ipcMain.handle('file:read', (_e, paths) => paths.map(readOne).filter(Boolean));

ipcMain.handle('dialog:save', async (_e, { defaultName, filters, bytes }) => {
  const st = readStore();
  const r = await dialog.showSaveDialog(win, {
    title: 'Export photo',
    defaultPath: path.join(st.lastExportDir || app.getPath('pictures'), defaultName),
    filters
  });
  if (r.canceled || !r.filePath) return null;
  fs.writeFileSync(r.filePath, Buffer.from(bytes));
  st.lastExportDir = path.dirname(r.filePath); writeStore(st);
  return r.filePath;
});

ipcMain.handle('dialog:folder', async () => {
  const st = readStore();
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose an export folder', properties: ['openDirectory', 'createDirectory'],
    defaultPath: st.lastExportDir || app.getPath('pictures')
  });
  if (r.canceled || !r.filePaths[0]) return null;
  st.lastExportDir = r.filePaths[0]; writeStore(st);
  return r.filePaths[0];
});

ipcMain.handle('file:write', (_e, { dir, name, bytes }) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.from(bytes));
  return p;
});

ipcMain.handle('store:get', () => readStore());
ipcMain.handle('store:set', (_e, obj) => { writeStore(Object.assign(readStore(), obj)); return true; });
ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, electron: process.versions.electron }));
ipcMain.handle('shell:reveal', (_e, p) => { shell.showItemInFolder(p); });

/* ---------- app lifecycle ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', (_e, argv) => {
    const files = argv.slice(1).filter(a => !a.startsWith('-') && fs.existsSync(a));
    if (files.length) send('open-files', files.map(readOne).filter(Boolean));
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.on('open-file', (e, p) => {          // macOS: double-click / drop on the dock icon
    e.preventDefault();
    const f = readOne(p); if (!f) return;
    if (win && !win.isDestroyed()) send('open-files', [f]); else queued.push(f);
  });
  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    const files = process.argv.slice(1).filter(a => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isFile());
    if (files.length) queued.push(...files.map(readOne).filter(Boolean));
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });
}
