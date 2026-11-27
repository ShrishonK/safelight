/* ============================================================
   native.js — desktop layer
   Runs after app.js boot(): native dialogs, menus, raw decoding,
   preferences that survive a restart.
   ============================================================ */
'use strict';

const RAWRE = /\.(cr2|cr3|nef|arw|raf|rw2|orf|dng|pef|srw|raw|3fr|iiq|erf|mrw)$/i;
const N = window.native;
let PREFS = { halfRaw: false, exportPrefs: null, presets: {} };

/* ---------- busy overlay ---------- */
function busy(msg) {
  const b = document.getElementById('busy');
  if (msg) { document.getElementById('busyMsg').textContent = msg; b.classList.add('on'); }
  else b.classList.remove('on');
  return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/* ---------- half-float helpers ---------- */
const _f32 = new Float32Array(1), _i32 = new Int32Array(_f32.buffer);
function toHalf(v) {
  _f32[0] = v; const x = _i32[0];
  let bits = (x >> 16) & 0x8000, m = (x >> 12) & 0x07ff;
  const e = (x >> 23) & 0xff;
  if (e < 103) return bits;
  if (e > 142) return bits | 0x7c00;
  if (e < 113) { m |= 0x0800; return bits + (m >> (114 - e)) + ((m >> (113 - e)) & 1); }
  bits |= ((e - 112) << 10) | (m >> 1);
  return bits + (m & 1);
}

/* ---------- raw decoding (dcraw compiled to asm.js, bundled) ----------
   The decoder itself runs in rawworker.js; loader.js schedules it. */
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('could not load ' + src));
    document.head.append(s);
  });
}

function parsePPM(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let i = 0;
  const token = () => {
    while (i < b.length && (b[i] === 32 || b[i] === 10 || b[i] === 13 || b[i] === 9)) i++;
    if (b[i] === 35) { while (i < b.length && b[i] !== 10) i++; return token(); }
    let s = '';
    while (i < b.length && b[i] > 32) { s += String.fromCharCode(b[i]); i++; }
    return s;
  };
  if (token() !== 'P6') throw new Error('unexpected decoder output');
  const w = parseInt(token()), h = parseInt(token()), maxv = parseInt(token());
  i++;                                     // single whitespace before the pixels
  if (!w || !h) throw new Error('decoder gave an empty frame');
  return { w, h, maxv, off: i, bytes: b };
}

/* bytes -> { w, h, rgba (linear half floats), meta }, decoded in a worker */
function decodeRaw(name, bytes, half) {
  return rawJob({ bytes, half: !!(half || PREFS.halfRaw), prio: 0 }).promise;
}

function showError(title, lines) {
  document.getElementById('card').innerHTML =
    `<h4>${title}</h4><div class="cbody">` +
    lines.map(l => `<div class="hint" style="color:var(--text);margin:6px 0">${l}</div>`).join('') +
    `<div class="hint">More detail is in View → Toggle Developer Tools → Console.</div></div>` +
    `<div class="foot"><button class="tb primary" id="erOk">Close</button></div>`;
  document.getElementById('modal').classList.add('open');
  document.getElementById('erOk').onclick = () => document.getElementById('modal').classList.remove('open');
}

/* decode a raw file straight to an editor image, without the file-open side effects
   (busy overlay, toasts) so it can also run quietly as a background prefetch */
async function decodeRawToImage(f, quiet) {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let r;
  try {
    r = await decodeRaw(f.name, bytes, false);
  } catch (e1) {
    console.warn('full-size decode failed, retrying half size:', e1);
    if (!quiet) await busy('Retrying ' + f.name + ' at half size');
    r = await decodeRaw(f.name, await f.arrayBuffer(), true);
    if (!quiet) toast(f.name + ' opened at half size');
  }
  return imageFromLinear(f.name, r.w, r.h, r.rgba, r.meta);
}

/* build an editor image straight from linear half-float pixels */
function imageFromLinear(name, w, h, rgba, meta) {
  const im = baseImage(name, w, h, true);
  im.meta = meta || {};
  im.tex = storageTex(gl.RGBA16F, w, h);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.HALF_FLOAT, rgba);
  im.thumb = thumbFromHalf(rgba, w, h);
  return im;
}

/* ---------- opening ---------- */
const _loadFiles = loadFiles;
window.loadFiles = async function (files) {
  let list = [...files];
  const failed = [];
  let opened = null;

  // model files arrive as a pair and install together rather than opening as photos
  const modelFiles = list.filter(f => MODEL_RE.test(f.name) || /\.(data|bin)$/i.test(f.name));
  if (modelFiles.length && typeof installModelFiles === 'function') {
    list = list.filter(f => !modelFiles.includes(f));
    try {
      await busy('Installing the model');
      const parts = [];
      for (const f of modelFiles) parts.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      const r = await installModelFiles(parts);
      toast(`Model ready: ${r.name} · ${r.mb} MB · ${AI.label}`);
    } catch (e) {
      failed.push('model — ' + e.message);
    } finally { busy(null); }
  }
  // presets (Safelight, Lightroom, zip packs) install together, so a pack dropped as loose files is one import
  const presetFiles = list.filter(f => PRESET_RE.test(f.name));
  if (presetFiles.length) {
    list = list.filter(f => !presetFiles.includes(f));
    try {
      const parts = [];
      for (const f of presetFiles) parts.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
      await importPresetBytes(parts);
    } catch (e) {
      failed.push('presets — ' + e.message);
    }
  }
  for (const f of list) {
    const before = A.imgs.length;
    try {
      // anything with a place on disk opens progressively, like a photo from a folder
      const path = f.nativePath || N.pathForFile(f);
      if (path && PHOTO_RE.test(f.name)) {
        const im = await photoEntry(path, f.name);
        opened = opened || im;
        if (typeof requestThumb === 'function') requestThumb(path);
        continue;
      }
      if (RAWRE.test(f.name)) {
        await busy('Developing ' + f.name + ' — the first open of a raw takes a moment');
        A.imgs.push(await decodeRawToImage(f, false));
      } else {
        await _loadFiles([f]);
        if (A.imgs.length === before) throw new Error('the image decoder rejected this file');
      }
    } catch (e) {
      console.error('open failed:', f.name, e);
      failed.push(f.name + ' — ' + (e && e.message ? e.message : e));
    } finally {
      busy(null);
    }
  }
  document.getElementById('drop').hidden = A.imgs.length > 0;
  buildStrip();
  if (opened) selectImage(A.imgs.indexOf(opened));
  else if (A.cur < 0 && A.imgs.length) selectImage(0);
  if (failed.length) showError(failed.length + ' file(s) could not be opened', failed);
};

