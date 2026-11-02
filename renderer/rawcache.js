/* ============================================================
   rawcache.js — decode a folder's raws once, open them in a moment
   ------------------------------------------------------------
   Demosaicing a raw takes 20-30 s. When a folder opens, its raws are
   decoded in the background — starting from the photo you're on and
   working outwards — and each result is kept on disk as a compressed
   linear .fedr in the app's data folder. Opening a raw that has been
   decoded skips the decoder entirely: the camera JPEG shows at once
   and the full-resolution pixels follow a second or two later.

   A raw you open yourself is cached by its own full decode, so the
   second visit is quick even before the background pass reaches it.
   The cache is keyed by path, size and modification time, and trims
   itself in the main process (main.js) to a size that fits the drive.
   ============================================================ */
'use strict';

const DECODED = new Set();              // paths known to be in the cache
const PRE = {
  gen: 0, queue: [], inflight: new Map(),   // path -> promise of (decode + store)
  total: 0, cached: 0, folder: null
};
const PRE_LANES = (navigator.hardwareConcurrency || 4) >= 8 ? 2 : 1;

/* ---------- decoding outside the shared queue ----------
   The app's decode queue lets the photo on screen take a busy decoder from
   background work, which then starts over; background passes use their own
   worker so nothing they've done is ever thrown away. */
function decodeRawDetached(path) {
  let worker = null, cancelled = false;
  const p = (async () => {
    const t0 = performance.now();
    const [f] = await N.readFiles([path]);
    if (!f) throw new Error('could not read the file');
    if (cancelled) throw new Error('cancelled');
    let exif = null;
    try { exif = typeof parseExif === 'function' ? parseExif(new Uint8Array(f.bytes).subarray(0, 384 * 1024)) : null; } catch { exif = null; }
    const buf = standalone(f.bytes);
    const r = await new Promise((res, rej) => {
      worker = new Worker('rawworker.js');
      worker.onmessage = e => e.data.ok ? res(e.data) : rej(new Error(e.data.error));
      worker.onerror = ev => { ev.preventDefault(); rej(new Error(ev.message || 'the raw decoder stopped')); };
      worker.postMessage({ id: 1, bytes: buf, half: false, maxTex: maxTexture(), skipIdentify: false }, [buf]);
    });
    if (worker) worker.terminate();          // hands the decoder's heap straight back
    worker = null;
    if (cancelled) throw new Error('cancelled');
    return Object.assign(r, { exif, decodeSecs: (performance.now() - t0) / 1000 });
  })();
  p.cancel = () => { cancelled = true; if (worker) worker.terminate(); worker = null; };
  p.catch(() => { if (worker) worker.terminate(); });
  return p;
}

/* pack linear half floats as a compressed .fedr, in a worker; the pixels come back too */
function encodeFedrBytes(head, rgba) {
  return new Promise((res, rej) => {
    const w = new Worker('fedrworker.js');
    w.onmessage = e => { w.terminate(); e.data.ok ? res(e.data) : rej(new Error(e.data.error)); };
    w.onerror = ev => { ev.preventDefault(); w.terminate(); rej(new Error(ev.message || 'could not pack the file')); };
    w.postMessage({ type: 'encode', head, rgba: rgba.buffer }, [rgba.buffer]);
  });
}

/* ---------- the cache ---------- */
/* r: { w, h, rgba (Uint16Array, given up), meta, exif } */
async function cacheDecoded(path, r) {
  if (!window.native || !path || DECODED.has(path)) return false;
  try {
    const head = {
      width: r.w, height: r.h, colorspace: 'srgb-linear', format: 'rgba16f', version: 2,
      compression: 'deflate-shuffle', source: 'safelight decode cache',
      meta: r.meta || null, exif: r.exif || null, reduced: r.reduced || 1
    };
    const packed = await encodeFedrBytes(head, r.rgba instanceof Uint16Array ? r.rgba : new Uint16Array(r.rgba));
    const ok = await N.decodedPut(path, packed.file);
    if (ok) DECODED.add(path);
    return ok;
  } catch (e) {
    console.warn('could not cache the decode of', path, e && e.message);
    return false;
  }
}

/* -> { w, h, rgba, meta, exif } or null */
async function loadDecoded(path) {
  const t0 = performance.now();
  const g = await N.decodedGet(path);
  if (!g || !g.bytes) { DECODED.delete(path); return null; }
  const { head, data } = await readFedr(new Uint8Array(g.bytes));
  return { w: head.width, h: head.height, rgba: data, meta: head.meta || {}, exif: head.exif || null, reduced: head.reduced || 1, decodeSecs: (performance.now() - t0) / 1000, cached: true };
}

