/* ============================================================
   folder.js — browse a folder of photos
   ------------------------------------------------------------
   A shoot is hundreds of raws; decoding them all would exhaust
   memory in seconds. So the folder is a list of paths, thumbnails
   come from each raw's embedded JPEG, and only a handful of fully
   decoded frames are kept in memory at a time. Edits are keyed by
   file path, so they survive a photo being evicted and reopened.
   ============================================================ */
'use strict';

const FOLDER = { dir: null, name: '', parent: null, folders: [], files: [], cur: -1 };
const EDITS = new Map();          // path -> settings, so nothing is lost on eviction
const THUMBS = new Map();         // path -> object URL
const FLAGS = new Set();          // paths flagged as keepers in cull mode
const WS = { tabs: [], active: -1 };   // workspace tabs, one folder each: { dir, name, cur }
const KEEP_DECODED = 6;

const isRawPath = n => RAWRE.test(n);
const baseName = p => p.split(/[\\/]/).filter(Boolean).pop() || p;

/* ---------- sorting ---------- */
const SORTS = { name: 'Name', type: 'File type' };
let SORT = 'name';

const extOf = n => { const e = (n.match(/\.([^.]+)$/) || [, ''])[1].toLowerCase(); return e === 'jpeg' ? 'jpg' : e; };
const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
// raws first, then everything else, each type grouped and in name order
const byType = (a, b) => (isRawPath(b.name) - isRawPath(a.name)) || extOf(a.name).localeCompare(extOf(b.name)) || byName(a, b);

function sortFiles() {
  const keep = FOLDER.files[FOLDER.cur];
  FOLDER.files.sort(SORT === 'type' ? byType : byName);
  FOLDER.cur = keep ? FOLDER.files.indexOf(keep) : -1;
}

function setSort(key) {
  if (!SORTS[key]) return;
  SORT = key;
  N.storeSet({ sort: key });
  syncSortSelects();
  sortFiles();
  renderFolder();
  if (isCulling()) renderCull();
}

function syncSortSelects() {
  document.querySelectorAll('.sortSel').forEach(sel => {
    if (!sel.options.length) for (const [k, label] of Object.entries(SORTS)) sel.add(new Option(label, k));
    sel.value = SORT;
  });
}

/* ---------- flags ---------- */
let _flagSave = 0;
function saveFlags() {
  clearTimeout(_flagSave);
  _flagSave = setTimeout(() => N.storeSet({ flags: [...FLAGS] }), 300);
}
const flaggedHere = () => FOLDER.files.filter(f => FLAGS.has(f.path));

function updateFlagCounts() {
  const n = flaggedHere().length;
  const fc = document.getElementById('flagCount');
  if (fc) fc.textContent = n ? `${n} flagged` : '';
  const cc = document.getElementById('cullCount');
  if (cc) cc.textContent = `${n} flagged`;
  const mv = document.getElementById('btnMoveFlagged');
  if (mv) mv.disabled = !n;
  const uf = document.getElementById('btnUnflag');
  if (uf) uf.disabled = !n;
}

/* files moved on disk: carry everything keyed by path over to the new location */
function remapMoved(moved) {
  for (const { from, to } of moved) {
    if (!to || to === from) continue;
    if (EDITS.has(from)) { EDITS.set(to, EDITS.get(from)); EDITS.delete(from); }
    if (THUMBS.has(from)) { THUMBS.set(to, THUMBS.get(from)); THUMBS.delete(from); }
    FLAGS.delete(from);
    A.imgs.forEach(im => { if (im.path === from) im.path = to; });
  }
  saveFlags();
}

/* ---------- opening ----------
   Opening a folder navigates the active tab, unless opts.newTab asks for a
   fresh one or the folder is already open in another tab (which then wins). */