async function openNative() {
  const picked = await N.openDialog();
  if (!picked.length) return;
  await loadFromNative(picked);
}
async function loadFromNative(picked) {
  // photos arrive as paths and get an entry (with any saved edits) straight away;
  // presets, sidecars and models arrive with their bytes and go through loadFiles
  const photos = picked.filter(p => p.path && PHOTO_RE.test(p.name));
  const rest = picked.filter(p => !photos.includes(p) && p.bytes);
  if (rest.length) {
    await loadFiles(rest.map(p => {
      const f = new File([new Uint8Array(p.bytes)], p.name);
      f.nativePath = p.path;
      return f;
    }));
  }
  let first = null;
  for (const p of photos) {
    const im = await photoEntry(p.path, p.name);
    first = first || im;
    if (typeof requestThumb === 'function') requestThumb(p.path);
  }
  if (first) {
    document.getElementById('drop').hidden = true;
    selectImage(A.imgs.indexOf(first));
  }
}

/* ---------- export, through real save dialogs ----------
   "current" exports the open photo. "all" and "selected" walk the whole
   folder's file list (not just the handful currently decoded in memory),
   decoding anything not already open on demand and freeing it right after
   so a big batch never balloons memory. */
function exportTargets(scope) {
  if (scope === 'current') { const im = IM(); return im ? [{ path: im.path, name: im.name }] : []; }
  if (typeof FOLDER !== 'undefined' && FOLDER.dir && FOLDER.files.length) {
    if (scope === 'selected') return FOLDER.files.filter(f => FOLDER.selected && FOLDER.selected.has(f.path));
    if (scope === 'all') return FOLDER.files.slice();
  }
  // no folder open: fall back to whatever is loaded directly
  if (scope === 'selected') { toast('Open a folder to select photos'); return []; }
  const imgs = scope === 'all' ? A.imgs : (A.cur >= 0 ? [A.imgs[A.cur]] : []);
  return imgs.map(im => ({ path: im.path, name: im.name }));
}

window.exportDialog = function (scopeArg) {
  const scope = scopeArg === true ? 'all' : scopeArg === false ? 'current' : scopeArg;
  if (A.cur < 0 && scope === 'current') { toast('Open a photo first'); return; }
  const targets = exportTargets(scope);
  if (!targets.length) { toast(scope === 'selected' ? 'Nothing selected' : 'Open a photo first'); return; }
  const card = document.getElementById('card');
  card.innerHTML = `
    <h4>Export ${scope === 'current' ? 'photo' : targets.length + ' photos'}</h4>
    <div class="cbody">
      <div class="field"><span>Format</span><select id="exFmt">
        <option value="jpeg">JPEG</option><option value="png">PNG (lossless)</option><option value="webp">WebP</option>
      </select></div>
      <div class="field"><span>Quality</span><input type="number" id="exQ" min="50" max="100" step="1"></div>
      <div class="field"><span>Long edge (px)</span><input type="number" id="exL" min="0" step="100" placeholder="0 = full size"></div>
      <div class="field"><span>Name suffix</span><input type="text" id="exS"></div>
      <div class="hint" id="exInfo"></div>
    </div>
    <div class="foot">
      <button class="tb" id="exCancel">Cancel</button>
      <button class="tb primary" id="exGo">${scope === 'current' ? 'Save as…' : 'Choose folder…'}</button>
    </div>`;
  document.getElementById('exFmt').value = EXPORT.format;
  document.getElementById('exQ').value = EXPORT.quality;
  document.getElementById('exL').value = EXPORT.longEdge || '';
  document.getElementById('exS').value = EXPORT.suffix;
  const im0 = A.cur >= 0 ? A.imgs[A.cur] : null;
  document.getElementById('exInfo').textContent = im0
    ? (() => { const G = geom(im0.s, im0.w, im0.h); return `Full size ${Math.round(G.outW)} × ${Math.round(G.outH)} px`; })()
    : `${targets.length} photo${targets.length === 1 ? '' : 's'}`;
  document.getElementById('modal').classList.add('open');
  document.getElementById('exCancel').onclick = () => document.getElementById('modal').classList.remove('open');
  document.getElementById('exGo').onclick = async () => {
    EXPORT.format = document.getElementById('exFmt').value;
    EXPORT.quality = clamp(parseInt(document.getElementById('exQ').value) || 92, 50, 100);
    EXPORT.longEdge = parseInt(document.getElementById('exL').value) || 0;
    EXPORT.suffix = document.getElementById('exS').value;
    N.storeSet({ exportPrefs: EXPORT });
    document.getElementById('modal').classList.remove('open');

    const ext = EXPORT.format === 'jpeg' ? 'jpg' : EXPORT.format;
    let dir = null;
    if (scope !== 'current') { dir = await N.chooseFolder(); if (!dir) return; }
    const keepIm = A.cur >= 0 ? A.imgs[A.cur] : null;
    await loadRecords(targets.map(t => t.path).filter(Boolean));
    const entryOf = f => f.path ? photoEntrySync(f.path, f.name) : A.imgs.find(x => x.name === f.name);
    let last = null, ok = 0, halfOnly = 0;
    for (let n = 0; n < targets.length; n++) {
      const f = targets[n];
      await busy(`Exporting ${n + 1} of ${targets.length} — ${f.name}`);
      const image = entryOf(f);
      if (!image) continue;
      const wasLoaded = image.stage !== 'cold';
      image.pin = (image.pin || 0) + 1;
      // start developing the next one while this one renders
      const next = targets[n + 1] && entryOf(targets[n + 1]);
      if (next && next !== image) { next.pin = (next.pin || 0) + 1; want(next, 'full', 2); }
      try {
        try { await ensureStage(image, 'full'); }
        catch (e) { if (image.stage !== 'half') throw e; halfOnly++; }   // out of memory at full size: export what decoded
        await warmBrushes(image);
        const outName = image.name.replace(/\.[^.]+$/, '') + EXPORT.suffix + '.' + ext;
        // render with this photo's curve and brush textures bound, then put the screen's back
        const keep = A.cur;
        A.cur = A.imgs.indexOf(image); uploadAllBrushes(); uploadLUT();
        const pending = renderFull(image, EXPORT);   // all GPU work happens before its first await
        A.cur = keep; if (A.cur >= 0) { uploadAllBrushes(); uploadLUT(); }
        const r = await pending;
        const bytes = new Uint8Array(await r.blob.arrayBuffer());
        last = dir ? await N.writeInto(dir, outName, bytes)
          : await N.saveAs(outName, [{ name: EXPORT.format.toUpperCase(), extensions: [ext] }], bytes);
        ok++;
      } catch (e) { console.error(e); toast('Export failed for ' + f.name); }
      finally {
        image.pin--;
        if (next && next !== image) next.pin--;
      }
      // a photo developed just for this export shouldn't linger and eat memory in a big batch
      if (!wasLoaded && image !== keepIm) unloadPhoto(image);
      trimMemory();
      busy(null);
    }
    A.cur = keepIm ? A.imgs.indexOf(keepIm) : -1;
    if (A.cur >= 0) { uploadAllBrushes(); uploadLUT(); }
    requestRender(false);
    if (halfOnly) toast(`${halfOnly} photo${halfOnly > 1 ? 's' : ''} exported at half size — not enough memory for full`);
    if (typeof renderFolder === 'function') renderFolder();
    if (last && !halfOnly) toast(ok > 1 ? `Exported ${ok} photos` : ok ? 'Exported ' + last.split(/[\\/]/).pop() : 'Export failed');
    if (last) N.reveal(last);
  };
};

