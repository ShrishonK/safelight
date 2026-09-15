/* ============================================================
   loader.js — photos in memory, and the edits that go with them
   ------------------------------------------------------------
   Every file gets exactly one entry for the whole session, however
   it was opened. An entry always holds its settings, brush paint and
   undo history; its pixels come and go:

     cold ─▶ preview ─▶ half ─▶ full
             camera     linear   linear, full resolution
             JPEG       ½ size   (the ½ size copy stays for fit views)

   The camera's own JPEG shows up in a few milliseconds, the half-size
   develop in a second or two, and the full demosaic finishes in the
   background. Raw decoding happens in workers so none of it blocks
   the interface. Textures are released oldest-first once they pass a
   budget sized to the machine, but settings never are: edits live in
   a small per-photo record on disk until an export bakes them in.
   ============================================================ */
'use strict';

const PHOTO_RE = /\.(jpe?g|png|webp|fedr|cr2|cr3|nef|arw|raf|rw2|orf|dng|pef|srw|raw|3fr|iiq|erf|mrw)$/i;
const PHOTOS = new Map();          // path -> entry
const RECORDS = new Map();         // path -> edit record on disk (absent = unedited)
const CHECKED = new Set();         // paths whose record has been looked up
const RANK = { cold: 0, preview: 1, half: 2, full: 3 };
const MB = 1024 * 1024;
const DEVICE_GB = navigator.deviceMemory || 4;
const CORES = navigator.hardwareConcurrency || 4;
// Texture memory the photos off screen may keep. The GPU process holds roughly twice
// this in practice, so 512 MB here is about 1 GB of real memory on an 8 GB machine.
const TEX_BUDGET = clamp(DEVICE_GB * 64 * MB, 192 * MB, 768 * MB);

const baseName = p => p.split(/[\\/]/).pop();
const rank = im => RANK[im.stage] || 0;
const alive = im => !im.path || PHOTOS.get(im.path) === im;
const nextFrame = () => new Promise(r => requestAnimationFrame(r));

function kindOf(name) {
  if (RAWRE.test(name)) return 'raw';
  if (/\.fedr$/i.test(name)) return 'fedr';
  return 'std';
}

/* ============================================================
   edit records
   ============================================================ */
function isEdited(s) {
  if (!s) return false;
  const d = defaults();
  for (const k of Object.keys(d)) {
    const v = s[k] === undefined ? d[k] : s[k];
    if (JSON.stringify(v) !== JSON.stringify(d[k])) return true;
  }
  return false;
}

async function loadRecords(paths) {
  const need = paths.filter(p => p && !CHECKED.has(p));
  if (!need.length || !window.native) return;
  const found = await N.editsGet(need);
  for (const p of need) {
    CHECKED.add(p);
    // older versions saved a record for every photo opened, edited or not
    const r = found[p];
    if (r && (isEdited(r.settings) || (r.brushes || []).some(Boolean))) RECORDS.set(p, r);
  }
}

function hasBrushPaint(im) {
  return (im.s.masks || []).some(m => m.type === 'brush');
}

/* canvases -> PNG data, only when paint has changed since the last time */
function captureBrushes(im) {
  if (im.brushRestore) return;                       // still restoring: the saved copy is the truth
  if (!im.brushDirty || !im.brushes || !im.brushes.some(Boolean)) return;
  im.brushData = [];
  for (let i = 0; i < MAXBRUSH; i++) {
    const b = im.brushes[i];
    im.brushData[i] = b ? b.canvas.toDataURL('image/png') : null;
  }
  im.brushDirty = false;
}

function recordFor(im) {
  captureBrushes(im);
  const paint = hasBrushPaint(im) && im.brushData && im.brushData.some(Boolean);
  if (!isEdited(im.s) && !paint) return null;
  return {
    settings: im.s,
    brushes: paint ? im.brushData : undefined,
    thumb: im.devThumb || undefined,
    updated: Date.now()
  };
}