async function openFolder(dir, opts) {
  opts = opts || {};
  if (!dir) return false;
  const r = await N.scanFolder(dir);
  if (!r || r.error) { toast(r ? r.error : 'Could not read that folder'); return false; }
  rememberTabPos();
  let t = opts.tab != null ? opts.tab : WS.tabs.findIndex(x => x.dir === r.dir);
  if (t < 0) {
    if (opts.newTab || WS.active < 0) { WS.tabs.push({ dir: r.dir, name: r.name, cur: null }); t = WS.tabs.length - 1; }
    else t = WS.active;
  }
  const tab = WS.tabs[t];
  tab.dir = r.dir; tab.name = r.name;
  WS.active = t;

  FOLDER.dir = r.dir; FOLDER.name = r.name; FOLDER.parent = r.parent;
  FOLDER.folders = r.folders; FOLDER.files = r.files; FOLDER.cur = -1;
  sortFiles();
  FOLDER.cur = tab.cur ? FOLDER.files.findIndex(f => f.path === tab.cur) : -1;
  if (isCulling() && FOLDER.cur < 0 && FOLDER.files.length) FOLDER.cur = 0;

  document.getElementById('crumb').textContent = r.dir;
  document.getElementById('crumb').title = r.dir;
  saveTabs(); renderTabs();
  renderFolder();
  if (isCulling()) renderCull();
  if (!opts.quiet) toast(`${r.files.length} photo${r.files.length === 1 ? '' : 's'} in ${r.name}`);
  if (opts.switching && !isCulling() && FOLDER.cur >= 0) openPhotoAt(FOLDER.cur);
  return true;
}

function closeFolder() {
  if (WS.active >= 0) { closeTab(WS.active); return; }
  clearFolder();
}

function clearFolder() {
  FOLDER.dir = null; FOLDER.name = ''; FOLDER.parent = null; FOLDER.folders = []; FOLDER.files = []; FOLDER.cur = -1;
  for (const url of THUMBS.values()) URL.revokeObjectURL(url);
  THUMBS.clear();
  document.getElementById('crumb').textContent = 'no folder open';
  renderFolder();
  if (isCulling()) renderCull();
}

/* ---------- workspace tabs ---------- */
function rememberTabPos() {
  const t = WS.tabs[WS.active], f = FOLDER.files[FOLDER.cur];
  if (t && f && t.dir === FOLDER.dir) t.cur = f.path;
}

let _tabSave = 0;
function saveTabs() {
  clearTimeout(_tabSave);
  _tabSave = setTimeout(() => {
    rememberTabPos();
    N.storeSet({
      workspaces: WS.tabs.map(t => ({ dir: t.dir, cur: t.cur || null })),
      activeWorkspace: WS.active, lastFolder: FOLDER.dir
    });
  }, 400);
}

function switchTab(i) {
  if (i === WS.active || !WS.tabs[i]) return;
  openFolder(WS.tabs[i].dir, { tab: i, switching: true, quiet: true });
}

function closeTab(i) {
  if (!WS.tabs[i]) return;
  const wasActive = i === WS.active;
  WS.tabs.splice(i, 1);
  if (i < WS.active) WS.active--;
  if (wasActive) {
    WS.active = -1;
    if (WS.tabs.length) {
      const n = Math.min(i, WS.tabs.length - 1);
      openFolder(WS.tabs[n].dir, { tab: n, switching: true, quiet: true });
      return;
    }
    clearFolder();
  }
  saveTabs(); renderTabs();
}

function renderTabs() {
  const bar = document.getElementById('tabs');
  if (!bar) return;
  bar.innerHTML = '';
  if (!WS.tabs.length) return;
  WS.tabs.forEach((t, i) => {
    const d = document.createElement('div');
    d.className = 'tab' + (i === WS.active ? ' on' : '');
    d.title = t.dir;
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = t.name;
    const x = document.createElement('span'); x.className = 'x'; x.textContent = '×'; x.title = 'Close workspace';
    d.append(nm, x);
    d.onclick = e => e.target === x ? closeTab(i) : switchTab(i);
    bar.append(d);
  });
  const add = document.createElement('div');
  add.className = 'tab add'; add.textContent = '+'; add.title = 'Open a folder in a new workspace';
  add.onclick = async () => { const dir = await N.pickFolder(); if (dir) openFolder(dir, { newTab: true }); };
  bar.append(add);
}