/* ---------- archive a raw as .fedr ---------- */
async function convertRaw() {
  const picked = await N.openDialog();
  if (!picked.length) return;
  const dir = await N.chooseFolder(); if (!dir) return;
  for (const p of picked) {
    if (!RAWRE.test(p.name)) continue;
    try {
      await busy('Converting ' + p.name);
      const [file] = await N.readFiles([p.path]);
      if (!file) throw new Error('could not read the file');
      const r = await decodeRaw(p.name, file.bytes);
      const head = JSON.stringify(Object.assign({}, r.meta, {
        width: r.w, height: r.h, name: p.name.replace(/\.[^.]+$/, ''),
        colorspace: 'srgb-linear', format: 'rgba16f', version: 1
      }));
      let hb = new TextEncoder().encode(head);
      const pad = (4 - hb.length % 4) % 4;
      if (pad) { const t = new Uint8Array(hb.length + pad); t.set(hb); t.fill(32, hb.length); hb = t; }
      const out = new Uint8Array(8 + hb.length + r.rgba.byteLength);
      out.set([70, 69, 68, 82], 0);                       // "FEDR"
      new DataView(out.buffer).setUint32(4, hb.length, true);
      out.set(hb, 8);
      out.set(new Uint8Array(r.rgba.buffer), 8 + hb.length);
      await N.writeInto(dir, p.name.replace(/\.[^.]+$/, '') + '.fedr', out);
    } catch (e) { toast(p.name + ': ' + e.message); }
    finally { busy(null); }
  }
  toast('Converted');
}

/* ---------- settings sidecars ---------- */
async function saveSidecar() {
  if (A.cur < 0) return;
  const im = IM();
  const bytes = new TextEncoder().encode(JSON.stringify({ app: 'safelight', version: 1, settings: im.s }, null, 2));
  await N.saveAs(im.name.replace(/\.[^.]+$/, '') + '.slcar', [{ name: 'Safelight settings', extensions: ['slcar', 'json'] }], bytes);
  toast('Settings saved');
}
async function loadSidecar() {
  const picked = await N.openDialog();
  const f = picked.find(p => /\.(slcar|json)$/i.test(p.name));
  if (!f) { toast('Pick a .slcar file'); return; }
  try {
    const j = JSON.parse(new TextDecoder().decode(new Uint8Array(f.bytes)));
    const im = IM(); if (!im) return;
    im.s = Object.assign(defaults(), j.settings || j);
    A.selMask = im.s.masks.length ? 0 : -1;
    syncAll(); rebuildMasks(); requestRender(true);
    toast('Settings applied');
  } catch (e) { toast('That file is not Safelight settings'); }
}