/* the loader's path for a raw that's in the cache: straight to full resolution */
async function loadCachedRaw(im, stage, prio) {
  try {
    const r = await loadDecoded(im.path);
    if (!r) throw new Error('no longer cached');
    if (!alive(im) || rank(im) >= RANK.full) return;
    const tex = await uploadHalfFloat(r.w, r.h, r.rgba);
    r.rgba = null;
    if (!alive(im) || rank(im) >= RANK.full) { gl.deleteTexture(tex); return; }
    noteMeta(im, r.meta);
    if (r.exif && !im.exif) { im.exif = r.exif; im.capture = null; if (im === IM() && typeof updateCapture === 'function') updateCapture(); }
    installTexture(im, tex, r.w, r.h, 'full', r.w * r.h * 8);
  } catch (e) {
    // fall back to the ordinary decode
    console.warn('cached decode unavailable for', im.path, e && e.message);
    DECODED.delete(im.path);
    delete im.jobs.cache;
    if (alive(im)) want(im, stage, prio);
  } finally {
    delete im.jobs.cache;
  }
}

/* ---------- the background pass over a folder ---------- */
async function precacheFolder() {
  if (!window.native || !FOLDER.dir) return;
  const gen = ++PRE.gen;
  const raws = FOLDER.files.filter(f => RAWRE.test(f.name)).map(f => f.path);
  const here = new Set(raws);
  // decodes for a folder you've left stop; one for this folder carries on
  for (const [p, job] of PRE.inflight) if (!here.has(p) && job.cancel) job.cancel();
  PRE.queue = [];
  PRE.folder = FOLDER.dir;
  let has = {};
  try { has = await N.decodedHas(raws); } catch { }
  if (gen !== PRE.gen) return;
  for (const p of raws) { if (has[p]) DECODED.add(p); else DECODED.delete(p); }
  // from the photo you're on, outwards: the ones you'll open next go first
  const cur = IM() && IM().path;
  let at = Math.max(0, raws.indexOf(cur));
  const order = [];
  for (let d = 0; order.length < raws.length; d++) {
    if (at + d < raws.length) order.push(raws[at + d]);
    if (d > 0 && at - d >= 0) order.push(raws[at - d]);
    if (at + d >= raws.length && at - d < 0) break;
  }
  PRE.queue = order.filter(p => !DECODED.has(p));
  PRE.total = raws.length;
  prePump();
}

function preSkip(p) {
  if (DECODED.has(p) || PRE.inflight.has(p)) return true;
  if (typeof BD !== 'undefined' && BD.state.has(p)) return true;          // about to become a denoised file
  const im = PHOTOS.get(p);
  return !!(im && (im.jobs.full || rank(im) >= RANK.full));               // its own full decode caches it
}

function prePump() {
  // a batch denoise is decoding too; one background decoder is plenty beside it
  const lanes = typeof BD !== 'undefined' && BD.running ? 1 : PRE_LANES;
  while (PRE.inflight.size < lanes && PRE.queue.length) {
    const p = PRE.queue.shift();
    if (preSkip(p)) continue;
    const dec = decodeRawDetached(p);
    const job = dec.then(r => cacheDecoded(p, r));
    job.cancel = dec.cancel;
    PRE.inflight.set(p, job);
    job.catch(e => { if (String(e && e.message) !== 'cancelled') console.warn('background decode failed', p, e && e.message); })
      .finally(() => { PRE.inflight.delete(p); preDone(p); prePump(); });
  }
  preSync();
}

/* a photo that was waiting for its background decode gets its pixels now */
function preDone(p) {
  const im = PHOTOS.get(p);
  if (!im || !im.cacheWait || !alive(im)) return;
  im.cacheWait = false;
  if (rank(im) < RANK.full && (im === IM() || im.pin || im.waiters.length)) want(im, 'full', 0);
}

/* a small note above the filmstrip, only while there's something to do */
function preSync() {
  const els = document.querySelectorAll('.cacheStat');
  if (!els.length) return;
  const here = FOLDER.dir === PRE.folder ? FOLDER.files.filter(f => RAWRE.test(f.name)) : [];
  const done = here.filter(f => DECODED.has(f.path)).length;
  const busy = PRE.inflight.size > 0 || PRE.queue.length > 0;
  const text = busy && here.length ? `Decoding ${Math.min(here.length, done + 1)}/${here.length}` : '';
  els.forEach(el => {
    el.hidden = !text;
    el.textContent = text;
    el.title = 'Raws in this folder are decoded in the background and kept, so each one opens in a moment';
  });
}

async function clearDecodedCache() {
  const u = await N.decodedUsage();
  await N.decodedClear();
  DECODED.clear();
  toast(`Cleared ${(u.bytes / 1024 ** 3).toFixed(1)} GB of decoded raws`);
  precacheFolder();
}

document.addEventListener('DOMContentLoaded', () => {
  if (!window.native) return;
  N.onMenu(cmd => { if (cmd === 'clear-decoded') clearDecodedCache(); });
});