/* ---------- the sidebar ---------- */
function renderFolder() {
  const tree = document.getElementById('tree');
  const strip = document.getElementById('strip');
  if (!tree || !strip) return;

  tree.innerHTML = '';
  if (FOLDER.dir) {
    if (FOLDER.parent) tree.append(frow('↑', '..', () => openFolder(FOLDER.parent)));
    FOLDER.folders.forEach(f => tree.append(frow('▸', f.name, () => openFolder(f.path))));
  }

  strip.innerHTML = '';
  if (!FOLDER.dir) {
    // no folder: fall back to whatever is open
    if (!A.imgs.length) {
      strip.innerHTML = '<div class="striphint">Drop a folder here<br>or click Folder…</div>';
      return;
    }
    A.imgs.forEach((im, i) => strip.append(openThumb(im, i)));
    return;
  }
  updateFlagCounts();
  if (!FOLDER.files.length) {
    strip.innerHTML = '<div class="striphint">No photos in this folder</div>';
    return;
  }
  FOLDER.files.forEach((f, i) => strip.append(fileThumb(f, i)));
  observeThumbs();
}

function frow(icon, name, onClick) {
  const d = document.createElement('div'); d.className = 'frow';
  d.innerHTML = `<span class="ic">${icon}</span><span class="nm"></span>`;
  d.querySelector('.nm').textContent = name;
  d.onclick = onClick;
  return d;
}

function openThumb(im, i) {
  const d = document.createElement('div');
  d.className = 'thumb' + (i === A.cur ? ' sel' : '');
  d.innerHTML = `<img src="${im.thumb}" alt=""><div class="n"></div>` + (im.dirty ? '<div class="edited"></div>' : '');
  d.querySelector('.n').textContent = im.name;
  d.onclick = () => selectImage(i);
  return d;
}

function fileThumb(f, i) {
  const d = document.createElement('div');
  d.className = 'thumb' + (i === FOLDER.cur ? ' sel' : '') + (THUMBS.has(f.path) ? '' : ' loading');
  d.dataset.path = f.path; d.dataset.index = i;
  const img = document.createElement('img');
  if (THUMBS.has(f.path)) img.src = THUMBS.get(f.path);
  const cap = document.createElement('div'); cap.className = 'n'; cap.textContent = f.name;
  d.append(img, cap);
  if (EDITS.has(f.path)) { const e = document.createElement('div'); e.className = 'edited'; d.append(e); }
  if (A.imgs.some(im => im.path === f.path)) { const o = document.createElement('div'); o.className = 'open'; d.append(o); }
  if (FLAGS.has(f.path)) { const b = document.createElement('div'); b.className = 'flagbar'; d.append(b); }
  d.onclick = () => openPhotoAt(i);
  return d;
}

/* thumbnails are generated only as they scroll into view */
let thumbObserver = null;
function observeThumbs() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      makeThumb(e.target);
    }
  }, { root: document.getElementById('strip'), rootMargin: '200px' });
  document.querySelectorAll('#strip .thumb.loading').forEach(t => thumbObserver.observe(t));
}

function makeThumb(el) {
  const p = el.dataset.path;
  if (!p || THUMBS.has(p)) return;
  thumbFor(p).then(url => {
    const img = el.querySelector('img');
    if (img) img.src = url;
    el.classList.remove('loading');
  }).catch(e => {
    if (e.message === 'skipped') return;        // dropped from the queue; re-requested on the next render
    el.classList.remove('loading');
    el.style.opacity = .45;
    console.warn('thumb failed', p, e.message);
  });
}

/* Previews decode one at a time (dcraw is synchronous). Cull mode asks for the
   photo on screen as urgent so it jumps the queue, and prunes what scrolled away. */
const THUMB_JOBS = [];
const THUMB_PENDING = new Map();  // path -> job
const THUMB_BAD = new Set();      // no usable preview; don't keep retrying
let thumbRunning = false;