/* ---------- help ---------- */
function helpCard(info) {
  const rows = [
    ['\\', 'hold to see the original'], ['Z', 'fit / 100%'], ['C', 'crop tool'], ['E', 'red-eye tool'],
    ['G / M / B', 'add linear, radial, brush mask'], ['L / K', 'add luminance, colour mask'],
    ['O', 'toggle mask overlay'], ['[ ]', 'brush size'], ['1–9', 'apply preset'],
    ['⇧1–9', 'save preset'], ['← →', 'previous / next photo'], ['drag a slider label', 'fine scrub, hold ⇧ for finer'],
    ['⇧Ctrl K', 'Edit / Cull'], ['K (in Cull)', 'flag / unflag'], ['Esc (in Cull)', 'back to Edit']
  ];
  document.getElementById('card').innerHTML = `<h4>Shortcuts</h4><div class="cbody">${rows.map(([k, v]) =>
    `<div class="field"><span>${v}</span><b style="font:400 11px var(--mono);color:var(--amber)">${k}</b></div>`).join('')}
    <div class="hint">Safelight ${info.version} · Electron ${info.electron} · ${info.platform}</div></div>
    <div class="foot"><button class="tb primary" id="hpOk">Close</button></div>`;
  document.getElementById('modal').classList.add('open');
  document.getElementById('hpOk').onclick = () => document.getElementById('modal').classList.remove('open');
}


/* ============================================================
   presets — saved looks, yours and imported
   A preset is a settings object. It never carries crop, rotation,
   red-eye spots or brush paint, so it can land on any photo.
   Presets made in Safelight hold every setting and replace the
   look; presets imported from Lightroom (.xmp, .lrtemplate, mobile
   .dng, zip packs — see presetimport.js) only list what they change
   and land on top of the photo's current look ("partial").
   ============================================================ */
const PRESET_RE = /\.(slpreset|json|xmp|lrtemplate|zip)$/i;
const MODEL_RE = /\.(onnx|onnx\.data|onnx_data)$/i;
const escP = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const BUILTIN_PRESETS = [{
  name: 'Night portrait — cool sky, warm subject',
  group: 'Built in',
  notes: 'Underexposed astro portrait. Denoises first, anchors black, splits sky cool against a warm subject. Move the radial mask onto the face.',
  builtin: true,
  settings: {
    temp: -8, tint: 12,
    exposure: 1.3, contrast: 0.15, highlights: -0.1, shadows: 0.2, whites: 0.15, blacks: -0.2,
    texture: 0, clarity: 0, dehaze: 0, vibrance: 0.2, saturation: 0,
    curve: { rgb: [[0, 0], [0.25, 0.29], [0.75, 0.72], [1, 1]], r: [[0, 0], [1, 1]], g: [[0, 0], [1, 1]], b: [[0, 0], [1, 1]] },
    hslH: [0, 0, 0, 0, 0, 0, 0, 0],
    hslS: [0, 0, -10, -40, 10, 25, 0, 0],
    hslL: [0, 0, 0, -8, 0, -10, 0, 0],
    shHue: 220, shSat: 20, miHue: 0, miSat: 0, hiHue: 40, hiSat: 12, cgBal: 0,
    sharpen: 0.45, sharpRadius: 1.0, sharpDetail: 65, nrLum: 0.35, nrColor: 0.6,
    vignette: -0.35, vigFeather: 60, vigRound: 0, grain: 0, grainSize: 25,
    masks: [
      {
        type: 'lum', name: 'Sky', invert: false, opacity: 100, brush: -1,
        geo: { lo: 0, hi: 0.45, feather: 0.15 },
        adj: { exposure: 0.25, contrast: 0.1, highlights: 0, shadows: 0, saturation: 0.25, temp: -15, tint: 0, texture: 0.3 }
      },
      {
        type: 'radial', name: 'Subject', invert: false, opacity: 100, brush: -1,
        geo: { cx: 0.5, cy: 0.62, rx: 0.22, ry: 0.3, ang: 0, feather: 65 },
        adj: { exposure: 1.0, contrast: 0.1, highlights: 0, shadows: 0.45, saturation: 0.15, temp: 18, tint: 0, texture: 0.25 }
      }
    ]
  }
}];

const GEOM_KEYS = ['crop', 'cropAspect', 'rot90', 'flipH', 'flipV', 'straighten', 'redeye'];   // tied to this frame
const MY_GROUP = 'Your presets';

function presetLib() {
  if (!PREFS.presetLib) PREFS.presetLib = [];
  // presets saved before groups existed are yours
  for (const p of PREFS.presetLib) if (!p.id) p.id = idc();
  return BUILTIN_PRESETS.concat(PREFS.presetLib);
}
function savePresetLib() { N.storeSet({ presetLib: PREFS.presetLib || [] }); }
const groupOf = p => p.builtin ? 'Built in' : (p.group || MY_GROUP);

/* strip a live settings object down to something portable */
function presetFromCurrent(name, group, notes) {
  const s = JSON.parse(JSON.stringify(S()));
  GEOM_KEYS.forEach(k => delete s[k]);
  s.masks = (s.masks || []).filter(m => m.type !== 'brush');
  return { app: 'safelight', kind: 'preset', version: 1, name, group: group || '', notes: notes || '', settings: s };
}

/* accept a preset file, a sidecar, or a bare settings object */
function normalisePreset(obj, fallbackName) {
  if (!obj || typeof obj !== 'object') throw new Error('not JSON');
  const st = obj.settings || (obj.exposure !== undefined || obj.curve ? obj : null);
  if (!st) throw new Error('no settings found in this file');
  GEOM_KEYS.forEach(k => delete st[k]);
  return { app: 'safelight', kind: 'preset', version: 1, name: obj.name || fallbackName, group: obj.group || '', notes: obj.notes || '', settings: st, partial: !!obj.partial };
}

