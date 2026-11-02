/* ============================================================
   batchdenoise.js — denoise a whole folder in the background
   ------------------------------------------------------------
   One button (Denoise all, or File → Denoise every raw in this
   folder) queues every raw in the workspace. Each one is decoded
   by the usual raw workers, denoised by denoiseworker.js, and
   written back as a denoised linear raw (.fedr) under the same
   name. The new file takes the raw's place in the folder; the raw
   moves into an Originals folder beside it, never deleted.

   Your edits carry over: the denoised file holds the same linear
   pixels at the same exposure, so the look you had on the raw fits
   it exactly. A photo you are editing when its turn comes keeps its
   settings, paint and undo history and just gets cleaner pixels.

   A small pill in the corner of the photo shows progress, with
   pause and stop. Nothing here blocks the rest of the app.
   ============================================================ */
'use strict';

const BD = {
  items: [],              // { raw, name, status: queued|working|done|failed, error }
  state: new Map(),       // raw path -> status, for the filmstrip badges
  running: false, paused: false, stopping: false,
  worker: null, ready: null, label: '',
  cur: null, frac: 0, secs: [], decodeSecs: [], waitSecs: [], saveSecs: [], lastStats: '',
  opts: { strength: 1, device: 'auto', model: null },
  doneCount: 0, failed: [], started: 0,
  decodes: new Map(),     // item -> decode in flight
  hideTimer: 0
};

const bdBase = p => p.split(/[\\/]/).pop();
const bdStem = n => n.replace(/\.[^.]+$/, '');

/* ---------- what's to do ---------- */
function bdCandidates() {
  if (!FOLDER.dir) return [];
  const fedr = new Set(FOLDER.files.filter(f => /\.fedr$/i.test(f.name)).map(f => bdStem(f.name).toLowerCase()));
  return FOLDER.files.filter(f => RAWRE.test(f.name) && !fedr.has(bdStem(f.name).toLowerCase()));
}

/* ---------- the worker ---------- */
async function bdModelRecord(key) {
  if (!key || key === BUILTIN_DENOISE) {
    const onnx = await N.readAsset('vendor/models/scunet_color_real_psnr.onnx');
    const data = await N.readAsset('vendor/models/scunet_color_real_psnr.onnx.data');
    if (!onnx || !data) throw new Error('the bundled denoise model is missing from this build');
    return { key: BUILTIN_DENOISE, main: new Uint8Array(onnx.bytes), ext: [{ path: 'scunet_color_real_psnr.onnx.data', data: new Uint8Array(data.bytes) }] };
  }
  let rec = await modelGet(key);
  if (!rec) throw new Error('model "' + key + '" is not installed');
  if (rec instanceof Uint8Array || rec instanceof ArrayBuffer) rec = { main: rec, ext: [] };
  return { key, main: rec.main, ext: rec.ext || [] };
}

/* A GPU session on the page itself. WebGPU from the page is the path the
   one-photo denoise has always used; from a worker it can quietly end up on
   the CPU instead. Only a session that really came up on WebGPU is kept. */