function thumbFor(p, urgent) {
  if (THUMBS.has(p)) return Promise.resolve(THUMBS.get(p));
  if (THUMB_BAD.has(p)) return Promise.reject(new Error('no preview'));
  let job = THUMB_PENDING.get(p);
  if (!job) {
    job = { p };
    job.promise = new Promise((res, rej) => { job.res = res; job.rej = rej; });
    job.promise.catch(() => { });
    THUMB_PENDING.set(p, job);
    THUMB_JOBS.push(job);
  }
  if (urgent) {
    const k = THUMB_JOBS.indexOf(job);
    if (k > 0) { THUMB_JOBS.splice(k, 1); THUMB_JOBS.unshift(job); }
  }
  pumpThumbs();
  return job.promise;
}

function thumbPrune(keep) {
  for (let k = THUMB_JOBS.length - 1; k >= 0; k--) {
    const job = THUMB_JOBS[k];
    if (keep.has(job.p)) continue;
    THUMB_JOBS.splice(k, 1);
    THUMB_PENDING.delete(job.p);
    job.rej(new Error('skipped'));
  }
}

async function pumpThumbs() {
  if (thumbRunning) return;
  thumbRunning = true;
  while (THUMB_JOBS.length) {
    const job = THUMB_JOBS.shift();
    try {
      const url = await decodeThumb(job.p);
      THUMBS.set(job.p, url);
      job.res(url);
    } catch (e) {
      THUMB_BAD.add(job.p);
      job.rej(e);
    } finally { THUMB_PENDING.delete(job.p); }
  }
  thumbRunning = false;
}

async function decodeThumb(p) {
  const [file] = await N.readFiles([p]);
  if (!file) throw new Error('could not read the file');
  let blob;
  if (isRawPath(file.name)) {
    // the embedded preview is instant compared with a full demosaic
    await ensureDcraw();
    let t = window.dcraw(new Uint8Array(file.bytes), { extractThumbnail: true });
    if (t && typeof t === 'object' && !(t instanceof Uint8Array)) t = Object.values(t)[0];
    if (!t || t.length < 64) throw new Error('no embedded preview');
    blob = new Blob([t], { type: t[0] === 0xFF ? 'image/jpeg' : 'image/x-portable-pixmap' });
    if (t[0] !== 0xFF) blob = await ppmToBlob(t);
  } else {
    blob = new Blob([new Uint8Array(file.bytes)]);
  }
  return URL.createObjectURL(blob);
}