const _persistTimers = new Map();
function persistNow(im) {
  if (!im || !im.path || !window.native) return;
  clearTimeout(_persistTimers.get(im.path));
  _persistTimers.delete(im.path);
  const rec = recordFor(im);
  const json = rec ? JSON.stringify(Object.assign({}, rec, { updated: 0 })) : '';
  if (json === im._savedJSON) return;
  im._savedJSON = json;
  if (rec) RECORDS.set(im.path, rec); else RECORDS.delete(im.path);
  N.editsSet(im.path, rec);
}
/* called on every committed change; the disk write trails by a moment */
function scheduleEditPersist(im) {
  if (!im || !im.path) return;
  im.dirty = isEdited(im.s);
  clearTimeout(_persistTimers.get(im.path));
  _persistTimers.set(im.path, setTimeout(() => persistNow(im), 700));
}
function flushEdits() {
  for (const im of PHOTOS.values()) if (_persistTimers.has(im.path)) persistNow(im);
}
/* on close there is no time for async writes, so pending ones go synchronously */
function flushEditsSync() {
  const list = [];
  for (const im of PHOTOS.values()) {
    if (!_persistTimers.has(im.path)) continue;
    clearTimeout(_persistTimers.get(im.path)); _persistTimers.delete(im.path);
    const rec = recordFor(im);
    list.push({ path: im.path, record: rec });
  }
  if (list.length && window.native) N.editsFlushSync(list);
}

/* ============================================================
   entries
   ============================================================ */
function makeEntry(path, name) {
  name = name || baseName(path);
  const im = baseImage(name, 1, 1, false);
  im.path = path;
  im.kind = kindOf(name);
  im.stage = 'cold';
  im.texLo = null;
  im.waiters = [];
  im.jobs = {};
  im.lastUsed = 0;
  im._savedJSON = '';                                  // matches "no record" until something is edited
  const rec = RECORDS.get(path);
  if (rec && rec.settings) {
    im.s = Object.assign(defaults(), JSON.parse(JSON.stringify(rec.settings)));
    im.brushData = rec.brushes || null;
    im.devThumb = rec.thumb || null;
    im.dirty = isEdited(im.s);
    im._savedJSON = JSON.stringify(Object.assign({}, rec, { updated: 0, path: undefined }));
  }
  if (typeof THUMBS !== 'undefined' && THUMBS.has(path)) im.thumb = THUMBS.get(path);
  PHOTOS.set(path, im);
  A.imgs.push(im);
  return im;
}

/* the entry for a file, created on first use (records must be looked up first) */
async function photoEntry(path, name) {
  let im = PHOTOS.get(path);
  if (im) return im;
  await loadRecords([path]);
  return PHOTOS.get(path) || makeEntry(path, name);
}
function photoEntrySync(path, name) {
  return PHOTOS.get(path) || makeEntry(path, name);
}

async function openPath(path, name) {
  const im = await photoEntry(path, name);
  selectImage(A.imgs.indexOf(im));
  return im;
}

/* forget an entry entirely: its edits are already on disk */
function closePhoto(im) {
  if (!im) return;
  if (im.path) persistNow(im);
  cancelJobs(im);
  dropTextures(im);
  (im.brushes || []).forEach(b => { if (b) b.canvas.width = b.canvas.height = 1; });
  im.waiters.splice(0).forEach(w => w.reject(new Error('closed')));
  if (im.path && PHOTOS.get(im.path) === im) PHOTOS.delete(im.path);
  const i = A.imgs.indexOf(im);
  if (i < 0) return;
  const wasCur = i === A.cur;
  A.imgs.splice(i, 1);
  if (i < A.cur) A.cur--;
  else if (wasCur) A.cur = -1;
}

/* entries from other folders that aren't on screen are closed when the folder changes */
function pruneEntries(keep) {
  const cur = IM();
  for (const im of [...PHOTOS.values()]) {
    if (im === cur || keep.has(im.path) || im.pin) continue;
    closePhoto(im);
  }
}

/* ============================================================
   textures
   ============================================================ */