/* the settings a photo would have with preset p applied */
function presetResult(im, p) {
  const cur = im.s;
  const keep = {};
  GEOM_KEYS.forEach(k => keep[k] = JSON.parse(JSON.stringify(cur[k] === undefined ? defaults()[k] : cur[k])));
  const brushes = (cur.masks || []).filter(m => m.type === 'brush');   // your painting survives
  const incoming = JSON.parse(JSON.stringify(p.settings || {}));
  for (const k of Object.keys(incoming)) if (incoming[k] === null || incoming[k] === undefined) delete incoming[k];
  GEOM_KEYS.forEach(k => delete incoming[k]);
  delete incoming._partial;
  let next;
  if (p.partial) {
    // only what the preset lists changes; everything else stays as it was
    next = JSON.parse(JSON.stringify(cur));
    for (const [k, v] of Object.entries(incoming)) {
      if (k === 'curve') {
        next.curve = Object.assign(defaults().curve, next.curve || {});
        for (const ch of ['rgb', 'r', 'g', 'b']) if (Array.isArray(v[ch]) && v[ch].length >= 2) next.curve[ch] = v[ch];
      } else if (/^hsl[HSL]$/.test(k) && Array.isArray(v)) {
        const base = Array.isArray(next[k]) ? next[k] : new Array(8).fill(0);
        next[k] = base.map((x, i) => (v[i] === null || v[i] === undefined) ? x : v[i]);
      } else if (k === 'masks') {
        continue;                                         // imported presets carry no masks
      } else next[k] = v;
    }
    Object.assign(next, keep);
    return next;
  }
  next = Object.assign(defaults(), incoming, keep);
  next.masks = (next.masks || []).filter(m => m.type !== 'brush').map(m => Object.assign(
    { id: idc(), invert: false, opacity: 100, brush: -1 }, m,
    { adj: Object.assign(defMaskAdj(), m.adj) }));
  next.masks = next.masks.concat(brushes).slice(0, MAXM);
  return next;
}

function endPresetPreview() {
  clearTimeout(endPresetPreview._t);
  if (!A.preview) return;
  A.preview = null;
  requestRender(false);
}

function applyPreset(p) {
  if (A.cur < 0) { toast('Open a photo first'); return; }
  A.preview = null;
  const im = IM();
  const next = presetResult(im, p);
  im.s = next;
  A.selMask = next.masks.length ? 0 : -1;
  A.showMask = false;
  syncAll(); rebuildMasks(); requestRender(true);
  toast(p.name);
}

/* add presets to the library, replacing any with the same name in the same group */
function installPresets(list) {
  PREFS.presetLib = PREFS.presetLib || [];
  for (const p of list) {
    const group = p.group || '';
    PREFS.presetLib = PREFS.presetLib.filter(x => !(x.name === p.name && (x.group || '') === group));
    PREFS.presetLib.push({
      id: idc(), name: p.name, group, notes: p.notes || '', settings: p.settings,
      partial: !!p.partial, source: p.source || 'safelight', added: Date.now()
    });
  }
  savePresetLib();
  buildPresetPanel();
}

/* files: [{ name, bytes }] from a drop, the Import dialog or a download */
async function importPresetBytes(files, from) {
  const pre = files.filter(f => f.error).map(f => ({ name: f.name, why: f.error }));
  const good = files.filter(f => f.bytes);
  let r = { presets: [], skipped: [] };
  if (good.length) {
    await busy('Reading presets');
    try { r = await PRESETIO.readPresetFiles(good.map(f => ({ name: f.name, bytes: new Uint8Array(f.bytes) }))); }
    finally { busy(null); }
  }
  const skipped = pre.concat(r.skipped);
  if (!r.presets.length) {
    showError('No presets could be imported' + (from ? ' from ' + escP(from) : ''),
      (skipped.length ? skipped : [{ name: 'that file', why: 'nothing Safelight recognises as a preset' }])
        .map(s => '<b>' + escP(s.name) + '</b> — ' + escP(s.why)));
    return 0;
  }
  installPresets(r.presets);
  // one preset: show it on the photo straight away; a pack: just open its group
  if (r.presets.length === 1 && A.cur >= 0) {
    const p = PREFS.presetLib[PREFS.presetLib.length - 1];
    applyPreset(p);
  }
  const groups = [...new Set(r.presets.map(p => p.group).filter(Boolean))];
  if (groups.length && PREFS.presetCollapsed) { groups.forEach(g => delete PREFS.presetCollapsed[g]); N.storeSet({ presetCollapsed: PREFS.presetCollapsed }); buildPresetPanel(); }
  const n = r.presets.length;
  toast(`Installed ${n} preset${n === 1 ? '' : 's'}${groups.length === 1 ? ' · ' + groups[0] : ''}${skipped.length ? ` · ${skipped.length} skipped` : ''}`);
  if (skipped.length) console.warn('preset import skipped:', skipped);
  return n;
}

async function importPresetsDialog() {
  const picked = await N.pickPresets();
  if (!picked || !picked.length) return;
  await importPresetBytes(picked);
}

