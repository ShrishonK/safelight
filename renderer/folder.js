/* ============================================================
   folder.js — browse a folder of photos
   ------------------------------------------------------------
   A shoot is hundreds of raws. The folder is a list of paths;
   thumbnails are the JPEG each camera already embedded, shrunk
   once and cached on disk; opening a photo goes through loader.js,
   which shows that JPEG immediately and develops the raw behind it.
   Edits belong to the path, so they survive leaving a photo, closing
   the folder and quitting the app.
   ============================================================ */
'use strict';

const FOLDER = { dir: null, name: '', parent: null, folders: [], files: [], cur: -1, selectMode: false, selected: new Set() };
const THUMBS = new Map();         // path -> object URL of the camera's preview, shrunk
const THUMB_EL = new Map();       // path -> strip element, so updates never rebuild the strip
const THUMB_EDGE = 360;

const isRawPath = n => RAWRE.test(n);

/* what the filmstrip shows: everything, unless Cull mode is filtering by file type */
function stripFiles() {
  if (typeof CULL === 'undefined' || !CULL.on || CULL.filter === 'all') return FOLDER.files;
  return FOLDER.files.filter(f => cullMatches(f.name));
}

/* ---------- opening ---------- */
async function openFolder(dir, reopenPhoto) {
  if (!dir) return;
  const r = await N.scanFolder(dir);
  if (!r || r.error) { toast(r ? r.error : 'Could not read that folder'); return; }
  flushEdits();
  const paths = r.files.map(f => f.path);
  await loadRecords(paths);
  // photos from the folder we're leaving keep their edits on disk; their pixels can go
  pruneEntries(new Set(paths));
  cancelThumbs();
  const keep = new Set(paths);
  for (const [p, url] of THUMBS) if (!keep.has(p)) { URL.revokeObjectURL(url); THUMBS.delete(p); }

  FOLDER.dir = r.dir; FOLDER.name = r.name; FOLDER.parent = r.parent;
  FOLDER.folders = r.folders; FOLDER.files = r.files;
  const cur = IM();
  FOLDER.cur = cur ? r.files.findIndex(f => f.path === cur.path) : -1;
  exitSelectMode();
  document.getElementById('crumb').textContent = r.dir;
  document.getElementById('crumb').title = r.dir;
  N.storeSet({ lastFolder: r.dir });
  if (typeof loadPicksForFolder === 'function') loadPicksForFolder();
  renderFolder();
  toast(`${r.files.length} photo${r.files.length === 1 ? '' : 's'} in ${r.name}`);
  // every thumbnail in the folder, visible ones first, so scrolling never waits
  r.files.forEach(f => requestThumb(f.path, false));
  if (reopenPhoto) {
    const i = r.files.findIndex(f => f.path === reopenPhoto);
    if (i >= 0 && A.cur < 0) openPhotoAt(i);
  }
}

function closeFolder() {
  flushEdits();
  pruneEntries(new Set());
  cancelThumbs();
  FOLDER.dir = null; FOLDER.folders = []; FOLDER.files = []; FOLDER.cur = -1;
  exitSelectMode();
  for (const url of THUMBS.values()) URL.revokeObjectURL(url);
  THUMBS.clear();
  document.getElementById('crumb').textContent = 'no folder open';
  renderFolder();
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
  THUMB_EL.clear();
  if (!FOLDER.dir) {
    // no folder: fall back to whatever is open
    if (!A.imgs.length) {
      strip.innerHTML = '<div class="striphint">Drop a folder here<br>or click Folder…</div>';
      return;
    }
    A.imgs.forEach((im, i) => strip.append(openThumb(im, i)));
    return;
  }
  if (!FOLDER.files.length) {
    strip.innerHTML = '<div class="striphint">No photos in this folder</div>';
    return;
  }
  const list = stripFiles();
  if (!list.length) {
    strip.innerHTML = '<div class="striphint">No files of that type in this folder</div>';
    return;
  }
  const at = new Map(FOLDER.files.map((f, i) => [f.path, i]));
  const frag = document.createDocumentFragment();
  list.forEach(f => frag.append(fileThumb(f, at.get(f.path))));
  strip.append(frag);
  _stripCur = null;
  syncStrip();
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
  d.className = 'thumb' + (i === A.cur ? ' sel' : '') + (im.dirty ? ' is-edited' : '');
  const img = document.createElement('img'); img.alt = ''; img.decoding = 'async';
  const src = im.devThumb || (im.path && THUMBS.get(im.path)) || im.thumb;
  if (src) img.src = src; else d.classList.add('loading');
  const cap = document.createElement('div'); cap.className = 'n'; cap.textContent = im.name;
  const ed = document.createElement('div'); ed.className = 'edited';
  d.append(img, cap, ed);
  if (im.path) { d.dataset.path = im.path; THUMB_EL.set(im.path, d); }
  d.onclick = () => selectImage(A.imgs.indexOf(im));
  return d;
}