async function bdPageSession(rec) {
  if (BD.opts.device === 'cpu') return null;
  try {
    if (!(await haveWebGPU())) return null;
    const ort = await ensureOrt();
    const opts = { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' };
    if (rec.ext && rec.ext.length) opts.externalData = rec.ext.map(e => ({ path: e.path, data: e.data }));
    const sess = await ort.InferenceSession.create(rec.main, opts);
    if (!webgpuLive(ort)) { await sess.release().catch(() => { }); return null; }
    return sess;
  } catch (e) {
    console.warn('batch denoise: no GPU session on the page, trying the worker', e);
    return null;
  }
}

function bdStartWorker() {
  if (BD.ready) return BD.ready;
  BD.ready = (async () => {
    const rec = await bdModelRecord(BD.opts.model);
    BD.pageSess = BD.pageSess || await bdPageSession(rec);
    if (BD.pageSess) {
      // the network runs here on the GPU; the worker only does the per-pixel work around it
      const w = new Worker('denoiseworker.js');
      BD.worker = w; BD.mode = 'page'; BD.label = 'GPU';
      w.onmessage = e => bdOnMessage(e.data);
      w.onerror = ev => { ev.preventDefault(); bdWorkerDied(ev.message || 'the denoise worker stopped'); };
      console.log('batch denoise: network on the GPU (WebGPU, page)');
      return w;
    }
    BD.mode = 'worker';
    const base = new URL('vendor/ort/', document.baseURI).href;
    let wasmPaths = base, threads = 1;
    const cores = navigator.hardwareConcurrency || 2;
    // the same blob trick as ai.js: the threaded runtime can't fetch its module from file://
    if (typeof SharedArrayBuffer !== 'undefined' && cores > 2) {
      try {
        const r = await N.readAsset('vendor/ort/ort-wasm-simd-threaded.jsep.mjs');
        if (r && r.bytes) {
          const mjs = URL.createObjectURL(new Blob([r.bytes], { type: 'text/javascript' }));
          wasmPaths = { mjs, wasm: base + 'ort-wasm-simd-threaded.jsep.wasm' };
          threads = Math.min(8, cores - 2);              // as many as the one-photo denoise uses
        }
      } catch (e) { console.warn('batch denoise: threaded runtime unavailable', e); }
    }
    const w = new Worker('denoiseworker.js');
    BD.worker = w;
    const answer = new Promise((res, rej) => {
      w.onmessage = e => {
        const d = e.data;
        if (d.type === 'ready') { BD.label = d.label; res(w); }
        else if (d.type === 'fatal') rej(new Error(d.error));
        else bdOnMessage(d);
      };
      w.onerror = ev => { ev.preventDefault(); rej(new Error(ev.message || 'the denoise worker could not start')); };
    });
    w.postMessage({ type: 'setup', main: rec.main, ext: rec.ext, device: BD.opts.device, wasmPaths, threads });
    await answer;
    w.onerror = ev => { ev.preventDefault(); bdWorkerDied(ev.message || 'the denoise worker stopped'); };
    console.log('batch denoise: network in the worker on', BD.label);
    return w;
  })();
  BD.ready.catch(() => { BD.ready = null; if (BD.worker) BD.worker.terminate(); BD.worker = null; });
  return BD.ready;
}

function bdStopWorker() {
  if (BD.worker) BD.worker.terminate();
  BD.worker = null; BD.ready = null;
  if (BD.pending) { BD.pending.reject(new Error('cancelled')); BD.pending = null; }
  bdReleasePage();
}

/* the page session is let go only once no tile is in flight on it */
function bdReleasePage() {
  if (!BD.pageSess) return;
  if (BD.pageBusy) { BD.releaseAfter = true; return; }
  const s = BD.pageSess;
  BD.pageSess = null; BD.releaseAfter = false;
  s.release().catch(() => { });
}

function bdWorkerDied(msg) {
  console.error('denoise worker died:', msg);
  const p = BD.pending;
  BD.pending = null;
  BD.worker = null; BD.ready = null;
  if (p) p.reject(new Error(/memory/i.test(msg) ? 'ran out of memory on this frame' : msg));
}

function bdOnMessage(d) {
  const p = BD.pending;
  if (!p || d.id !== p.id) return;
  if (d.type === 'progress') { BD.frac = d.f; bdPill(); }
  else if (d.type === 'done' || d.type === 'prepped' || d.type === 'finished') { BD.pending = null; p.resolve(d); }
  else if (d.type === 'failed') { BD.pending = null; p.reject(new Error(d.error)); }
}

let _bdSeq = 0;
function bdAsk(msg, transfer) {
  return new Promise((resolve, reject) => {
    if (!BD.worker) { reject(new Error('cancelled')); return; }
    BD.pending = { id: msg.id, resolve, reject };
    BD.worker.postMessage(msg, transfer);
  });
}

async function bdCheckpoint() {
  await new Promise(r => setTimeout(r, 0));
  while (BD.paused && !BD.stopping) await new Promise(r => { BD.pageWake = r; });
  if (BD.stopping || !BD.pageSess) throw new Error('cancelled');
}

/* the GPU path: prepare in the worker, run the network here, finish in the worker */
async function bdDenoisePage(frame) {
  const id = ++_bdSeq;
  const prepped = await bdAsk({ type: 'prep', id, rgba: frame.rgba, w: frame.w, h: frame.h, exposure: frame.exposure }, [frame.rgba]);
  BD.pageBusy = true;
  let out, secs;
  try {
    const ctx = {
      ort: AI.ort, session: BD.pageSess, backend: 'webgpu', overlap: 96, tile: BD.tile || 0,
      progress: f => { BD.frac = f; bdPill(); },
      checkpoint: bdCheckpoint
    };
    const t0 = performance.now();
    out = await DNC.runModel(ctx, new Float32Array(prepped.src.buffer || prepped.src), frame.w, frame.h);
    BD.tile = ctx.tile;
    secs = (performance.now() - t0) / 1000;
  } finally {
    BD.pageBusy = false;
    if (BD.releaseAfter) bdReleasePage();
  }
  const rgba = prepped.rgba.buffer || prepped.rgba;
  const fin = await bdAsk(Object.assign({}, frame, { type: 'finish', id: ++_bdSeq, rgba, out: out.buffer, gain: prepped.gain, secs, device: 'GPU' }), [rgba, out.buffer]);
  return { head: fin.head, rgba: fin.rgba, secs, gain: prepped.gain };
}

function bdDenoiseFrame(frame) {
  if (BD.mode === 'page' && BD.pageSess) return bdDenoisePage(frame);
  return new Promise((resolve, reject) => {
    BD.pending = { id: ++_bdSeq, resolve, reject };
    BD.worker.postMessage(Object.assign({ type: 'frame', id: BD.pending.id }, frame), [frame.rgba]);
    if (BD.paused) BD.worker.postMessage({ type: 'pause' });
  });
}

/* ---------- decoding ----------
   The batch decodes in a raw worker of its own rather than through the app's
   shared queue. In that queue the photo you click on takes a busy decoder from
   background work and the background job starts over, so editing while a batch
   ran kept throwing away 20-30 s decodes. Here nothing can bump it. */
function bdDecode(item) {
  let worker = null, cancelled = false;
  const p = (async () => {
    const t0 = performance.now();
    const [f] = await N.readFiles([item.raw]);
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

/* A raw takes ~20-30 s to decode, often as long as the network takes on a GPU.
   On a desktop the next two are decoded while one denoises, so the GPU never
   waits; a smaller machine keeps one ahead to stay within its memory. */
const BD_AHEAD = (navigator.hardwareConcurrency || 4) >= 6 && (navigator.deviceMemory || 4) >= 8 ? 2 : 1;
function bdDecodeAhead(item) {
  if (!BD.decodes.has(item)) BD.decodes.set(item, bdDecode(item));
  if (BD.paused) return;
  let n = 0;
  for (const it of BD.items) {
    if (it === item || it.status !== 'queued') continue;
    if (n++ >= BD_AHEAD) break;
    if (!BD.decodes.has(it)) BD.decodes.set(it, bdDecode(it));
  }
}
function bdCancelDecodes() {
  for (const p of BD.decodes.values()) p.cancel();
  BD.decodes.clear();
}

/* ---------- saving ----------
   Packing a frame and writing it run beside the next frame's denoise. */
function bdEncode(head, rgba) {
  return new Promise((res, rej) => {
    const w = new Worker('fedrworker.js');
    w.onmessage = e => { w.terminate(); e.data.ok ? res(e.data) : rej(new Error(e.data.error)); };
    w.onerror = ev => { ev.preventDefault(); w.terminate(); rej(new Error(ev.message || 'could not pack the file')); };
    w.postMessage({ type: 'encode', head, rgba: rgba.buffer }, [rgba.buffer]);
  });
}

async function bdSave(item, out, w, h) {
  const t0 = performance.now();
  try {
    const packed = await bdEncode(out.head, out.rgba instanceof Uint16Array ? out.rgba : new Uint16Array(out.rgba));
    // whatever was just changed on this photo is on disk before its record moves
    const live = PHOTOS.get(item.raw);
    if (live) persistNow(live);
    const res = await N.denoiseCommit(item.raw, packed.file);
    if (!res || !res.ok) throw new Error(res ? res.error : 'could not write the denoised file');
    BD.doneCount++;
    bdSet(item, 'done');
    bdSwapped(item.raw, res.fedr, res.original, { w, h, rgba: packed.rgba.buffer });
    BD.saveSecs.push((performance.now() - t0) / 1000);
  } catch (e) {
    console.error('batch denoise: saving failed', item.raw, e);
    item.error = String(e && e.message || e);
    BD.failed.push(item);
    bdSet(item, 'failed');
  }
  bdPill();
}

/* the exposure the photo is being edited at, so the network sees the noise as you will */
function bdExposure(path) {
  const im = PHOTOS.get(path);
  if (im && im.s) return im.s.exposure || 0;
  const rec = RECORDS.get(path);
  return rec && rec.settings ? rec.settings.exposure || 0 : 0;
}

/* ---------- the queue ---------- */
function bdNext(after) {
  return BD.items.find(it => it.status === 'queued' && it !== after) || null;
}

function bdSet(item, status) {
  item.status = status;
  if (status === 'queued' || status === 'working') BD.state.set(item.raw, status);
  else BD.state.delete(item.raw);
  bdBadge(item.raw);
}

async function bdRun() {
  if (BD.running) return;
  BD.running = true; BD.stopping = false;
  BD.started = BD.started || Date.now();
  bdPill();
  try {
    await bdStartWorker();
  } catch (e) {
    BD.running = false;
    bdClear();
    showError('Batch denoise could not start', [String(e.message)]);
    return;
  }
  bdPill();
  let saving = Promise.resolve();
  while (!BD.stopping) {
    while (BD.paused && !BD.stopping) await new Promise(r => { BD.wake = r; });
    if (BD.stopping) break;
    const item = bdNext();
    if (!item) break;
    BD.cur = item; BD.frac = 0;
    bdSet(item, 'working');
    bdPill();
    try {
      // the decode for this one was usually started while earlier ones were denoising
      bdDecodeAhead(item);
      const dec = BD.decodes.get(item);
      const tw = performance.now();
      const r = await dec;
      BD.decodes.delete(item);
      BD.waitSecs.push((performance.now() - tw) / 1000);
      BD.decodeSecs.push(r.decodeSecs || 0);
      if (BD.stopping) break;
      bdDecodeAhead(item);
      if (!BD.worker || (BD.mode === 'page' && !BD.pageSess)) await bdStartWorker();   // a worker that died on the last frame
      const meta = Object.assign({}, r.meta || {});
      if (r.exif) meta.exif = r.exif;
      const out = await bdDenoiseFrame({
        w: r.w, h: r.h, rgba: r.rgba.buffer, meta,
        name: bdStem(item.name), from: item.name,
        exposure: bdExposure(item.raw),
        strength: BD.opts.strength, model: BD.opts.model || BUILTIN_DENOISE
      });
      r.rgba = null;
      BD.secs.push(out.secs);
      console.log(`batch denoise: ${item.name} · decode ${(r.decodeSecs || 0).toFixed(1)}s (waited ${BD.waitSecs[BD.waitSecs.length - 1].toFixed(1)}s) · denoise ${out.secs.toFixed(1)}s on ${BD.label}`);
      // the next frame starts denoising while this one is packed and written;
      // only one waits to be written at a time, to keep memory in check
      await saving;
      saving = bdSave(item, out, r.w, r.h);
      if (BD.stopping) break;
    } catch (e) {
      if (String(e && e.message) === 'cancelled' || BD.stopping) break;
      console.error('batch denoise failed', item.raw, e);
      item.error = String(e && e.message || e);
      BD.failed.push(item);
      bdSet(item, 'failed');
    }
    BD.cur = null; BD.frac = 0;
    bdPill();
  }
  BD.cur = null;
  bdCancelDecodes();
  bdStopWorker();
  bdPill();
  await saving;                         // a finished frame still gets written, even after Stop
  BD.running = false;
  bdFinished();
}

/* ---------- the swap ---------- */
function bdSwapped(raw, fedr, original, pixels) {
  const name = bdBase(fedr);
  // the strip keeps the camera's preview until the denoised file has a thumbnail of its own
  const thumbURL = THUMBS.get(raw);
  rekeyPhoto(raw, fedr, name, pixels);
  if (thumbURL) fetch(thumbURL).then(r => r.arrayBuffer()).then(b => N.thumbPut(fedr, new Uint8Array(b))).catch(() => { });

  const dir = raw.slice(0, Math.max(raw.lastIndexOf('/'), raw.lastIndexOf('\\')));
  if (FOLDER.dir === dir) {
    for (const f of FOLDER.files) if (f.path === raw) { f.path = fedr; f.name = name; }
    if (original && !FOLDER.folders.some(f => f.path === original.slice(0, original.length - bdBase(original).length - 1))) {
      const od = original.slice(0, original.length - bdBase(original).length - 1);
      FOLDER.folders.push({ name: bdBase(od), path: od });
      FOLDER.folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    }
    if (typeof _pathKey !== 'undefined') _pathKey = '';
    if (typeof CULL !== 'undefined' && CULL.picks.has(raw)) { CULL.picks.delete(raw); CULL.picks.add(fedr); savePicks(); }
    sortFiles();
    const strip = document.getElementById('strip');
    const top = strip ? strip.scrollTop : 0;
    renderFolder();
    if (strip) strip.scrollTop = top;
  } else if (typeof CULL !== 'undefined' && CULL.stored[dir]) {
    CULL.stored[dir] = CULL.stored[dir].map(p => p === raw ? fedr : p);
    N.storeSet({ cullPicks: CULL.stored });
  }
  for (const t of WS.tabs) if (t.cur === raw) t.cur = fedr;
  saveTabs();
  const im = IM();
  if (im && im.path === fedr) {
    if (typeof updateCapture === 'function') updateCapture();
    requestRender(false);
  }
}

/* ---------- controls ---------- */
function bdPause(on) {
  BD.paused = on;
  if (BD.worker) BD.worker.postMessage({ type: on ? 'pause' : 'resume' });
  if (!on && BD.wake) { BD.wake(); BD.wake = null; }
  if (!on && BD.pageWake) { BD.pageWake(); BD.pageWake = null; }
  bdPill();
}

function bdStop() {
  BD.stopping = true;
  BD.paused = false;
  if (BD.wake) { BD.wake(); BD.wake = null; }
  if (BD.pageWake) { BD.pageWake(); BD.pageWake = null; }
  bdCancelDecodes();
  bdStopWorker();
  for (const it of BD.items) if (it.status === 'queued' || it.status === 'working') bdSet(it, 'stopped');
  if (!BD.running) bdFinished();
}

function bdClear() {
  for (const p of [...BD.state.keys()]) { BD.state.delete(p); bdBadge(p); }
  BD.items = []; BD.secs = []; BD.decodeSecs = []; BD.waitSecs = []; BD.saveSecs = [];
  BD.failed = []; BD.doneCount = 0; BD.started = 0;
  BD.paused = false; BD.stopping = false;
  bdPill();
}

function bdFinished() {
  const done = BD.doneCount, failed = BD.failed.slice(), stopped = BD.stopping;
  const left = BD.items.filter(it => it.status === 'stopped').length;
  const mins = BD.started ? Math.round((Date.now() - BD.started) / 60000) : 0;
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const each = done ? (Date.now() - BD.started) / 1000 / done : 0;
  // where the time went, per photo — hover the pill to see it
  BD.lastStats = done ? `~${Math.round(each)}s per photo on ${BD.label || '?'} · denoise ${avg(BD.secs).toFixed(0)}s, ` +
    `raw decode ${avg(BD.decodeSecs).toFixed(0)}s (waited ${avg(BD.waitSecs).toFixed(0)}s), saving ${avg(BD.saveSecs).toFixed(0)}s` : '';
  if (BD.lastStats) console.log('batch denoise:', BD.lastStats);
  BD.items = []; BD.secs = []; BD.decodeSecs = []; BD.waitSecs = []; BD.saveSecs = []; BD.doneCount = 0; BD.started = 0;
  BD.paused = false; BD.stopping = false;
  for (const p of [...BD.state.keys()]) { BD.state.delete(p); bdBadge(p); }
  BD.failed = failed;
  let msg = stopped
    ? `Stopped · ${done} denoised, ${left} left as they were`
    : `Denoised ${done} photo${done === 1 ? '' : 's'}${mins ? ` in ${mins} min` : ''}`;
  if (done && each) msg += ` · ~${Math.round(each)}s each on ${BD.label === 'GPU' ? 'GPU' : 'CPU'}`;
  if (failed.length) msg += ` · ${failed.length} failed`;
  bdPill(msg);
}

/* ---------- start ---------- */
function bdStartDialog() {
  if (!window.native) return;
  if (!FOLDER.dir) { toast('Open a folder first'); return; }
  const list = bdCandidates().filter(f => !BD.items.some(it => it.raw === f.path && (it.status === 'queued' || it.status === 'working')));
  if (!list.length) {
    toast(BD.running ? 'Every raw here is already queued' : 'No raws left to denoise in this folder');
    return;
  }
  if (BD.running) {                      // already going: just add this folder's raws to the end
    for (const f of list) { const it = { raw: f.path, name: f.name, status: 'queued' }; BD.items.push(it); bdSet(it, 'queued'); }
    toast(`Added ${list.length} raw${list.length === 1 ? '' : 's'} to the denoise queue`);
    bdPill();
    return;
  }
  modelList().then(installed => {
    installed = installed.filter(k => k !== '__subject__');
    const n = list.length;
    document.getElementById('card').innerHTML = `
      <h4>Denoise ${n} raw${n === 1 ? '' : 's'} in ${esc(FOLDER.name)}</h4>
      <div class="cbody">
        <div class="hint">Runs in the background — keep editing while it works. Each raw is replaced in
        this folder by a denoised linear raw (<b>.fedr</b>) with the same name and your edits; the original
        raw moves into an <b>Originals</b> folder here, so nothing is lost.</div>
        <div class="field"><span>Model</span><select id="bdModel">
          <option value="${BUILTIN_DENOISE}">SCUNet colour (built in)</option>
          ${installed.map(k => `<option>${esc(k)}</option>`).join('')}
        </select></div>
        <div class="field"><span>Strength</span><input type="number" id="bdStr" min="10" max="100" step="5" value="${Math.round((BD.opts.strength || 1) * 100)}"></div>
        <div class="field"><span>Device</span><select id="bdDev">
          <option value="auto">Auto (GPU if available)</option><option value="gpu">GPU</option><option value="cpu">CPU</option>
        </select></div>
        <div class="hint">Raws that already have a .fedr beside them are skipped. JPEGs are left alone.</div>
      </div>
      <div class="foot">
        <button class="tb" id="bdCancel">Cancel</button>
        <button class="tb primary" id="bdGo">Denoise ${n} photo${n === 1 ? '' : 's'}</button>
      </div>`;
    document.getElementById('bdDev').value = BD.opts.device || AI.device || 'auto';
    if (BD.opts.model && installed.includes(BD.opts.model)) document.getElementById('bdModel').value = BD.opts.model;
    const modal = document.getElementById('modal');
    modal.classList.add('open');
    document.getElementById('bdCancel').onclick = () => modal.classList.remove('open');
    document.getElementById('bdGo').onclick = () => {
      BD.opts = {
        model: document.getElementById('bdModel').value,
        strength: Math.max(.1, Math.min(1, (parseInt(document.getElementById('bdStr').value) || 100) / 100)),
        device: document.getElementById('bdDev').value
      };
      N.storeSet({ batchDenoise: BD.opts });
      modal.classList.remove('open');
      bdQueue(bdCandidates());
    };
  });
}

function bdQueue(files) {
  BD.failed = [];
  clearTimeout(BD.hideTimer);
  for (const f of files) {
    if (BD.items.some(it => it.raw === f.path && it.status === 'queued')) continue;
    const it = { raw: f.path, name: f.name, status: 'queued' };
    BD.items.push(it);
    bdSet(it, 'queued');
  }
  bdRun();
}

/* ---------- the pill ---------- */
function bdFmtMins(s) {
  if (s < 90) return Math.max(1, Math.round(s)) + 's';
  const m = Math.round(s / 60);
  return m < 90 ? m + ' min' : (m / 60).toFixed(1) + ' h';
}

function bdPill(finalMsg) {
  const pill = document.getElementById('dnpill');
  if (!pill) return;
  clearTimeout(BD.hideTimer);
  const t = pill.querySelector('.t'), bar = pill.querySelector('.bar b');
  const pause = document.getElementById('dnPause'), stop = document.getElementById('dnStop');
  if (finalMsg) {
    pill.hidden = false;
    pill.classList.add('final');
    pill.classList.toggle('bad', BD.failed.length > 0);
    t.textContent = finalMsg;
    bar.style.width = '100%';
    pause.hidden = true;
    stop.textContent = '×'; stop.title = 'Dismiss';
    pill.title = (BD.lastStats || '') + (BD.failed.length ? (BD.lastStats ? '\n' : '') + 'Click to see what failed' : '');
    if (!BD.failed.length) BD.hideTimer = setTimeout(() => { pill.hidden = true; }, 8000);
    return;
  }
  const active = BD.items.filter(it => it.status !== 'stopped');
  if (!BD.running || !active.length) { pill.hidden = true; return; }
  pill.hidden = false;
  pill.classList.remove('final', 'bad');
  pill.classList.toggle('paused', BD.paused);
  pause.hidden = false;
  pause.textContent = BD.paused ? '▶' : '❚❚';
  pause.title = BD.paused ? 'Resume' : 'Pause';
  stop.textContent = '■'; stop.title = 'Stop — photos already denoised stay denoised';
  const total = active.length;
  const finished = active.filter(it => it.status === 'done' || it.status === 'failed').length;
  const pos = Math.min(total, finished + (BD.cur ? 1 : 0));
  let msg;
  if (!BD.worker && !BD.label) msg = 'Starting denoise…';
  else if (BD.paused) msg = `Paused · ${finished} of ${total} done`;
  else if (BD.cur && BD.frac === 0) msg = `Denoise ${pos}/${total} · decoding ${BD.cur.name}`;
  else if (BD.cur) msg = `Denoise ${pos}/${total} · ${BD.cur.name} · ${Math.round(BD.frac * 100)}%`;
  else msg = `Denoise ${finished}/${total}`;
  if (BD.label && !BD.paused) msg += ' · ' + (BD.label === 'GPU' ? 'GPU' : 'CPU');
  if (BD.secs.length && !BD.paused) {
    const avg = BD.secs.reduce((a, b) => a + b, 0) / BD.secs.length;
    const left = (total - finished - BD.frac) * avg;
    if (left > 5) msg += ` · ~${bdFmtMins(left)} left`;
  }
  if (BD.failed.length) msg += ` · ${BD.failed.length} failed`;
  t.textContent = msg;
  pill.title = BD.label ? 'Running on ' + BD.label + (BD.secs.length ? ` · last frame: denoise ${BD.secs[BD.secs.length - 1].toFixed(0)}s, raw decode ${BD.decodeSecs[BD.decodeSecs.length - 1].toFixed(0)}s` : '') : '';
  bar.style.width = (100 * (finished + BD.frac) / total).toFixed(1) + '%';
}

function bdShowFailures() {
  if (!BD.failed.length) return;
  showError(`${BD.failed.length} photo${BD.failed.length === 1 ? '' : 's'} could not be denoised`,
    BD.failed.map(f => esc(f.name) + ' — ' + esc(f.error || 'unknown error')));
}

/* ---------- filmstrip badges ---------- */
function bdThumbClass(path) {
  const s = BD.state.get(path);
  return s === 'working' ? 'dn-working' : s === 'queued' ? 'dn-queued' : '';
}
function bdBadge(path) {
  const el = typeof THUMB_EL !== 'undefined' && THUMB_EL.get(path);
  if (!el) return;
  const s = BD.state.get(path);
  el.classList.toggle('dn-queued', s === 'queued');
  el.classList.toggle('dn-working', s === 'working');
}

/* ---------- wiring ---------- */
document.addEventListener('DOMContentLoaded', () => {
  if (!window.native) return;
  N.storeGet().then(st => { if (st && st.batchDenoise) BD.opts = Object.assign(BD.opts, st.batchDenoise); });
  document.querySelectorAll('.bdBtn').forEach(b => { b.onclick = bdStartDialog; });
  document.getElementById('dnPause').onclick = e => { e.stopPropagation(); bdPause(!BD.paused); };
  document.getElementById('dnStop').onclick = e => {
    e.stopPropagation();
    if (BD.running) bdStop();
    else { document.getElementById('dnpill').hidden = true; BD.failed = []; }
  };
  const pill = document.getElementById('dnpill');
  pill.onclick = () => bdShowFailures();
  // the stage captures the pointer for panning, which would swallow clicks on the pill's buttons
  pill.addEventListener('pointerdown', e => e.stopPropagation());
  N.onMenu(cmd => { if (cmd === 'denoise-folder') bdStartDialog(); });
  // closing the window mid-run: the photos already swapped are done; the rest stay raws
  addEventListener('beforeunload', () => { if (BD.worker) BD.worker.terminate(); });
});
