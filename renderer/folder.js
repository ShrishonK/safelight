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
const KEEP_DECODED = 6;

const isRawPath = n => RAWRE.test(n);

/* ---------- opening ---------- */
async function openFolder(dir) {
  if (!dir) return;
  const r = await N.scanFolder(dir);
  if (!r || r.error) { toast(r ? r.error : 'Could not read that folder'); return; }
  FOLDER.dir = r.dir; FOLDER.name = r.name; FOLDER.parent = r.parent;
  FOLDER.folders = r.folders; FOLDER.files = r.files; FOLDER.cur = -1;
  document.getElementById('crumb').textContent = r.dir;
  document.getElementById('crumb').title = r.dir;
  N.storeSet({ lastFolder: r.dir });
  renderFolder();
  toast(`${r.files.length} photo${r.files.length === 1 ? '' : 's'} in ${r.name}`);
}

function closeFolder() {
  FOLDER.dir = null; FOLDER.folders = []; FOLDER.files = []; FOLDER.cur = -1;
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

let thumbQueue = Promise.resolve();
function makeThumb(el) {
  const p = el.dataset.path;
  if (!p || THUMBS.has(p)) return;
  thumbQueue = thumbQueue.then(async () => {
    try {
      const [file] = await N.readFiles([p]);
      if (!file) return;
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
      const url = URL.createObjectURL(blob);
      THUMBS.set(p, url);
      const img = el.querySelector('img');
      if (img) img.src = url;
      el.classList.remove('loading');
    } catch (e) {
      el.classList.remove('loading');
      el.style.opacity = .45;
      console.warn('thumb failed', p, e.message);
    }
  });
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
    if (e.metaKey || e.ctrlKey || !FOLDER.dir) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { if (stepPhoto(1)) e.stopImmediatePropagation(); }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { if (stepPhoto(-1)) e.stopImmediatePropagation(); }
  }, true);

  const prevBuild = window.buildStrip;
  window.buildStrip = function () { renderFolder(); };

  N.storeGet().then(st => { if (st && st.lastFolder) openFolder(st.lastFolder); });
});