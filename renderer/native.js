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

async function decodeRaw(name, bytes) {
  await ensureDcraw();
  const opts = { useCameraWhiteBalance: true, use16BitLinearMode: true };
  if (PREFS.halfRaw) opts.setHalfSizeMode = true;
  let meta = {};
  try {
    const txt = window.dcraw(bytes, { verbose: true, identify: true });
    if (typeof txt === 'string') {
      const g = k => (txt.match(new RegExp(k + ':\\s*(.+)')) || [, ''])[1].trim();
      meta = { camera: g('Camera'), iso: g('ISO speed'), shutter: g('Shutter'), aperture: g('Aperture'), lens: g('Focal length') };
    }
  } catch (e) { /* metadata is a nicety, not a requirement */ }

  let out = window.dcraw(bytes, opts);
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
  const plain = [];
  for (const f of list) {
    if (!RAWRE.test(f.name)) { plain.push(f); continue; }
    try {
      await busy('Developing ' + f.name + ' — first open of a raw takes a moment');
      const bytes = new Uint8Array(await f.arrayBuffer());
      const r = await decodeRaw(f.name, bytes);
      const im = imageFromLinear(f.name, r.w, r.h, r.rgba, r.meta);
      A.imgs.push(im);
    } catch (e) {
      console.error(e);
      toast(f.name + ': ' + e.message);
    } finally { busy(null); }
  }
  if (plain.length) await _loadFiles(plain);
  document.getElementById('drop').hidden = A.imgs.length > 0;
  buildStrip();
  if (A.cur < 0 && A.imgs.length) selectImage(0);
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

/* ---------- wiring ---------- */
document.addEventListener('DOMContentLoaded', async () => {
  if (!N) return;                            // running in a plain browser: stay web-only
  const info = await N.info();
  if (info.platform === 'darwin') document.body.classList.add('mac');

  PREFS = Object.assign(PREFS, await N.storeGet());
  if (PREFS.presets) A.presets = PREFS.presets;
  if (PREFS.exportPrefs) Object.assign(EXPORT, PREFS.exportPrefs);

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
  drop.innerHTML = `<b>Drop photos here</b>
    Camera raw — CR2 · CR3 · NEF · ARW · DNG · RAF · RW2 · ORF — developed in place<br>
    JPEG · PNG · WebP · <kbd>.fedr</kbd> linear raw<br>
    <kbd>⌘O</kbd> open · <kbd>\\</kbd> compare · <kbd>M</kbd> mask · <kbd>⌘E</kbd> export`;
});