function importPresetLinkDialog() {
  const modal = document.getElementById('modal');
  document.getElementById('card').innerHTML =
    `<h4>Import a preset from a link</h4><div class="cbody">
      <div class="field"><span>Link</span><input type="text" id="plUrl" placeholder="https://…" style="flex:1;min-width:0" spellcheck="false"></div>
      <div class="hint">Paste a direct link to a preset file: Lightroom <b>.xmp</b> or <b>.lrtemplate</b>, a Lightroom mobile
      <b>.dng</b>, a <b>.zip</b> pack, or a Safelight <b>.slpreset</b>. Dropbox, Google Drive and GitHub share links work too.
      If the link opens a store or blog page, download the file there and use <b>Import…</b> instead.</div>
      <div class="hint" id="plErr" style="color:var(--clip)"></div>
     </div>
     <div class="foot"><button class="tb" id="plCancel">Cancel</button><button class="tb primary" id="plGo">Download &amp; install</button></div>`;
  modal.classList.add('open');
  const input = document.getElementById('plUrl');
  input.focus();
  const go = async () => {
    const url = input.value.trim();
    if (!url) return;
    const btn = document.getElementById('plGo');
    btn.disabled = true; btn.textContent = 'Downloading…';
    document.getElementById('plErr').textContent = '';
    const r = await N.fetchPreset(url);
    if (!r || r.error) {
      btn.disabled = false; btn.textContent = 'Download & install';
      document.getElementById('plErr').textContent = (r && r.error) || 'could not download it';
      return;
    }
    modal.classList.remove('open');
    await importPresetBytes([{ name: r.name, bytes: r.bytes }], r.name);
  };
  document.getElementById('plGo').onclick = go;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  document.getElementById('plCancel').onclick = () => modal.classList.remove('open');
}