function texBytes(im) { return (im.tex ? im.texBytes || 0 : 0) + (im.texLo ? im.texLoBytes || 0 : 0); }

function dropTextures(im) {
  if (im.tex) gl.deleteTexture(im.tex);
  if (im.texLo) gl.deleteTexture(im.texLo);
  im.tex = null; im.texLo = null; im.texBytes = 0; im.texLoBytes = 0;
  if (im.path) im.stage = 'cold';
}

/* give the full-resolution texture back but keep the half-size one */
function dropFull(im) {
  if (im.stage !== 'full' || !im.texLo) return 0;
  const freed = im.texBytes;
  gl.deleteTexture(im.tex);
  im.tex = im.texLo; im.texBytes = im.texLoBytes;
  im.texLo = null; im.texLoBytes = 0;
  im.stage = 'half';
  return freed;
}

function unloadPhoto(im) {
  if (!im.path || im === IM() || im.pin) return 0;
  const freed = texBytes(im);
  persistNow(im);
  cancelJobs(im);
  captureBrushes(im);
  if (im.brushes && im.brushes.some(Boolean) && !im.brushRestore) {
    im.brushes.forEach(b => { if (b) b.canvas.width = b.canvas.height = 1; });
    im.brushes = [];
  }
  dropTextures(im);
  return freed;
}

function trimMemory() {
  const cur = IM();
  let total = 0;
  for (const im of A.imgs) if (im !== cur) total += texBytes(im);
  if (total <= TEX_BUDGET) return;
  const lru = A.imgs.filter(im => im !== cur && im.path && !im.pin && texBytes(im))
    .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0));
  for (const im of lru) { if (total <= TEX_BUDGET) break; total -= dropFull(im); }
  for (const im of lru) { if (total <= TEX_BUDGET) break; total -= unloadPhoto(im); }
}

function maxTexture() { return Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096, 16384); }

/* upload linear half floats a band at a time so a 200 MB frame never stalls a frame */
async function uploadHalfFloat(w, h, rgba) {
  const t = storageTex(gl.RGBA16F, w, h);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  const bands = w * h > 8e6 ? Math.ceil(h / 1024) : 1;
  if (bands === 1) {
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.HALF_FLOAT, rgba);
    return t;
  }
  const rows = Math.ceil(h / bands);
  for (let y = 0; y < h; y += rows) {
    const n = Math.min(rows, h - y);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y, w, n, gl.RGBA, gl.HALF_FLOAT, rgba.subarray(y * w * 4, (y + n) * w * 4));
    await nextFrame();
  }
  return t;
}

/* apply an EXIF orientation (1-8) that the image decoder didn't */
function orientBitmap(bmp, o, maxEdge) {
  const k = maxEdge ? Math.min(1, maxEdge / Math.max(bmp.width, bmp.height)) : 1;
  const bw = Math.max(1, Math.round(bmp.width * k)), bh = Math.max(1, Math.round(bmp.height * k));
  const swap = o >= 5 && o <= 8;
  const c = document.createElement('canvas');
  c.width = swap ? bh : bw; c.height = swap ? bw : bh;
  const g = c.getContext('2d');
  g.imageSmoothingQuality = 'high';
  const T = {
    2: [-1, 0, 0, 1, bw, 0], 3: [-1, 0, 0, -1, bw, bh], 4: [1, 0, 0, -1, 0, bh],
    5: [0, 1, 1, 0, 0, 0], 6: [0, 1, -1, 0, bh, 0], 7: [0, -1, -1, 0, bh, bw], 8: [0, -1, 1, 0, 0, bw]
  }[o];
  if (T) g.setTransform(...T);
  g.drawImage(bmp, 0, 0, bw, bh);
  return c;
}

async function jpegToCanvasSource(bytes, orientation, maxEdge) {
  const bmp = await createImageBitmap(new Blob([bytes]));
  if ((!orientation || orientation === 1) && (!maxEdge || Math.max(bmp.width, bmp.height) <= maxEdge)) return bmp;
  const c = orientBitmap(bmp, orientation, maxEdge);
  bmp.close();
  return c;
}