/* developed look if the photo has been edited, otherwise the camera's own preview */
function thumbSrc(path) {
  const im = PHOTOS.get(path);
  if (im) return im.devThumb || THUMBS.get(path) || null;
  const rec = RECORDS.get(path);
  return (rec && rec.thumb) || THUMBS.get(path) || null;
}

function fileThumb(f, i) {
  const d = document.createElement('div');
  const picked = FOLDER.selected.has(f.path);
  const src = thumbSrc(f.path);
  d.className = 'thumb' + (src ? '' : ' loading') + (picked ? ' picked' : '');
  d.dataset.path = f.path; d.dataset.index = i;
  const img = document.createElement('img');
  img.alt = ''; img.decoding = 'async';
  if (src) img.src = src;
  const cap = document.createElement('div'); cap.className = 'n'; cap.textContent = f.name;
  const ed = document.createElement('div'); ed.className = 'edited';
  const op = document.createElement('div'); op.className = 'open';
  const fl = document.createElement('div'); fl.className = 'flag';
  d.append(img, cap, ed, op, fl);
  if (typeof CULL !== 'undefined' && CULL.picks.has(f.path)) d.classList.add('is-flagged');
  if (FOLDER.selectMode) { const s = document.createElement('div'); s.className = 'sel-badge'; d.append(s); }
  d.onclick = () => FOLDER.selectMode ? toggleSelect(f.path) : openPhotoAt(i);
  d.oncontextmenu = e => { e.preventDefault(); showThumbMenu(e, f); };
  THUMB_EL.set(f.path, d);
  return d;
}

/* selection, edited and in-memory badges, updated in place */
let _stripCur = null;
function syncStrip() {
  if (!FOLDER.dir) { renderFolder(); return; }
  const cur = IM(), curPath = cur && cur.path;
  const culling = typeof CULL !== 'undefined' && CULL.on;
  for (const [p, el] of THUMB_EL) {
    const im = PHOTOS.get(p);
    el.classList.toggle('sel', p === curPath);
    el.classList.toggle('is-edited', im ? !!im.dirty : RECORDS.has(p));
    el.classList.toggle('is-open', !!(im && im.tex));
    if (culling) el.classList.toggle('is-flagged', CULL.picks.has(p));
  }
  if (curPath !== _stripCur) {
    _stripCur = curPath;
    const el = curPath && THUMB_EL.get(curPath);
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  if (culling) cullSync();
}

function setThumbImage(path, src) {
  const el = THUMB_EL.get(path);
  if (!el) return;
  const img = el.querySelector('img');
  if (src && img.getAttribute('src') !== src) img.src = src;
  el.classList.toggle('loading', !src);
}

/* ---------- multi-select, for exporting only a chosen few ---------- */
function syncSelbar() {
  const bar = document.getElementById('selbar');
  bar.hidden = !FOLDER.selectMode;
  if (FOLDER.selectMode) {
    document.getElementById('selCount').textContent =
      `${FOLDER.selected.size} selected`;
  }
}
function enterSelectMode(startPath) {
  FOLDER.selectMode = true;
  if (startPath) FOLDER.selected.add(startPath);
  syncSelbar();
  renderFolder();
}
function exitSelectMode() {
  if (!FOLDER.selectMode && !FOLDER.selected.size) return;
  FOLDER.selectMode = false;
  FOLDER.selected.clear();
  syncSelbar();
  renderFolder();
}
function toggleSelect(path) {
  if (FOLDER.selected.has(path)) FOLDER.selected.delete(path); else FOLDER.selected.add(path);
  const el = THUMB_EL.get(path);
  if (el) el.classList.toggle('picked', FOLDER.selected.has(path));
  syncSelbar();
}
function selectAllInFolder() {
  FOLDER.files.forEach(f => FOLDER.selected.add(f.path));
  syncSelbar();
  renderFolder();
}
function clearSelection() {
  FOLDER.selected.clear();
  syncSelbar();
  renderFolder();
}

/* a small floating menu at the cursor, not the centred #modal dialog */
function closeThumbMenu() {
  const m = document.getElementById('ctxMenu');
  m.classList.remove('open'); m.innerHTML = '';
}
function menuRow(label, onClick) {
  const d = document.createElement('div'); d.className = 'frow'; d.textContent = label;
  d.onclick = () => { closeThumbMenu(); onClick(); };
  return d;
}
function menuSep() { const d = document.createElement('div'); d.className = 'sep'; return d; }
function showThumbMenu(e, f) {
  const m = document.getElementById('ctxMenu');
  m.innerHTML = '';
  if (!FOLDER.selectMode) {
    m.append(menuRow('Select images…', () => enterSelectMode(f.path)));
  } else {
    const picked = FOLDER.selected.has(f.path);
    m.append(menuRow(picked ? 'Deselect this photo' : 'Select this photo', () => toggleSelect(f.path)));
    m.append(menuRow('Select all in folder', selectAllInFolder));
    m.append(menuRow('Clear selection', clearSelection));
    m.append(menuSep());
    m.append(menuRow(`Export ${FOLDER.selected.size} selected…`, () => {
      if (!FOLDER.selected.size) { toast('Nothing selected'); return; }
      exportDialog('selected');
    }));
    m.append(menuSep());
    m.append(menuRow('Done selecting', exitSelectMode));
  }
  const pad = 6, vw = innerWidth, vh = innerHeight;
  m.classList.add('open');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(e.clientX, vw - r.width - pad) + 'px';
  m.style.top = Math.min(e.clientY, vh - r.height - pad) + 'px';
}

/* ---------- thumbnails ----------
   Visible thumbnails jump the queue; the rest of the folder fills in behind
   them a couple at a time, and each one is cached on disk for next time. */
const TQ = { hi: [], lo: [], running: 0, gen: 0, queued: new Set() };

function cancelThumbs() {
  TQ.hi.length = 0; TQ.lo.length = 0; TQ.queued.clear(); TQ.gen++;
}

let thumbObserver = null;
function observeThumbs() {
  if (thumbObserver) thumbObserver.disconnect();
  thumbObserver = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      thumbObserver.unobserve(e.target);
      requestThumb(e.target.dataset.path, true);
    }
  }, { root: document.getElementById('strip'), rootMargin: '300px' });
  document.querySelectorAll('#strip .thumb.loading').forEach(t => thumbObserver.observe(t));
}