/* name, group, and (when editing) whether to take this photo's settings */
function presetDialog(title, init, then) {
  const groups = [...new Set((PREFS.presetLib || []).map(p => p.group).filter(Boolean))].sort();
  const editing = !!init.editing;
  document.getElementById('card').innerHTML =
    `<h4>${escP(title)}</h4><div class="cbody">
      <div class="field"><span>Name</span><input type="text" id="pName"></div>
      <div class="field"><span>Group</span><input type="text" id="pGroup" list="pGroups" placeholder="${MY_GROUP}">
        <datalist id="pGroups">${groups.map(g => `<option value="${escP(g)}">`).join('')}</datalist></div>
      <div class="field"><span>Shortcut key (1-9, optional)</span><input type="number" id="pSlot" min="1" max="9"></div>
      ${editing ? `<div class="field"><span>Replace its settings with this photo's</span><input type="checkbox" id="pTake"></div>` : ''}
      <div class="field"><span>Also save as a file to share</span><input type="checkbox" id="pFile"></div>
      <div class="hint">Every setting is saved except crop, rotation, red-eye fixes and brush paint, so the preset fits any photo.</div>
     </div>
     <div class="foot"><button class="tb" id="pCancel">Cancel</button><button class="tb primary" id="pOk">Save</button></div>`;
  const modal = document.getElementById('modal');
  modal.classList.add('open');
  document.getElementById('pName').value = init.name || '';
  document.getElementById('pGroup').value = init.group || '';
  if (init.slot) document.getElementById('pSlot').value = init.slot;
  document.getElementById('pFile').checked = !!init.toFile;
  document.getElementById('pName').select();
  document.getElementById('pCancel').onclick = () => modal.classList.remove('open');
  const ok = () => {
    const name = document.getElementById('pName').value.trim() || init.name || 'Untitled look';
    const group = document.getElementById('pGroup').value.trim();
    const slot = parseInt(document.getElementById('pSlot').value) || 0;
    const take = editing ? document.getElementById('pTake').checked : true;
    const toFile = document.getElementById('pFile').checked;
    modal.classList.remove('open');
    then({ name, group: group === MY_GROUP ? '' : group, slot: slot >= 1 && slot <= 9 ? slot : 0, take, toFile });
  };
  document.getElementById('pOk').onclick = ok;
  document.getElementById('pName').addEventListener('keydown', e => { if (e.key === 'Enter') ok(); });
}

async function writePresetFile(p) {
  const bytes = new TextEncoder().encode(JSON.stringify({
    app: 'safelight', kind: 'preset', version: 1, name: p.name, group: p.group || '', notes: p.notes || '',
    partial: !!p.partial, settings: p.settings
  }, null, 2));
  await N.saveAs(p.name.replace(/[^\w\- ]+/g, '').trim() + '.slpreset',
    [{ name: 'Safelight preset', extensions: ['slpreset', 'json'] }], bytes);
}

/* what a number key holds: the settings, marked when they only list what they change */
const slotSettings = p => p.partial ? Object.assign({ _partial: true }, p.settings) : p.settings;
function slotOf(p) {
  const j = JSON.stringify(slotSettings(p));
  for (const [k, v] of Object.entries(A.presets || {})) if (JSON.stringify(v) === j) return k;
  return '';
}

async function savePresetAs(alsoToFile) {
  if (A.cur < 0) { toast('Open a photo first'); return; }
  const mine = (PREFS.presetLib || []).filter(p => !p.group).length;
  presetDialog('Save as preset', { name: 'Look ' + (mine + 1), toFile: alsoToFile }, async ({ name, group, slot, toFile }) => {
    const p = presetFromCurrent(name, group);
    installPresets([p]);
    if (slot) { A.presets[String(slot)] = p.settings; N.storeSet({ presets: A.presets }); }
    if (toFile) await writePresetFile(p);
    toast('Preset saved: ' + name + (slot ? ' · key ' + slot : ''));
  });
}

function editPreset(p) {
  presetDialog('Edit preset', { name: p.name, group: p.group, slot: slotOf(p), editing: true }, async ({ name, group, slot, take, toFile }) => {
    const lib = PREFS.presetLib || [];
    const it = lib.find(x => x.id === p.id);
    if (!it) return;
    const oldSlot = slotOf(it);
    if (take) {
      if (A.cur < 0) { toast('Open a photo to take its settings'); }
      else { it.settings = presetFromCurrent(name, group).settings; it.partial = false; }
    }
    it.name = name; it.group = group;
    if (oldSlot && String(oldSlot) !== String(slot)) delete A.presets[oldSlot];
    if (slot) A.presets[String(slot)] = slotSettings(it);
    N.storeSet({ presets: A.presets });
    savePresetLib(); buildPresetPanel();
    if (toFile) await writePresetFile(it);
    toast(take ? 'Preset updated from this photo' : 'Preset saved');
  });
}

function confirmCard(title, body, okLabel, then) {
  const modal = document.getElementById('modal');
  document.getElementById('card').innerHTML =
    `<h4>${escP(title)}</h4><div class="cbody"><div class="hint" style="color:var(--text)">${body}</div></div>
     <div class="foot"><button class="tb" id="cfNo">Cancel</button><button class="tb primary" id="cfYes">${escP(okLabel)}</button></div>`;
  modal.classList.add('open');
  document.getElementById('cfNo').onclick = () => modal.classList.remove('open');
  document.getElementById('cfYes').onclick = () => { modal.classList.remove('open'); then(); };
}

function deletePreset(p) {
  PREFS.presetLib = (PREFS.presetLib || []).filter(x => x.id !== p.id);
  const s = slotOf(p); if (s) { delete A.presets[s]; N.storeSet({ presets: A.presets }); }
  savePresetLib(); buildPresetPanel();
  toast('Removed ' + p.name);
}

function deleteGroup(g) {
  const list = (PREFS.presetLib || []).filter(p => groupOf(p) === g);
  confirmCard('Remove ' + g + '?', `This removes all ${list.length} preset${list.length === 1 ? '' : 's'} in <b>${escP(g)}</b>. Photos you already applied them to keep their look.`, 'Remove', () => {
    const ids = new Set(list.map(p => p.id));
    PREFS.presetLib = PREFS.presetLib.filter(p => !ids.has(p.id));
    savePresetLib(); buildPresetPanel();
    toast('Removed ' + g);
  });
}

const sourceLabel = p => p.builtin ? 'built in' : ({ xmp: 'lightroom', lrtemplate: 'lightroom', dng: 'lr mobile' })[p.source] || 'yours';

function buildPresetPanel() {
  let host = document.getElementById('presetHost');
  if (!host) {
    const insp = document.getElementById('insp');
    const sect = mkSection(insp, 'Presets', true, (b, s, h) => {
      const bd = document.createElement('span'); bd.className = 'badge'; bd.id = 'presetBadge'; h.append(bd);
      const g = document.createElement('div'); g.className = 'grp';
      const add = (t, title, fn) => { const c = document.createElement('div'); c.className = 'chip'; c.textContent = t; c.title = title; c.onclick = fn; g.append(c); };
      add('+ Save current…', 'Save this photo\'s look as a preset', () => savePresetAs(false));
      add('Import…', 'Lightroom .xmp / .lrtemplate, Lightroom mobile .dng, .zip packs, .slpreset', importPresetsDialog);
      add('From link…', 'Download a preset or pack from a web address', importPresetLinkDialog);
      b.append(g);
      const f = document.createElement('input');
      f.type = 'text'; f.id = 'presetFilter'; f.placeholder = 'Filter presets'; f.spellcheck = false;
      f.className = 'pfilter'; f.hidden = true;
      f.oninput = () => buildPresetPanel();
      b.append(f);
      const hh = document.createElement('div'); hh.id = 'presetHost'; b.append(hh);
      b.insertAdjacentHTML('beforeend',
        '<div class="hint">Hover a preset to preview it on the photo, click to apply. Lightroom presets are translated to Safelight\'s sliders — close to the original look, not identical. You can also drag preset files onto the window.</div>');
    });
    // up top, under the histogram, where it can be reached without scrolling past every panel
    const head = t => [...insp.querySelectorAll(':scope > .sect > h3')].find(h => h.textContent.startsWith(t));
    const scope = head('Scope');
    if (scope && scope.parentElement.nextElementSibling) insp.insertBefore(sect, scope.parentElement.nextElementSibling);
    host = document.getElementById('presetHost');
  }
  host.innerHTML = '';
  const lib = presetLib();
  const badge = document.getElementById('presetBadge');
  if (badge) badge.textContent = lib.length ? String(lib.length) : '';
  const filterEl = document.getElementById('presetFilter');
  if (filterEl) filterEl.hidden = lib.length < 9;
  const q = filterEl && !filterEl.hidden ? filterEl.value.trim().toLowerCase() : '';
  const shown = q ? lib.filter(p => (p.name + ' ' + groupOf(p)).toLowerCase().includes(q)) : lib;
  if (!shown.length) { host.innerHTML = `<div class="empty">${q ? 'No presets match.' : 'No presets yet.'}</div>`; return; }

  // groups: yours first, then imported packs A-Z, built in last
  const groups = new Map();
  for (const p of shown) { const g = groupOf(p); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(p); }
  const order = [...groups.keys()].sort((a, b) => {
    const w = g => g === MY_GROUP ? 0 : g === 'Built in' ? 2 : 1;
    return w(a) - w(b) || a.localeCompare(b, undefined, { numeric: true });
  });
  PREFS.presetCollapsed = PREFS.presetCollapsed || {};
  const list = document.createElement('div'); list.className = 'mlist plist';
  for (const g of order) {
    const items = groups.get(g);
    const closed = !q && PREFS.presetCollapsed[g];
    if (groups.size > 1 || g !== MY_GROUP) {
      const head = document.createElement('div'); head.className = 'pgroup' + (closed ? ' closed' : '');
      head.innerHTML = `<span class="tw">${closed ? '▸' : '▾'}</span><span class="gn">${escP(g)}</span><span class="n">${items.length}</span>` +
        (g !== 'Built in' && g !== MY_GROUP ? '<span class="x" title="Remove this whole group">×</span>' : '');
      head.onclick = e => {
        if (e.target.classList.contains('x')) { deleteGroup(g); return; }
        PREFS.presetCollapsed[g] = !PREFS.presetCollapsed[g];
        N.storeSet({ presetCollapsed: PREFS.presetCollapsed });
        buildPresetPanel();
      };
      list.append(head);
    }
    if (closed) continue;
    for (const p of items) {
      const d = document.createElement('div'); d.className = 'mitem pitem';
      d.title = (p.notes ? p.notes + '\n' : '') + 'Click to apply · hover to preview';
      const slot = slotOf(p);
      d.innerHTML = `<span class="k">${sourceLabel(p)}</span><span class="nm">${escP(p.name)}</span>` +
        (slot ? `<span class="slot" title="Press ${slot} to apply">${slot}</span>` : '') +
        (p.builtin ? '' : '<span class="ed" title="Rename, regroup, or update from this photo">✎</span><span class="x" title="Remove">×</span>');
      d.onclick = e => {
        if (e.target.classList.contains('x')) { endPresetPreview(); deletePreset(p); return; }
        if (e.target.classList.contains('ed')) { endPresetPreview(); editPreset(p); return; }
        applyPreset(p);
      };
      d.onmouseenter = () => {
        clearTimeout(endPresetPreview._t);
        const im = IM();
        if (!im || !im.tex) return;
        try { A.preview = { im, s: presetResult(im, p), name: p.name }; requestRender(false); }
        catch (err) { console.warn('preset preview failed', err); }
      };
      // a short grace period, so sliding between presets doesn't flash the original
      d.onmouseleave = () => { clearTimeout(endPresetPreview._t); endPresetPreview._t = setTimeout(endPresetPreview, 90); };
      list.append(d);
    }
  }
  list.onmouseleave = () => endPresetPreview();
  host.append(list);
}

/* ---------- wiring ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  if (!N) return;                            // running in a plain browser: stay web-only
  const info = await N.info();
  if (info.platform === 'darwin') document.body.classList.add('mac');

  PREFS = Object.assign(PREFS, await N.storeGet());
  if (PREFS.presets) A.presets = PREFS.presets;
  if (PREFS.exportPrefs) Object.assign(EXPORT, PREFS.exportPrefs);

  buildPresetPanel();
  document.getElementById('btnOpen').onclick = openNative;
  document.getElementById('file').remove();
  N.onOpenFiles(files => loadFromNative(files));

  // the application menu owns every ⌘/Ctrl chord, so stop the web handler doubling up
  addEventListener('keydown', e => { if (e.metaKey || e.ctrlKey) e.stopImmediatePropagation(); }, true);
  // persist presets shortly after they change
  addEventListener('keyup', () => {
    const j = JSON.stringify(A.presets);
    if (j !== PREFS._pj) { PREFS._pj = j; N.storeSet({ presets: A.presets }); }
  });

  N.onMenu(cmd => {
    const has = A.cur >= 0;
    switch (cmd) {
      case 'open': openNative(); break;
      case 'open-folder': (async () => { const d = await N.pickFolder(); if (d) openFolder(d); })(); break;
      case 'folder-up': if (FOLDER.parent) openFolder(FOLDER.parent); break;
      case 'close-folder': closeFolder(); break;
      case 'reveal': { const im = IM(); if (im && im.path) N.reveal(im.path); else if (FOLDER.dir) N.reveal(FOLDER.dir); } break;
      case 'close-photo': {
        if (!has) break;
        const at = A.cur;
        closePhoto(IM());
        A.cur = -1;
        const nextI = Math.min(at, A.imgs.length - 1);
        if (nextI < 0) { document.getElementById('drop').hidden = false; buildStrip(); requestRender(false); }
        else selectImage(nextI);
        break;
      }
      case 'export': exportDialog('current'); break;
      case 'export-all': exportDialog('all'); break;
      case 'export-selected': exportDialog('selected'); break;
      case 'convert-raw': convertRaw(); break;
      case 'select-subject': selectSubject(); break;
      case 'save-sidecar': saveSidecar(); break;
      case 'save-preset': savePresetAs(true); break;
      case 'new-preset': savePresetAs(false); break;
      case 'import-presets': importPresetsDialog(); break;
      case 'import-preset-link': importPresetLinkDialog(); break;
      case 'load-sidecar': loadSidecar(); break;
      case 'undo': undo(-1); break;
      case 'redo': undo(1); break;
      case 'copy': copySettings(); break;
      case 'paste': pasteSettings(); break;
      case 'reset': resetAll(); break;
      case 'fit': A.view.fit = true; requestRender(false); break;
      case 'one': A.view.fit = false; A.view.zoom = 1; requestRender(false); break;
      case 'zoom-in': A.view.fit = false; A.view.zoom = clamp(A.view.zoom * 1.35, .05, 16); requestRender(false); break;
      case 'zoom-out': A.view.fit = false; A.view.zoom = clamp(A.view.zoom / 1.35, .05, 16); requestRender(false); break;
      case 'before':
        A.before = !A.before;
        document.getElementById('btnBefore').classList.toggle('on', A.before);
        requestRender(false); break;
      case 'overlay': A.showMask = !A.showMask; rebuildMasks(); requestRender(true); break;
      case 'next': if (!stepPhoto(1)) selectImage(A.cur + 1); break;
      case 'prev': if (!stepPhoto(-1)) selectImage(A.cur - 1); break;
      case 'help': helpCard(info); break;
    }
  });

  const drop = document.getElementById('drop');
  drop.innerHTML = `<div><b>Drop photos here</b>
    Camera raw — CR2 · CR3 · NEF · ARW · DNG · RAF · RW2 · ORF — developed in place<br>
    JPEG · PNG · WebP · <kbd>.fedr</kbd> linear raw<br>
    <kbd>⌘O</kbd> open · <kbd>\\</kbd> compare · <kbd>M</kbd> mask · <kbd>${info.platform === 'darwin' ? '⌘E' : 'Ctrl+E'}</kbd> export</div>`;
});