function installTexture(im, tex, w, h, stage, bytes) {
  const cur = im === IM();
  const oldW = im.w;
  if (stage === 'full') {
    if (im.stage === 'preview' && im.tex) gl.deleteTexture(im.tex);
    else if (im.stage === 'half' && im.tex) { im.texLo = im.tex; im.texLoBytes = im.texBytes; }
    if (im.stage === 'full' && im.tex) gl.deleteTexture(im.tex);
  } else if (im.tex) {
    gl.deleteTexture(im.tex);
  }
  im.tex = tex; im.texBytes = bytes;
  im.w = w; im.h = h;
  im.stage = stage;
  im.linear = stage !== 'preview' && im.kind !== 'std';
  im.lastUsed = performance.now();
  if (cur && !A.view.fit && oldW > 1) A.view.zoom *= oldW / w;
  for (const wt of im.waiters.slice()) {
    if (RANK[wt.stage] <= RANK[stage]) { im.waiters.splice(im.waiters.indexOf(wt), 1); wt.resolve(im); }
  }
  if (im.brushData && !(im.brushes && im.brushes.some(Boolean))) warmBrushes(im);
  if (cur) {
    uploadAllBrushes();
    requestRender(true);
    if (typeof updateCapture === 'function') updateCapture();
  }
  trimMemory();
  if (typeof loadPillSync === 'function') loadPillSync();
}

function failStage(im, stage, err, quiet) {
  for (const wt of im.waiters.slice()) {
    if (RANK[wt.stage] >= RANK[stage]) { im.waiters.splice(im.waiters.indexOf(wt), 1); wt.reject(err); }
  }
  if (!quiet && im === IM() && String(err && err.message) !== 'cancelled') {
    showError(im.name + ' could not be developed', [String(err && err.message || err)]);
  }
  if (typeof loadPillSync === 'function') loadPillSync();
}

/* ============================================================
   raw decoding in workers
   ============================================================ */
const RAW = {
  waiting: [], running: new Set(), seq: 0,
  lanes: { half: DEVICE_GB >= 8 ? clamp(CORES - 2, 1, 3) : DEVICE_GB >= 4 ? 2 : 1, full: DEVICE_GB >= 8 && CORES >= 6 ? 2 : 1 },
  workersOK: true
};

function standalone(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return (u.byteOffset === 0 && u.byteLength === u.buffer.byteLength) ? u.buffer : u.slice().buffer;
}

/* job: { half, prio, path | bytes, onBytes } -> promise of { w, h, rgba, meta } */
function rawJob(spec) {
  const job = Object.assign({ id: ++RAW.seq, prio: 5 }, spec);
  job.promise = new Promise((res, rej) => { job.resolve = res; job.reject = rej; });
  job.promise.catch(() => { });
  job.cancel = () => {
    const i = RAW.waiting.indexOf(job);
    if (i >= 0) RAW.waiting.splice(i, 1);
    if (RAW.running.has(job)) {
      RAW.running.delete(job);
      if (job.worker) job.worker.terminate();
      pumpRaw();
    }
    job.cancelled = true;
    job.reject(new Error('cancelled'));
  };
  RAW.waiting.push(job);
  pumpRaw();
  return job;
}

function laneBusy(lane) { let n = 0; for (const j of RAW.running) if ((j.half ? 'half' : 'full') === lane) n++; return n; }

function pumpRaw() {
  RAW.waiting.sort((a, b) => a.prio - b.prio || a.id - b.id);
  for (const job of RAW.waiting.slice()) {
    const lane = job.half ? 'half' : 'full';
    if (laneBusy(lane) >= RAW.lanes[lane]) {
      // the photo on screen never queues behind background work: it takes a prefetch's worker,
      // and the prefetch goes back in the queue to start over later
      if (job.prio !== 0) continue;
      let victim = null;
      for (const r of RAW.running) if ((r.half ? 'half' : 'full') === lane && r.prio > 0 && r.path && (!victim || r.prio > victim.prio)) victim = r;
      if (!victim) continue;
      RAW.running.delete(victim);
      if (victim.worker) victim.worker.terminate();
      victim.worker = null;
      victim.run++;
      RAW.waiting.push(victim);
    }
    RAW.waiting.splice(RAW.waiting.indexOf(job), 1);
    RAW.running.add(job);
    runRaw(job);
  }
}