function requestThumb(path, visible) {
  if (!path || THUMBS.has(path)) return;
  if (TQ.queued.has(path)) {
    if (visible && TQ.lo.includes(path)) { TQ.lo.splice(TQ.lo.indexOf(path), 1); TQ.hi.push(path); }
  } else {
    TQ.queued.add(path);
    (visible ? TQ.hi : TQ.lo).push(path);
  }
  pumpThumbs();
}

function pumpThumbs() {
  const max = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
  while (TQ.running < max && (TQ.hi.length || (TQ.lo.length && TQ.running < 2))) {
    const path = TQ.hi.length ? TQ.hi.shift() : TQ.lo.shift();
    const gen = TQ.gen;
    TQ.running++;
    makeThumb(path, gen).finally(() => {
      TQ.running--;
      TQ.queued.delete(path);
      pumpThumbs();
    });
  }
}

function canvasToBlob(c, type, q) { return new Promise(r => c.toBlob(r, type, q)); }

async function makeThumb(path, gen) {
  if (THUMBS.has(path)) return;
  try {
    let blob;
    const r = await N.thumbGet(path);
    if (gen !== TQ.gen) return;
    if (r && r.cached) {
      blob = new Blob([r.bytes], { type: 'image/jpeg' });
    } else if (r) {
      const src = await jpegToCanvasSource(r.bytes, r.orientation || 1, THUMB_EDGE);
      let c = src;
      if (!(src instanceof HTMLCanvasElement)) {                // small enough to have come back as-is
        c = document.createElement('canvas');
        c.width = src.width; c.height = src.height;
        c.getContext('2d').drawImage(src, 0, 0);
        src.close();
      }
      blob = await canvasToBlob(c, 'image/jpeg', 0.82);
      c.width = c.height = 0;
      if (blob) N.thumbPut(path, new Uint8Array(await blob.arrayBuffer()));
    } else if (/\.fedr$/i.test(path)) {
      const [f] = await N.readFiles([path]);
      if (!f) throw new Error('could not read');
      const buf = f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength);
      const dv = new DataView(buf), hlen = dv.getUint32(4, true);
      const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen)));
      blob = await (await fetch(thumbFromHalf(new Uint16Array(buf, 8 + hlen, head.width * head.height * 4), head.width, head.height))).blob();
    } else {
      throw new Error('no embedded preview');
    }
    if (!blob || gen !== TQ.gen) return;
    const url = URL.createObjectURL(blob);
    THUMBS.set(path, url);
    const im = PHOTOS.get(path);
    if (im && !im.thumb) im.thumb = url;
    setThumbImage(path, thumbSrc(path));
    if (im && im === IM()) placeholderSync(im);
  } catch (e) {
    const el = THUMB_EL.get(path);
    if (el) { el.classList.remove('loading'); el.classList.add('nothumb'); }
    console.warn('thumb failed', path, e && e.message);
  }
}