async function ppmToBlob(bytes) {
  const { w, h, maxv, off, bytes: pb } = parsePPM(bytes);
  const c = document.createElement('canvas');
  const k = Math.min(1, 320 / Math.max(w, h));
  c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
  const ctx = c.getContext('2d'), id = ctx.createImageData(c.width, c.height);
  const wide = maxv > 255;
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const sx = Math.min(w - 1, Math.round(x / k)), sy = Math.min(h - 1, Math.round(y / k));
    const s = off + (sy * w + sx) * (wide ? 6 : 3), d = (y * c.width + x) * 4;
    id.data[d] = wide ? pb[s] : pb[s];
    id.data[d + 1] = wide ? pb[s + 2] : pb[s + 1];
    id.data[d + 2] = wide ? pb[s + 4] : pb[s + 2];
    id.data[d + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return new Promise(r => c.toBlob(r, 'image/jpeg', .8));
}

/* ---------- loading a photo, with a bounded cache ---------- */
function rememberEdits() {
  const im = IM();
  if (im && im.path) EDITS.set(im.path, JSON.parse(JSON.stringify(im.s)));
}

function evictOld() {
  while (A.imgs.length > KEEP_DECODED) {
    let victim = -1;
    for (let i = 0; i < A.imgs.length; i++) {
      if (i === A.cur) continue;
      if (victim < 0 || (A.imgs[i].lastUsed || 0) < (A.imgs[victim].lastUsed || 0)) victim = i;
    }
    if (victim < 0) break;
    const im = A.imgs[victim];
    if (im.path) EDITS.set(im.path, JSON.parse(JSON.stringify(im.s)));
    if (im.tex) gl.deleteTexture(im.tex);
    (im.brushes || []).forEach(b => { if (b) { b.canvas.width = b.canvas.height = 1; } });
    A.imgs.splice(victim, 1);
    if (victim < A.cur) A.cur--;
  }
}

async function openPhotoAt(i) {
  if (i < 0 || i >= FOLDER.files.length) return;
  const f = FOLDER.files[i];
  rememberEdits();
  FOLDER.cur = i;
  saveTabs();

  const already = A.imgs.findIndex(im => im.path === f.path);
  if (already >= 0) {
    A.imgs[already].lastUsed = Date.now();
    selectImage(already);
    renderFolder();
    return;
  }
  try {
    await busy('Opening ' + f.name);
    const [file] = await N.readFiles([f.path]);
    if (!file) throw new Error('could not read the file');
    const before = A.imgs.length;
    await loadFromNative([file]);
    if (A.imgs.length === before) return;              // loadFiles already reported why
    const im = A.imgs[A.imgs.length - 1];
    im.path = f.path;
    im.lastUsed = Date.now();
    if (EDITS.has(f.path)) { im.s = JSON.parse(JSON.stringify(EDITS.get(f.path))); im.dirty = true; }
    A.cur = A.imgs.length - 1;
    evictOld();
    selectImage(A.imgs.findIndex(x => x.path === f.path));
  } catch (e) {
    toast(f.name + ': ' + e.message);
  } finally {
    busy(null);
    renderFolder();
  }
}

function stepPhoto(delta) {
  if (!FOLDER.dir || !FOLDER.files.length) return false;
  const next = clamp(FOLDER.cur + delta, 0, FOLDER.files.length - 1);
  if (next === FOLDER.cur) return true;
  openPhotoAt(next);
  return true;
}

/* ---------- wiring ---------- */
document.addEventListener('DOMContentLoaded', () => {
  if (!window.native) return;

  document.getElementById('btnFolder').onclick = async () => {
    const dir = await N.pickFolder();
    if (dir) openFolder(dir);
  };
  document.getElementById('btnUp').onclick = () => FOLDER.parent && openFolder(FOLDER.parent);
  // hand focus back to the page, or the arrow keys keep cycling the dropdown
  document.querySelectorAll('.sortSel').forEach(sel => sel.onchange = () => { setSort(sel.value); sel.blur(); });
  syncSortSelects();
  document.getElementById('crumb').onclick = () => FOLDER.dir && N.reveal(FOLDER.dir);

  N.onOpenFolder(dir => openFolder(dir));

  // dropping a folder gives one entry with no useful File contents, so resolve its path
  addEventListener('drop', async e => {
    const items = e.dataTransfer && e.dataTransfer.files;
    if (!items || !items.length) return;
    for (const f of items) {
      if (f.type) continue;                       // real files carry a MIME type
      const p = N.pathForFile(f);
      if (!p) continue;
      const r = await N.scanFolder(p);
      if (r && !r.error && (r.folders.length || r.files.length)) { e.stopImmediatePropagation(); openFolder(p); return; }
    }
  }, true);

  // arrow keys walk the folder rather than only the open photos
  addEventListener('keydown', e => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (e.metaKey || e.ctrlKey || !FOLDER.dir || isCulling()) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { if (stepPhoto(1)) e.stopImmediatePropagation(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { if (stepPhoto(-1)) e.stopImmediatePropagation(); }
  }, true);

  const prevBuild = window.buildStrip;
  window.buildStrip = function () { renderFolder(); };

  N.storeGet().then(async st => {
    st = st || {};
    if (SORTS[st.sort]) SORT = st.sort;
    syncSortSelects();
    (st.flags || []).forEach(p => FLAGS.add(p));
    const saved = (st.workspaces || []).filter(t => t && t.dir);
    if (!saved.length) { if (st.lastFolder) openFolder(st.lastFolder); return; }
    // reopen every workspace tab; one whose folder has gone is dropped
    WS.tabs = saved.map(t => ({ dir: t.dir, name: baseName(t.dir), cur: t.cur || null }));
    let a = clamp(st.activeWorkspace | 0, 0, WS.tabs.length - 1);
    renderTabs();
    while (WS.tabs.length) {
      if (await openFolder(WS.tabs[a].dir, { tab: a })) break;
      WS.tabs.splice(a, 1);
      a = clamp(a, 0, WS.tabs.length - 1);
    }
    saveTabs(); renderTabs();
  });
});