async function runRaw(job) {
  const run = job.run = (job.run || 0) + 1;
  const current = () => RAW.running.has(job) && job.run === run;
  const finish = (fn, v) => {
    if (!current()) return;                          // cancelled or pre-empted meanwhile
    RAW.running.delete(job);
    if (job.worker) job.worker.terminate();          // hands the decoder's heap straight back
    job.worker = null;
    fn(v);
    pumpRaw();
  };
  try {
    let bytes = job.bytes;
    if (!bytes) {
      const [f] = await N.readFiles([job.path]);
      if (!f) throw new Error('could not read the file');
      bytes = f.bytes;
    }
    if (!current()) return;
    if (job.onBytes) job.onBytes(bytes);
    job.bytes = null;
    const maxTex = maxTexture();
    if (!RAW.workersOK) {
      finish(job.resolve, await decodeRawHere(new Uint8Array(bytes), job.half, maxTex));
      return;
    }
    // until one worker has answered, keep a copy in case workers can't start at all here
    let spare = RAW.workersProven ? null : new Uint8Array(bytes).slice();
    const w = job.worker = new Worker('rawworker.js');
    w.onmessage = e => {
      const d = e.data;
      RAW.workersProven = true; spare = null;
      if (d.ok) finish(job.resolve, d);
      else finish(job.reject, new Error(d.error));
    };
    w.onerror = async ev => {
      ev.preventDefault();
      if (!spare) { finish(job.reject, new Error(ev.message || 'the raw decoder stopped')); return; }
      console.warn('raw worker failed, decoding on the main thread:', ev.message);
      RAW.workersOK = false;
      w.terminate(); job.worker = null;
      try { finish(job.resolve, await decodeRawHere(spare, job.half, maxTex)); }
      catch (err) { finish(job.reject, err); }
    };
    const buf = standalone(bytes);
    w.postMessage({ id: job.id, bytes: buf, half: !!job.half, maxTex, skipIdentify: !!job.skipIdentify }, [buf]);
  } catch (err) {
    finish(job.reject, err);
  }
}

/* fallback for when workers aren't available: same decode, on this thread */
async function decodeRawHere(bytes, half, maxTex) {
  await loadDcrawHere();
  let meta = {};
  try {
    const txt = window.dcraw(bytes, { verbose: true, identify: true });
    if (typeof txt === 'string') {
      const g = k => (txt.match(new RegExp(k + ':\\s*(.+)')) || [, ''])[1].trim();
      const size = /Output size:\s*(\d+)\s*x\s*(\d+)/.exec(txt);
      meta = { camera: g('Camera'), iso: g('ISO speed'), shutter: g('Shutter'), aperture: g('Aperture'),
        focal: g('Focal length'), timestamp: g('Timestamp'), outW: size ? +size[1] : 0, outH: size ? +size[2] : 0 };
    }
  } catch (e) { /* optional */ }
  const opts = { useCameraWhiteBalance: true, use16BitLinearMode: true };
  if (half) opts.setHalfSizeMode = true;
  let out = window.dcraw(bytes, opts);
  if (out && typeof out === 'object' && !(out instanceof Uint8Array)) out = Object.values(out)[0];
  if (!out || typeof out === 'string' || out.length < 64) throw new Error('this file is not a raw image the decoder recognises');
  const { w, h, maxv, off } = parsePPM(out);
  if (w > maxTex || h > maxTex) throw new Error(`this frame is ${w}×${h}, larger than this GPU can hold`);
  const rgba = new Uint16Array(w * h * 4), ONE = toHalf(1), scale = maxv === 255 ? 257 : 1;
  const LUT = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) LUT[i] = toHalf(i / 65535);
  for (let k = 0, p = off; k < w * h; k++, p += 6) {
    const o = k * 4;
    rgba[o] = LUT[Math.min(65535, ((out[p] << 8) | out[p + 1]) * scale)];
    rgba[o + 1] = LUT[Math.min(65535, ((out[p + 2] << 8) | out[p + 3]) * scale)];
    rgba[o + 2] = LUT[Math.min(65535, ((out[p + 4] << 8) | out[p + 5]) * scale)];
    rgba[o + 3] = ONE;
  }
  return { w, h, rgba, meta, reduced: 1 };
}
let _dcrawHere = null;
function loadDcrawHere() {
  if (window.dcraw) return Promise.resolve();
  return _dcrawHere || (_dcrawHere = loadScript('vendor/dcraw.js'));
}

