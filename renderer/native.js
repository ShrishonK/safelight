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
let HALF_LUT = null;
function halfLUT() {                        // 16-bit code value -> half float of value/65535
  if (HALF_LUT) return HALF_LUT;
  HALF_LUT = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) HALF_LUT[i] = toHalf(i / 65535);
  return HALF_LUT;
}

/* ---------- raw decoding (dcraw compiled to asm.js, bundled) ---------- */
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('could not load ' + src));
    document.head.append(s);
  });
}
let dcrawReady = null;
function ensureDcraw() {
  if (window.dcraw) return Promise.resolve();
  if (!dcrawReady) {
    dcrawReady = loadScript('vendor/dcraw.js')
      .catch(() => loadScript('../node_modules/dcraw/dist/dcraw.js'))
      .then(() => { if (!window.dcraw) throw new Error('raw decoder failed to start'); });
  }
  return dcrawReady;
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

async function decodeRaw(name, bytes, half) {
  await ensureDcraw();
  const opts = { useCameraWhiteBalance: true, use16BitLinearMode: true };
  if (half || PREFS.halfRaw) opts.setHalfSizeMode = true;
  let meta = {};
  try {
    const txt = window.dcraw(bytes, { verbose: true, identify: true });
    if (typeof txt === 'string') {
      const g = k => (txt.match(new RegExp(k + ':\\s*(.+)')) || [, ''])[1].trim();
      meta = { camera: g('Camera'), iso: g('ISO speed'), shutter: g('Shutter'), aperture: g('Aperture'), lens: g('Focal length') };
    }
  } catch (e) { /* metadata is a nicety, not a requirement */ }

  let out;
  try {
    out = window.dcraw(bytes, opts);
  } catch (e) {
    const m = String(e && e.message || e);
    throw new Error(/memory|allocat/i.test(m) ? 'the decoder ran out of memory on this frame' : 'the decoder failed: ' + m.slice(0, 160));
  }
  if (out && typeof out === 'object' && !(out instanceof Uint8Array)) out = Object.values(out)[0];
  if (!out || typeof out === 'string' || out.length < 64) throw new Error('this file is not a raw image the decoder recognises');

  const { w, h, maxv, off, bytes: pb } = parsePPM(out);
  const n = w * h;
  const rgba = new Uint16Array(n * 4);
  const LUT = halfLUT();
  const ONE = toHalf(1);
  const scale = maxv === 255 ? 257 : 1;     // 8-bit fallback -> promote to 16-bit range
  let p = off;
  for (let k = 0; k < n; k++) {
    const r = ((pb[p] << 8) | pb[p + 1]) * scale;
    const g = ((pb[p + 2] << 8) | pb[p + 3]) * scale;
    const b = ((pb[p + 4] << 8) | pb[p + 5]) * scale;
    const o = k * 4;
    rgba[o] = LUT[r > 65535 ? 65535 : r];
    rgba[o + 1] = LUT[g > 65535 ? 65535 : g];
    rgba[o + 2] = LUT[b > 65535 ? 65535 : b];
    rgba[o + 3] = ONE;
    p += 6;
  }
  return { w, h, rgba, meta };
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

/* build an editor image straight from linear half-float pixels */
function imageFromLinear(name, w, h, rgba, meta) {
  const im = baseImage(name, w, h, true);
  im.meta = meta || {};
  im.tex = mkTex();
  gl.bindTexture(gl.TEXTURE_2D, im.tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, rgba);
  im.thumb = thumbFromHalf(rgba, w, h);
  return im;
}

/* ---------- opening ---------- */
const _loadFiles = loadFiles;
window.loadFiles = async function (files) {
  const list = [...files];
  const failed = [];
  for (const f of list) {
    const before = A.imgs.length;
    try {
      if (PRESET_RE.test(f.name)) {
        await importPresetFile(f);
        continue;
      }
      if (RAWRE.test(f.name)) {
        await busy('Developing ' + f.name + ' — the first open of a raw takes a moment');
        const bytes = new Uint8Array(await f.arrayBuffer());
        let r;
        try {
          r = await decodeRaw(f.name, bytes, false);
        } catch (e1) {
          console.warn('full-size decode failed, retrying half size:', e1);
          await busy('Retrying ' + f.name + ' at half size');
          r = await decodeRaw(f.name, bytes, true);
          toast(f.name + ' opened at half size');
        }
        A.imgs.push(imageFromLinear(f.name, r.w, r.h, r.rgba, r.meta));
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
  if (A.cur < 0 && A.imgs.length) selectImage(0);
  if (failed.length) showError(failed.length + ' file(s) could not be opened', failed);
};

async function openNative() {
  const picked = await N.openDialog();
  if (!picked.length) return;
  await loadFromNative(picked);
}
async function loadFromNative(picked) {
  const files = picked.map(p => {
    const f = new File([new Uint8Array(p.bytes)], p.name);
    f.nativePath = p.path;
    return f;
  });
  await loadFiles(files);
  // keep the source path so exports can default beside the original
  A.imgs.forEach((im, i) => { const m = picked.find(p => p.name === im.name || p.name.replace(/\.[^.]+$/, '') === im.name); if (m && !im.path) im.path = m.path; });
}

/* ---------- export, through real save dialogs ---------- */
window.exportDialog = function (all) {
  if (A.cur < 0) { toast('Open a photo first'); return; }
  const card = document.getElementById('card');
  const n = A.imgs.length;
  card.innerHTML = `
    <h4>Export ${all ? n + ' photos' : 'photo'}</h4>
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
      <button class="tb primary" id="exGo">${all ? 'Choose folder…' : 'Save as…'}</button>
    </div>`;
  document.getElementById('exFmt').value = EXPORT.format;
  document.getElementById('exQ').value = EXPORT.quality;
  document.getElementById('exL').value = EXPORT.longEdge || '';
  document.getElementById('exS').value = EXPORT.suffix;
  const im = IM(), G = geom(im.s, im.w, im.h);
  document.getElementById('exInfo').textContent = `Full size ${Math.round(G.outW)} × ${Math.round(G.outH)} px`;
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
    const targets = all ? A.imgs.map((_, i) => i) : [A.cur];
    let dir = null;
    if (all) { dir = await N.chooseFolder(); if (!dir) return; }
    const keep = A.cur;
    let last = null;
    for (const i of targets) {
      const image = A.imgs[i];
      const outName = image.name.replace(/\.[^.]+$/, '') + EXPORT.suffix + '.' + ext;
      await busy(`Exporting ${targets.indexOf(i) + 1} of ${targets.length} — ${image.name}`);
      A.cur = i; uploadAllBrushes(); uploadLUT();
      try {
        const r = await renderFull(image, EXPORT);
        const bytes = new Uint8Array(await r.blob.arrayBuffer());
        last = dir ? await N.writeInto(dir, outName, bytes)
          : await N.saveAs(outName, [{ name: EXPORT.format.toUpperCase(), extensions: [ext] }], bytes);
      } catch (e) { console.error(e); toast('Export failed for ' + image.name); }
      busy(null);
    }
    A.cur = keep; uploadAllBrushes(); requestRender(false);
    if (last) { toast(targets.length > 1 ? `Exported ${targets.length} photos` : 'Exported ' + last.split(/[\\/]/).pop()); N.reveal(last); }
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
      const r = await decodeRaw(p.name, new Uint8Array(p.bytes));
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
    ['\\', 'hold to see the original'], ['Z', 'fit / 100%'], ['C', 'crop tool'],
    ['G / M / B', 'add linear, radial, brush mask'], ['L / K', 'add luminance, colour mask'],
    ['O', 'toggle mask overlay'], ['[ ]', 'brush size'], ['1–9', 'apply preset'],
    ['⇧1–9', 'save preset'], ['← →', 'previous / next photo'], ['drag a slider label', 'fine scrub, hold ⇧ for finer']
  ];
  document.getElementById('card').innerHTML = `<h4>Shortcuts</h4><div class="cbody">${rows.map(([k, v]) =>
    `<div class="field"><span>${v}</span><b style="font:400 11px var(--mono);color:var(--amber)">${k}</b></div>`).join('')}
    <div class="hint">Safelight ${info.version} · Electron ${info.electron} · ${info.platform}</div></div>
    <div class="foot"><button class="tb primary" id="hpOk">Close</button></div>`;
  document.getElementById('modal').classList.add('open');
  document.getElementById('hpOk').onclick = () => document.getElementById('modal').classList.remove('open');
}


/* ============================================================
   presets — portable JSON looks
   A preset is a partial settings object. It never carries crop,
   rotation or brush paint, so it can land on any photo.
   ============================================================ */
const PRESET_RE = /\.(slpreset|json)$/i;

const BUILTIN_PRESETS = [{
  name: 'Night portrait — cool sky, warm subject',
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

const GEOM_KEYS = ['crop', 'cropAspect', 'rot90', 'flipH', 'flipV', 'straighten'];

function presetLib() {
  if (!PREFS.presetLib) PREFS.presetLib = [];
  return BUILTIN_PRESETS.concat(PREFS.presetLib);
}
function savePresetLib() { N.storeSet({ presetLib: PREFS.presetLib || [] }); }

/* strip a live settings object down to something portable */
function presetFromCurrent(name, notes) {
  const s = JSON.parse(JSON.stringify(S()));
  GEOM_KEYS.forEach(k => delete s[k]);
  s.masks = (s.masks || []).filter(m => m.type !== 'brush');
  return { app: 'safelight', kind: 'preset', version: 1, name, notes: notes || '', settings: s };
}

/* accept a preset file, a sidecar, or a bare settings object */
function normalisePreset(obj, fallbackName) {
  if (!obj || typeof obj !== 'object') throw new Error('not JSON');
  const st = obj.settings || (obj.exposure !== undefined || obj.curve ? obj : null);
  if (!st) throw new Error('no settings found in this file');
  GEOM_KEYS.forEach(k => delete st[k]);
  return { app: 'safelight', kind: 'preset', version: 1, name: obj.name || fallbackName, notes: obj.notes || '', settings: st };
}

function applyPreset(p) {
  if (A.cur < 0) { toast('Open a photo first'); return; }
  const im = IM();
  const keep = {};
  GEOM_KEYS.forEach(k => keep[k] = im.s[k]);
  const brushes = (im.s.masks || []).filter(m => m.type === 'brush');   // your painting survives
  const next = Object.assign(defaults(), JSON.parse(JSON.stringify(p.settings)), keep);
  next.masks = (next.masks || []).filter(m => m.type !== 'brush').map(m => Object.assign(
    { id: idc(), invert: false, opacity: 100, brush: -1, adj: defMaskAdj() }, m));
  next.masks = next.masks.concat(brushes).slice(0, MAXM);
  im.s = next;
  A.selMask = next.masks.length ? 0 : -1;
  A.showMask = false;
  syncAll(); rebuildMasks(); requestRender(true);
  toast(p.name);
}

async function importPresetFile(file) {
  const text = await file.text();
  const p = normalisePreset(JSON.parse(text), file.name.replace(/\.[^.]+$/, ''));
  PREFS.presetLib = (PREFS.presetLib || []).filter(x => x.name !== p.name);
  PREFS.presetLib.push({ name: p.name, notes: p.notes, settings: p.settings });
  savePresetLib();
  buildPresetPanel();
  applyPreset(p);
  toast('Preset installed: ' + p.name);
}

function askName(title, dflt, then) {
  document.getElementById('card').innerHTML =
    `<h4>${title}</h4><div class="cbody">
      <div class="field"><span>Name</span><input type="text" id="pName"></div>
      <div class="field"><span>Slot (1-9, optional)</span><input type="number" id="pSlot" min="1" max="9"></div>
      <div class="hint">Crop, rotation and brush paint are never stored in a preset.</div>
     </div>
     <div class="foot"><button class="tb" id="pCancel">Cancel</button><button class="tb primary" id="pOk">Save</button></div>`;
  document.getElementById('modal').classList.add('open');
  document.getElementById('pName').value = dflt;
  document.getElementById('pCancel').onclick = () => document.getElementById('modal').classList.remove('open');
  document.getElementById('pOk').onclick = () => {
    const n = document.getElementById('pName').value.trim() || dflt;
    const slot = parseInt(document.getElementById('pSlot').value) || 0;
    document.getElementById('modal').classList.remove('open');
    then(n, slot);
  };
}

async function savePresetAs(alsoToFile) {
  if (A.cur < 0) { toast('Open a photo first'); return; }
  askName('Save preset', 'Look ' + ((PREFS.presetLib || []).length + 1), async (name, slot) => {
    const p = presetFromCurrent(name);
    PREFS.presetLib = (PREFS.presetLib || []).filter(x => x.name !== name);
    PREFS.presetLib.push({ name: p.name, notes: p.notes, settings: p.settings });
    if (slot) { A.presets[String(slot)] = p.settings; N.storeSet({ presets: A.presets }); }
    savePresetLib(); buildPresetPanel();
    if (alsoToFile) {
      const bytes = new TextEncoder().encode(JSON.stringify(p, null, 2));
      await N.saveAs(name.replace(/[^\w\- ]+/g, '') + '.slpreset',
        [{ name: 'Safelight preset', extensions: ['slpreset', 'json'] }], bytes);
    }
    toast('Preset saved' + (slot ? ' to slot ' + slot : ''));
  });
}

function buildPresetPanel() {
  let host = document.getElementById('presetHost');
  if (!host) {
    mkSection(document.getElementById('insp'), 'Presets', true, b => {
      const g = document.createElement('div'); g.className = 'grp';
      const add = (t, fn) => { const c = document.createElement('div'); c.className = 'chip'; c.textContent = t; c.onclick = fn; g.append(c); };
      add('Save current…', () => savePresetAs(false));
      add('Export to file…', () => savePresetAs(true));
      b.append(g);
      const h = document.createElement('div'); h.id = 'presetHost'; b.append(h);
      b.insertAdjacentHTML('beforeend',
        '<div class="hint">Drag a <b>.slpreset</b> or <b>.json</b> file onto the window to install it. Presets apply to any photo — crop and brush work are left alone.</div>');
    });
    host = document.getElementById('presetHost');
  }
  host.innerHTML = '';
  const lib = presetLib();
  if (!lib.length) { host.innerHTML = '<div class="empty">No presets yet.</div>'; return; }
  const list = document.createElement('div'); list.className = 'mlist';
  lib.forEach((p, i) => {
    const d = document.createElement('div'); d.className = 'mitem';
    d.title = p.notes || '';
    d.innerHTML = `<span class="k">${p.builtin ? 'built in' : 'yours'}</span><span class="nm">${p.name}</span>` +
      (p.builtin ? '' : '<span class="x">×</span>');
    d.onclick = e => {
      if (e.target.classList.contains('x')) {
        PREFS.presetLib = PREFS.presetLib.filter(x => x.name !== p.name);
        savePresetLib(); buildPresetPanel(); return;
      }
      applyPreset(p);
    };
    list.append(d);
  });
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
      case 'close-photo':
        if (!has) break;
        A.imgs.splice(A.cur, 1);
        A.cur = Math.min(A.cur, A.imgs.length - 1);
        if (A.cur < 0) { document.getElementById('drop').hidden = false; buildStrip(); }
        else selectImage(A.cur);
        break;
      case 'export': exportDialog(false); break;
      case 'export-all': exportDialog(true); break;
      case 'convert-raw': convertRaw(); break;
      case 'save-sidecar': saveSidecar(); break;
      case 'save-preset': savePresetAs(true); break;
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
      case 'next': selectImage(A.cur + 1); break;
      case 'prev': selectImage(A.cur - 1); break;
      case 'help': helpCard(info); break;
    }
  });

  const drop = document.getElementById('drop');
  drop.innerHTML = `<div><b>Drop photos here</b>
    Camera raw — CR2 · CR3 · NEF · ARW · DNG · RAF · RW2 · ORF — developed in place<br>
    JPEG · PNG · WebP · <kbd>.fedr</kbd> linear raw<br>
    <kbd>⌘O</kbd> open · <kbd>\\</kbd> compare · <kbd>M</kbd> mask · <kbd>${info.platform === 'darwin' ? '⌘E' : 'Ctrl+E'}</kbd> export</div>`;
});