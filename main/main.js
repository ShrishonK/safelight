'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { extractPreview } = require('./preview');

const IS_MAC = process.platform === 'darwin';
const STORE = path.join(app.getPath('userData'), 'safelight.json');
const EDIT_DIR = path.join(app.getPath('userData'), 'edits');     // one small file per edited photo
const THUMB_DIR = path.join(app.getPath('userData'), 'thumbs');   // strip thumbnails, so folders reopen instantly

const RAW = ['cr2', 'cr3', 'nef', 'arw', 'raf', 'rw2', 'orf', 'dng', 'pef', 'srw', 'raw', '3fr', 'iiq', 'erf', 'mrw'];
const STILL = ['jpg', 'jpeg', 'png', 'webp', 'fedr'];
const PHOTO_EXT = new Set([...STILL, ...RAW]);
const isPhoto = p => PHOTO_EXT.has(path.extname(p).slice(1).toLowerCase());

let win = null;
let queued = [];          // files handed to us before the window is ready

// Neural denoise runs ONNX Runtime in WebAssembly. Its worker threads need
// SharedArrayBuffer, which Chromium withholds from file:// pages unless asked;
// without it every CPU inference runs on a single core.
app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');
// WebGPU is still behind a flag on Linux builds of Chromium.
if (process.platform === 'linux') app.commandLine.appendSwitch('enable-unsafe-webgpu');

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
      { label: 'Open folder…', accelerator: 'CmdOrCtrl+Shift+O', click: menuSend('open-folder') },
      { label: 'Go up a folder', accelerator: 'CmdOrCtrl+Up', click: menuSend('folder-up') },
      { label: 'Close folder', click: menuSend('close-folder') },
      { label: 'Reveal photo in file manager', click: menuSend('reveal') },
      { label: 'Close photo', accelerator: 'CmdOrCtrl+W', click: menuSend('close-photo') },
      { type: 'separator' },
      { label: 'Export photo…', accelerator: 'CmdOrCtrl+E', click: menuSend('export') },
      { label: 'Export all photos…', accelerator: 'CmdOrCtrl+Shift+E', click: menuSend('export-all') },
      { label: 'Export selected photos…', click: menuSend('export-selected') },
      { type: 'separator' },
      { label: 'Convert raw to .fedr…', click: menuSend('convert-raw') },
      { type: 'separator' },
      { label: 'Select subject', accelerator: 'CmdOrCtrl+Shift+S', click: menuSend('select-subject') },
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
      { label: 'Cull mode', accelerator: 'CmdOrCtrl+Shift+K', click: menuSend('cull') },
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
      { name: 'Standard images', extensions: STILL },
      { name: 'Presets and settings', extensions: ['slpreset', 'slcar', 'json'] },
      { name: 'Neural models', extensions: ['onnx', 'data', 'onnx_data'] },
      { name: 'All files', extensions: ['*'] }
    ]
  });
  if (r.canceled) return [];
  return describeAll(r.filePaths);
});

async function readOne(p) {
  try { return { path: p, name: path.basename(p), bytes: await fs.promises.readFile(p) }; }
  catch (e) { console.error('read failed', p, e); return null; }
}
/* Photos travel as paths and are read one at a time by whatever needs them.
   Handing the renderer every picked raw up front meant 25-60 MB each crossing
   IPC at once. Presets, sidecars and models are small and still come with bytes. */
async function describeAll(paths) {
  const out = await Promise.all(paths.map(p => isPhoto(p) ? { path: p, name: path.basename(p) } : readOne(p)));
  return out.filter(Boolean);
}
ipcMain.handle('file:read', async (_e, paths) => (await Promise.all(paths.map(readOne))).filter(Boolean));