/* ============================================================
   stages
   ============================================================ */
function cancelJobs(im, only) {
  if (!only || only === 'full') im.wantFull = null;
  for (const k of Object.keys(im.jobs)) {
    if (only && k !== only) continue;
    const j = im.jobs[k];
    if (j && j.cancel) j.cancel();
    delete im.jobs[k];
  }
}

function noteExif(im, bytes) {
  if (im.exif || typeof parseExif !== 'function') return;
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const x = parseExif(u.subarray(0, 384 * 1024));
  if (x) { im.exif = x; im.capture = null; if (im === IM() && typeof updateCapture === 'function') updateCapture(); }
}

function noteMeta(im, meta) {
  if (!meta) return;
  im.meta = Object.assign({}, im.meta || {}, meta);
  im.capture = null;
  if (im === IM() && typeof updateCapture === 'function') updateCapture();
}

/* start whatever loads are needed to get `im` to `stage` */
function want(im, stage, prio) {
  if (!im.path) return;
  const target = RANK[stage];
  im.lastUsed = Math.max(im.lastUsed || 0, performance.now() - (prio || 0) * 1000);
  if (rank(im) >= target) return;

  if (im.kind !== 'raw') {
    if (!im.jobs.load) im.jobs.load = loadStill(im);
    return;
  }
  const onScreen = im === IM();
  if (onScreen && rank(im) < RANK.preview && !im.jobs.preview) im.jobs.preview = loadPreview(im);
  // a photo on screen goes through the half-size copy; one wanted only for export skips it
  if (rank(im) < RANK.half && (target === RANK.half || onScreen)) {
    if (!im.jobs.half) im.jobs.half = decodeStage(im, true, prio);
    else if (im.jobs.half.prio > prio) { im.jobs.half.prio = prio; pumpRaw(); }
  }
  if (target >= RANK.full) {
    if (im.jobs.full) {
      if (im.jobs.full.prio > prio + 1) { im.jobs.full.prio = prio + 1; pumpRaw(); }
    } else if (im.jobs.half && rank(im) < RANK.half) {
      // start the long demosaic only once the half-size copy (seconds away) is on screen
      im.wantFull = Math.min(im.wantFull == null ? Infinity : im.wantFull, prio);
    } else {
      im.jobs.full = decodeStage(im, false, prio + 1);
    }
  }
}

function ensureStage(im, stage) {
  const target = im.kind === 'raw' || !im.path ? stage : 'full';
  if (!im.path || rank(im) >= RANK[target]) return Promise.resolve(im);
  const p = new Promise((resolve, reject) => im.waiters.push({ stage: target, resolve, reject }));
  want(im, target, 0);
  return p;
}

async function loadPreview(im) {
  try {
    const r = await N.previewGet(im.path, 'large');
    if (!r || rank(im) >= RANK.preview || !alive(im)) return;
    const src = await jpegToCanvasSource(r.bytes, r.orientation, 2560);
    if (rank(im) >= RANK.preview || !alive(im)) { if (src.close) src.close(); return; }
    const w = src.width, h = src.height;
    const t = storageTex(gl.RGBA8, w, h);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, src);
    if (src.close) src.close(); else src.width = src.height = 1;
    installTexture(im, t, w, h, 'preview', w * h * 4);
  } catch (e) {
    console.warn('no quick preview for', im.path, e && e.message);
  } finally {
    delete im.jobs.preview;
  }
}