/* once a photo is edited, its strip thumbnail shows that edit rather
   than the untouched preview it started from */
const _thumbTimers = new Map();
function scheduleThumbRefresh(im) {
  if (!im || !im.path || typeof renderThumb !== 'function') return;
  clearTimeout(_thumbTimers.get(im.path));
  _thumbTimers.set(im.path, setTimeout(async () => {
    _thumbTimers.delete(im.path);
    if (!im.tex || RANK[im.stage] < RANK.half) return;       // the camera JPEG isn't the develop
    const edited = isEdited(im.s) || (im.brushData && im.brushData.some(Boolean)) || im.brushDirty;
    const key = edited ? JSON.stringify(im.s) + '|' + im.stage + (im.brushDirty ? Math.random() : '') : '';
    if (key === im._thumbKey) return;
    im._thumbKey = key;
    try {
      if (!edited) {
        if (!im.devThumb) return;
        im.devThumb = null;
      } else {
        const blob = await renderThumb(im);
        if (!blob) return;
        im.devThumb = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
      }
      setThumbImage(im.path, thumbSrc(im.path));
      scheduleEditPersist(im);
    } catch (e) { console.warn('thumb refresh failed', im.path, e && e.message); }
  }, 500));
}

/* ---------- moving through the folder ---------- */
function openPhotoAt(i) {
  if (i < 0 || i >= FOLDER.files.length) return;
  const f = FOLDER.files[i];
  FOLDER.cur = i;
  openPath(f.path, f.name).catch(e => toast(f.name + ': ' + e.message));
}

function stepPhoto(delta) {
  if (!FOLDER.dir || !FOLDER.files.length) return false;
  const list = stripFiles();
  if (!list.length) return false;
  const cur = IM();
  let at = cur ? list.findIndex(f => f.path === cur.path) : -1;
  if (at < 0) at = delta > 0 ? -1 : list.length;          // off the end: step in from either side
  const f = list[clamp(at + delta, 0, list.length - 1)];
  if (!f || (cur && f.path === cur.path)) return true;
  openPhotoAt(FOLDER.files.indexOf(f));
  return true;
}

/* re-read the folder after files have moved in or out of it */
async function refreshFolder() {
  if (!FOLDER.dir) return;
  const r = await N.scanFolder(FOLDER.dir);
  if (!r || r.error) return;
  FOLDER.folders = r.folders; FOLDER.files = r.files; FOLDER.parent = r.parent;
  const cur = IM();
  FOLDER.cur = cur ? r.files.findIndex(f => f.path === cur.path) : -1;
  renderFolder();
  r.files.forEach(f => requestThumb(f.path, false));
}

/* ---------- wiring ---------- */
document.addEventListener('DOMContentLoaded', () => {
  if (!window.native) return;

  document.getElementById('btnFolder').onclick = async () => {
    const dir = await N.pickFolder();
    if (dir) openFolder(dir);
  };
  document.getElementById('btnUp').onclick = () => FOLDER.parent && openFolder(FOLDER.parent);
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
    if (e.key === 'Escape' && FOLDER.selectMode) { exitSelectMode(); return; }
    if (e.metaKey || e.ctrlKey || !FOLDER.dir) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { if (stepPhoto(1)) { e.preventDefault(); e.stopImmediatePropagation(); } }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { if (stepPhoto(-1)) { e.preventDefault(); e.stopImmediatePropagation(); } }
  }, true);

  document.getElementById('selAll').onclick = selectAllInFolder;
  document.getElementById('selNone').onclick = clearSelection;
  document.getElementById('selDone').onclick = exitSelectMode;
  document.getElementById('selExport').onclick = () => {
    if (!FOLDER.selected.size) { toast('Nothing selected'); return; }
    exportDialog('selected');
  };

  // close the right-click menu on any outside interaction
  addEventListener('pointerdown', e => {
    const m = document.getElementById('ctxMenu');
    if (m.classList.contains('open') && !m.contains(e.target)) closeThumbMenu();
  }, true);
  addEventListener('blur', closeThumbMenu, true);
  addEventListener('scroll', closeThumbMenu, true);

  // the strip is built once per folder; everything after that only updates badges
  window.buildStrip = function () { if (FOLDER.dir) syncStrip(); else renderFolder(); };

  // pick up where you left off: the folder, and the photo that was on screen
  N.storeGet().then(st => { if (st && st.lastFolder) openFolder(st.lastFolder, st.lastPhoto); });
});