ipcMain.handle('dialog:save', async (_e, { defaultName, filters, bytes }) => {
  const st = readStore();
  const r = await dialog.showSaveDialog(win, {
    title: 'Export photo',
    defaultPath: path.join(st.lastExportDir || app.getPath('pictures'), defaultName),
    filters
  });
  if (r.canceled || !r.filePath) return null;
  await fs.promises.writeFile(r.filePath, Buffer.from(bytes));
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

ipcMain.handle('file:write', async (_e, { dir, name, bytes }) => {
  const p = path.join(dir, name);
  await fs.promises.writeFile(p, Buffer.from(bytes));
  return p;
});

ipcMain.handle('folder:scan', (_e, dir) => {
  const exts = new Set([...STILL, ...RAW]);
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { return { error: e.message, dir }; }
  const folders = entries
    .filter(e => e.isDirectory() && !e.name.startsWith('.'))
    .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const files = entries
    .filter(e => e.isFile() && exts.has(path.extname(e.name).slice(1).toLowerCase()))
    .map(e => ({ name: e.name, path: path.join(dir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const parent = path.dirname(dir);
  return { dir, name: path.basename(dir) || dir, parent: parent === dir ? null : parent, folders, files };
});

ipcMain.handle('folder:pick', async () => {
  const st = readStore();
  const r = await dialog.showOpenDialog(win, {
    title: 'Open a folder of photos',
    properties: ['openDirectory'],
    defaultPath: st.lastFolder || app.getPath('pictures')
  });
  if (r.canceled || !r.filePaths[0]) return null;
  st.lastFolder = r.filePaths[0]; writeStore(st);
  return r.filePaths[0];
});

/* ---------- culling: keepers move to a folder of their own ----------
   Nothing is ever overwritten, a move across drives copies before it deletes,
   and a photo's edits follow it to its new path. */
ipcMain.handle('dialog:cullOut', async () => {
  const st = readStore();
  const r = await dialog.showOpenDialog(win, {
    title: 'Choose a folder for the photos you keep',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: st.cullOut || app.getPath('pictures')
  });
  if (r.canceled || !r.filePaths[0]) return null;
  st.cullOut = r.filePaths[0]; writeStore(st);
  return r.filePaths[0];
});

async function freeName(dir, name) {
  const ext = path.extname(name), base = name.slice(0, name.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const dest = path.join(dir, n === 1 ? name : `${base} (${n})${ext}`);
    try { await fs.promises.access(dest); } catch { return dest; }
  }
  throw new Error('too many files by that name in the destination');
}

async function moveOne(from, toDir, toName) {
  await fs.promises.mkdir(toDir, { recursive: true });
  const dest = await freeName(toDir, toName || path.basename(from));
  try {
    await fs.promises.rename(from, dest);
  } catch (e) {
    if (e.code !== 'EXDEV') throw e;
    // a different drive: copy, check it arrived whole, and only then remove the original
    const st = await fs.promises.stat(from);
    await fs.promises.copyFile(from, dest, fs.constants.COPYFILE_EXCL);
    const got = await fs.promises.stat(dest);
    if (got.size !== st.size) {
      await fs.promises.unlink(dest).catch(() => { });
      throw new Error('the copy came out a different size, so the original was left alone');
    }
    await fs.promises.utimes(dest, st.atime, st.mtime).catch(() => { });   // keeps its cached thumbnail
    await fs.promises.unlink(from);
  }
  return dest;
}

function moveEditRecord(from, to) {
  try {
    const src = editFile(from);
    if (!fs.existsSync(src)) return;
    const rec = JSON.parse(fs.readFileSync(src, 'utf8'));
    writeEditSync(to, rec);
    fs.unlinkSync(src);
  } catch (e) { console.error('could not move the edit record', e); }
}

/* system error codes, said plainly */
function moveTrouble(e) {
  const by = {
    ENOENT: 'the file is not there any more',
    EPERM: 'Windows would not let go of the file — is it open somewhere else?',
    EACCES: 'no permission to move that file',
    EBUSY: 'the file is in use by another program',
    ENOSPC: 'the destination drive is full',
    EROFS: 'the destination is read-only'
  }[e.code];
  return by || e.message;
}

/* sidecars written by Lightroom/Capture One (.xmp) and by us (.slcar) travel with their photo,
   renamed to match if the photo had to take a numbered name */
async function moveSidecars(from, to) {
  const ext = path.extname(from), base = from.slice(0, from.length - ext.length);
  const toExt = path.extname(to), toBase = to.slice(0, to.length - toExt.length);
  const seen = new Set();
  for (const [stem, target] of [[base, toBase], [from, to]]) {
    for (const sx of ['.xmp', '.XMP', '.slcar']) {
      const sp = stem + sx;
      if (seen.has(sp.toLowerCase())) continue;
      seen.add(sp.toLowerCase());
      try { await fs.promises.access(sp); } catch { continue; }
      try { await moveOne(sp, path.dirname(to), path.basename(target + sx)); }
      catch (e) { console.warn('sidecar move failed', sp, e.message); }
    }
  }
}

ipcMain.handle('cull:move', async (_e, items) => {
  const out = [];
  for (const it of items) {
    try {
      const to = await moveOne(it.from, it.toDir, it.toName);
      moveEditRecord(it.from, to);
      await moveSidecars(it.from, to);
      out.push({ from: it.from, to });
    } catch (e) {
      out.push({ from: it.from, error: moveTrouble(e) });
    }
  }
  return out;
});

ipcMain.handle('asset:read', (_e, rel) => {
  // only ever from the app's own renderer directory
  const base = path.join(__dirname, '..', 'renderer');
  const p = path.normalize(path.join(base, rel));
  if (!p.startsWith(base)) return null;
  try { return { bytes: fs.readFileSync(p) }; } catch (e) { return null; }
});

ipcMain.handle('store:get', () => readStore());
ipcMain.handle('store:set', (_e, obj) => { writeStore(Object.assign(readStore(), obj)); return true; });

/* ---------- embedded previews and the thumbnail cache ---------- */
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');

ipcMain.handle('preview:get', async (_e, { path: p, want }) => {
  const ext = path.extname(p).slice(1).toLowerCase();
  if (ext === 'fedr') return null;
  if (ext === 'png' || ext === 'webp') {
    const f = await readOne(p);
    return f && { bytes: f.bytes, orientation: 0 };
  }
  return extractPreview(p, want === 'thumb' ? 'thumb' : 'large');
});

async function thumbKey(p) {
  const st = await fs.promises.stat(p);
  return sha1(`${p}|${st.size}|${st.mtimeMs}`);     // a re-saved file gets a fresh thumbnail
}
ipcMain.handle('thumb:get', async (_e, p) => {
  try {
    const key = await thumbKey(p);
    try { return { bytes: await fs.promises.readFile(path.join(THUMB_DIR, key + '.jpg')), cached: true }; }
    catch { /* not cached yet */ }
    const ext = path.extname(p).slice(1).toLowerCase();
    if (ext === 'fedr') return null;
    if (ext === 'png' || ext === 'webp') { const f = await readOne(p); return f && { bytes: f.bytes, orientation: 0 }; }
    return await extractPreview(p, 'thumb');
  } catch (e) { return null; }
});
ipcMain.handle('thumb:put', async (_e, { path: p, bytes }) => {
  try {
    await fs.promises.mkdir(THUMB_DIR, { recursive: true });
    await fs.promises.writeFile(path.join(THUMB_DIR, (await thumbKey(p)) + '.jpg'), Buffer.from(bytes));
  } catch (e) { /* the cache is an optimisation */ }
  return true;
});
async function pruneThumbs(keep) {
  try {
    const names = await fs.promises.readdir(THUMB_DIR);
    if (names.length <= keep) return;
    const stats = await Promise.all(names.map(async n => {
      try { return { n, t: (await fs.promises.stat(path.join(THUMB_DIR, n))).mtimeMs }; } catch { return null; }
    }));
    const old = stats.filter(Boolean).sort((a, b) => a.t - b.t).slice(0, names.length - keep);
    for (const o of old) await fs.promises.unlink(path.join(THUMB_DIR, o.n)).catch(() => { });
  } catch (e) { /* nothing cached yet */ }
}

/* ---------- per-photo edits ----------
   Edits never touch the original file. Each edited photo gets a small record here,
   keyed by its absolute path, so a look survives switching photos, closing the
   folder and quitting — and is only ever baked into pixels by an export. */
const editFile = p => path.join(EDIT_DIR, sha1(p) + '.json');

function writeEditSync(p, record) {
  const f = editFile(p);
  if (!record) { try { fs.unlinkSync(f); } catch { } return; }
  fs.mkdirSync(EDIT_DIR, { recursive: true });
  fs.writeFileSync(f + '.tmp', JSON.stringify(Object.assign({}, record, { path: p })));
  fs.renameSync(f + '.tmp', f);
}
async function writeEdit(p, record) {
  const f = editFile(p);
  if (!record) { await fs.promises.unlink(f).catch(() => { }); return; }
  await fs.promises.mkdir(EDIT_DIR, { recursive: true });
  // write-then-rename, so a crash mid-write never leaves a half record behind
  const tmp = f + '.' + process.pid + '.' + Date.now() + '.tmp';
  await fs.promises.writeFile(tmp, JSON.stringify(Object.assign({}, record, { path: p })));
  await fs.promises.rename(tmp, f);
}

ipcMain.handle('edits:get', async (_e, paths) => {
  let have;
  try { have = new Set(await fs.promises.readdir(EDIT_DIR)); } catch { return {}; }
  const out = {};
  const want = paths.filter(p => have.has(sha1(p) + '.json'));
  for (let i = 0; i < want.length; i += 32) {
    await Promise.all(want.slice(i, i + 32).map(async p => {
      try {
        const r = JSON.parse(await fs.promises.readFile(editFile(p), 'utf8'));
        if (r && r.path === p) out[p] = r;
      } catch (e) { /* unreadable record: treat the photo as unedited */ }
    }));
  }
  return out;
});
ipcMain.handle('edits:set', (_e, { path: p, record }) => writeEdit(p, record).then(() => true, e => { console.error('edit write failed', e); return false; }));
// used while the window is closing, when an async write might not finish
ipcMain.on('edits:flushSync', (e, list) => {
  try { for (const { path: p, record } of list) writeEditSync(p, record); } catch (err) { console.error('edit flush failed', err); }
  e.returnValue = true;
});

/* edits used to live inside safelight.json, rewritten whole on every change */
function migrateEdits() {
  const st = readStore();
  if (!st.edits) return;
  try {
    for (const p of Object.keys(st.edits)) {
      if (!fs.existsSync(editFile(p))) writeEditSync(p, { settings: st.edits[p] });
    }
    delete st.edits;
    writeStore(st);
  } catch (e) { console.error('edit migration failed', e); }
}
ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, electron: process.versions.electron }));
ipcMain.handle('shell:reveal', (_e, p) => { shell.showItemInFolder(p); });

/* ---------- app lifecycle ---------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', async (_e, argv) => {
    const files = argv.slice(1).filter(a => !a.startsWith('-') && fs.existsSync(a));
    if (files.length) send('open-files', await describeAll(files));
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.on('open-file', async (e, p) => {    // macOS: double-click / drop on the dock icon
    e.preventDefault();
    try {
      if (fs.statSync(p).isDirectory()) { send('open-folder', p); return; }
    } catch (err) { return; }
    const [f] = await describeAll([p]); if (!f) return;
    if (win && !win.isDestroyed()) send('open-files', [f]); else queued.push(f);
  });
  app.whenReady().then(async () => {
    migrateEdits();
    buildMenu();
    createWindow();
    pruneThumbs(8000);
    const files = process.argv.slice(1).filter(a => !a.startsWith('-') && fs.existsSync(a) && fs.statSync(a).isFile());
    if (files.length) queued.push(...await describeAll(files));
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });
}