function decodeStage(im, half, prio) {
  // the metadata pass only needs to happen once per photo
  const job = rawJob({ path: im.path, half, prio, skipIdentify: !!(im.meta && im.meta.outW), onBytes: b => noteExif(im, b) });
  const stage = half ? 'half' : 'full';
  job.promise.then(async r => {
    if (im.jobs[stage] === job) delete im.jobs[stage];
    noteMeta(im, r.meta);
    if (!alive(im) || rank(im) >= RANK[stage]) return;
    const t = await uploadHalfFloat(r.w, r.h, r.rgba);
    r.rgba = null;
    if (!alive(im) || rank(im) >= RANK[stage]) { gl.deleteTexture(t); return; }
    let w = r.w, h = r.h;
    if (half) {
      // hold the photo at its full size from the start, so crop, zoom and export sizes don't jump
      let fw = r.meta && r.meta.outW, fh = r.meta && r.meta.outH;
      if (!fw || Math.abs(fw / fh - r.w / r.h) > 0.02) { fw = r.w * 2; fh = r.h * 2; }
      const mt = maxTexture();
      while (fw > mt || fh > mt) { fw /= 2; fh /= 2; }
      w = Math.round(fw); h = Math.round(fh);
    }
    installTexture(im, t, w, h, stage, r.w * r.h * 8);
    if (half && im.wantFull != null) {
      const p = im.wantFull;
      im.wantFull = null;
      if (im === IM() || im.pin) want(im, 'full', p);
    }
    if (!half && r.reduced > 1 && im === IM()) toast(`${im.name}: reduced ${r.reduced}× to fit this GPU`);
  }, err => {
    if (im.jobs[stage] === job) delete im.jobs[stage];
    if (String(err && err.message) === 'cancelled') return;
    console.error('decode failed', im.path, err);
    // a full decode that runs out of memory still leaves a usable half-size photo
    if (half) im.wantFull = null;
    const fallback = !half && rank(im) >= RANK.half;
    failStage(im, stage, err, fallback);
    if (fallback && im === IM()) toast(im.name + ': showing half size — ' + err.message);
  });
  return job;
}

async function loadStill(im) {
  try {
    const [f] = await N.readFiles([im.path]);
    if (!f) throw new Error('could not read the file');
    if (!alive(im)) return;
    noteExif(im, f.bytes);
    const file = new File([f.bytes], im.name);
    const x = im.kind === 'fedr' ? await loadFedr(file) : await loadStd(file);
    if (!alive(im) || rank(im) >= RANK.full) { gl.deleteTexture(x.tex); return; }
    if (x.meta) noteMeta(im, x.meta);
    if (!im.thumb) im.thumb = x.thumb;
    installTexture(im, x.tex, x.w, x.h, 'full', x.w * x.h * (im.kind === 'fedr' ? 8 : 4));
  } catch (e) {
    failStage(im, 'full', e);
  } finally {
    delete im.jobs.load;
  }
}

/* painted masks come back from their saved PNGs when a photo is opened again */
function warmBrushes(im) {
  if (!im.brushData || !im.brushData.some(Boolean) || (im.brushes && im.brushes.some(Boolean))) return Promise.resolve();
  if (im.brushRestore) return im.brushRestore;
  im.brushRestore = (async () => {
    for (let i = 0; i < im.brushData.length; i++) {
      const url = im.brushData[i];
      if (!url) continue;
      const img = new Image();
      img.src = url;
      await img.decode();
      const b = ensureBrush(i, im);
      b.ctx.clearRect(0, 0, b.canvas.width, b.canvas.height);
      b.ctx.drawImage(img, 0, 0, b.canvas.width, b.canvas.height);
    }
  })().catch(e => console.warn('brush restore failed', e)).finally(() => {
    im.brushRestore = null;
    if (im === IM()) { uploadAllBrushes(); requestRender(false); }
  });
  return im.brushRestore;
}

/* ============================================================
   what the photo on screen needs
   ============================================================ */
let _neighbourTimer = 0, _lastPhotoTimer = 0;
function photoSelected(im) {
  if (!im) return;
  im.lastUsed = performance.now();
  if (im.w > 1) warmBrushes(im);                     // otherwise once its size is known
  if (!im.path) { loadPillSync(); return; }
  if (typeof FOLDER !== 'undefined' && FOLDER.dir) {
    const i = FOLDER.files.findIndex(f => f.path === im.path);
    if (i >= 0) FOLDER.cur = i;
  }
  // only the photo on screen is worth a full demosaic; stop one that was running for another,
  // and stop half-size decodes for photos you've already moved well past
  const at = typeof FOLDER !== 'undefined' && FOLDER.dir ? FOLDER.files.findIndex(f => f.path === im.path) : -1;
  const near = p => {
    if (at < 0) return false;
    const k = FOLDER.files.findIndex(f => f.path === p);
    return k >= 0 && Math.abs(k - at) <= 3;
  };
  for (const other of PHOTOS.values()) {
    if (other === im || other.pin) continue;
    if (other.jobs.full) cancelJobs(other, 'full');
    if (other.jobs.half && !near(other.path)) cancelJobs(other, 'half');
  }
  want(im, 'half', 0);
  want(im, 'full', 0);
  clearTimeout(_neighbourTimer);
  _neighbourTimer = setTimeout(() => prefetchAround(im), 250);
  clearTimeout(_lastPhotoTimer);
  _lastPhotoTimer = setTimeout(() => N.storeSet({ lastPhoto: im.path }), 1500);
  trimMemory();
  loadPillSync();
}

/* the next frames you're likely to look at, decoded at half size while you look at this one */
function prefetchAround(im) {
  if (typeof FOLDER === 'undefined' || !FOLDER.dir || im !== IM()) return;
  const i = FOLDER.files.findIndex(f => f.path === im.path);
  if (i < 0) return;
  const near = [i + 1, i - 1, i + 2, i + 3, i - 2].filter(k => k >= 0 && k < FOLDER.files.length);
  const keep = new Set([im.path]);
  near.forEach((k, n) => {
    const f = FOLDER.files[k];
    keep.add(f.path);
    want(photoEntrySync(f.path, f.name), 'half', 10 + n);
  });
  for (const other of PHOTOS.values()) {
    if (keep.has(other.path) || other.pin) continue;
    const j = other.jobs.half;
    if (j && RAW.waiting.includes(j)) cancelJobs(other, 'half');
  }
}

/* a quiet pill in the corner instead of a screen-covering spinner */
function loadPillSync() {
  const pill = document.getElementById('loadpill');
  if (!pill) return;
  const im = IM();
  let msg = '';
  if (im && im.path) {
    const busyHalf = im.jobs.half || im.jobs.load || im.jobs.preview;
    if (rank(im) < RANK.half && (busyHalf || im.stage === 'cold')) msg = im.kind === 'raw' ? 'Developing raw' : 'Loading';
    else if (im.stage === 'half' && im.jobs.full && A.view.zoom > (A.view.fitZoom || 0) * 1.05) msg = 'Loading full resolution';
  }
  pill.hidden = !msg;
  if (msg) pill.querySelector('span').textContent = msg;
}

/* while a photo has no pixels yet, show its thumbnail where it will appear */
function placeholderSync(im) {
  const ph = document.getElementById('placeholder');
  if (!ph) return;
  const src = im && !im.tex ? (im.devThumb || (typeof THUMBS !== 'undefined' && THUMBS.get(im.path)) || im.thumb) : null;
  if (!src) { ph.hidden = true; ph.removeAttribute('src'); return; }
  if (ph.getAttribute('src') !== src) ph.src = src;
  ph.hidden = false;
}

addEventListener('beforeunload', () => { try { flushEditsSync(); } catch (e) { console.error(e); } });
