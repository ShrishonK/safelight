/* ============================================================
   subject.js — "Select subject"
   ------------------------------------------------------------
   Runs a small saliency network and paints the result into a
   brush mask, so the selection is editable afterwards: paint to
   extend it, alt-paint to trim. Segmentation is a starting point,
   not a verdict.
   ============================================================ */
'use strict';

const SEG = { session: null, size: 320 };
const SEG_MODEL = 'vendor/models/u2netp.onnx';

async function segSession() {
  if (SEG.session) return SEG.session;
  const ort = await ensureOrt();
  let bytes = await modelGet('__subject__');
  if (!bytes) {
    const r = await N.readAsset(SEG_MODEL);
    if (!r || !r.bytes) throw new Error('the subject model is missing from this build');
    bytes = new Uint8Array(r.bytes);
    try { await modelPut('__subject__', bytes); } catch (e) { /* cache is optional */ }
  }
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes.main || bytes);
  const gpu = await haveWebGPU();
  SEG.session = await ort.InferenceSession.create(bytes, {
    executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'],
    graphOptimizationLevel: 'all'
  });
  return SEG.session;
}

/* the network is trained on ordinary daylight pictures, so it sees a
   normalised version of the frame rather than your dark exposure */
function segInput(rgba, W, H, N_) {
  const c = document.createElement('canvas');
  c.width = N_; c.height = N_;
  const g = c.getContext('2d');
  const id = g.createImageData(W, H);
  id.data.set(rgba);
  const tmp = document.createElement('canvas');
  tmp.width = W; tmp.height = H;
  tmp.getContext('2d').putImageData(id, 0, 0);
  g.drawImage(tmp, 0, 0, N_, N_);
  const px = g.getImageData(0, 0, N_, N_).data;

  // stretch so the brightest content lands near white; a black frame tells it nothing
  let p99 = 1;
  {
    const hist = new Uint32Array(256);
    for (let i = 0; i < px.length; i += 4) hist[Math.max(px[i], px[i + 1], px[i + 2])]++;
    const total = px.length / 4;
    let run = 0;
    for (let v = 255; v >= 0; v--) { run += hist[v]; if (run > total * 0.01) { p99 = Math.max(v, 8) / 255; break; } }
  }
  const gain = Math.min(8, 0.8 / p99);
  const P = N_ * N_, data = new Float32Array(3 * P);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let i = 0, p = 0; i < P; i++, p += 4) {
    for (let ch = 0; ch < 3; ch++) {
      const v = Math.min(1, (px[p + ch] / 255) * gain);
      data[ch * P + i] = (v - mean[ch]) / std[ch];
    }
  }
  return data;
}

async function selectSubject() {
  const im = IM();
  if (!im) { toast('Open a photo first'); return; }
  const s = im.s;
  if (s.masks.length >= MAXM) { toast('Six masks max — delete one first'); return; }
  if (s.masks.filter(m => m.type === 'brush').length >= MAXBRUSH) { toast('Four brush masks max'); return; }

  try {
    await busy('Looking for the subject');
    const sess = await segSession();
    const ort = AI.ort;

    // a small proxy is plenty: the network only ever sees 320px
    const G = geom(s, im.w, im.h);
    const pw = 512, ph = Math.max(8, Math.round(512 * G.outH / G.outW));
    const clean = Object.assign({}, JSON.parse(JSON.stringify(s)),
      { masks: [], vignette: 0, grain: 0, sharpen: 0, nrLum: 0, nrColor: 0 });
    const saved = im.s;
    let rgba;
    try {
      im.s = clean;
      const R = develop(im, pw, ph, [1, 1], [.5, .5], true);
      rgba = new Uint8Array(pw * ph * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, R.out.fb);
      gl.readPixels(0, 0, pw, ph, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    } finally { im.s = saved; freeExport(); }

    const N_ = SEG.size;
    const input = segInput(rgba, pw, ph, N_);
    const res = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, N_, N_]) });
    const map = res[sess.outputNames[0]].data;

    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < N_ * N_; i++) { const v = map[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const span = (hi - lo) || 1;
    let strong = 0;
    for (let i = 0; i < N_ * N_; i++) if ((map[i] - lo) / span > 0.5) strong++;
    const cover = strong / (N_ * N_);
    if (cover < 0.004) throw new Error('nothing stood out as a subject in this frame');

    // paint it into a brush mask so it stays editable
    const idx = s.masks.filter(m => m.type === 'brush').length;
    const b = ensureBrush(idx);
    const small = document.createElement('canvas');
    small.width = N_; small.height = N_;
    const sg = small.getContext('2d');
    const sid = sg.createImageData(N_, N_);
    for (let i = 0; i < N_ * N_; i++) {
      let v = (map[i] - lo) / span;
      v = v < 0.35 ? 0 : v > 0.65 ? 1 : (v - 0.35) / 0.3;   // soft edge, no hard cut
      sid.data[i * 4] = sid.data[i * 4 + 1] = sid.data[i * 4 + 2] = 255;
      sid.data[i * 4 + 3] = Math.round(v * 255);
    }
    sg.putImageData(sid, 0, 0);
    const ctx = b.ctx;
    ctx.clearRect(0, 0, b.canvas.width, b.canvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(small, 0, 0, b.canvas.width, b.canvas.height);
    uploadBrush(idx);

    const m = newMask('brush');
    m.brush = idx;
    m.name = 'Subject';
    m.geo.size = 14; m.geo.soft = 70; m.geo.flow = 70;
    s.masks.push(m);
    A.selMask = s.masks.length - 1;
    A.showMask = true;
    rebuildMasks();
    requestRender(true);
    toast(`Subject selected — ${(cover * 100).toFixed(0)}% of the frame. Paint to extend, Alt-paint to trim.`);
  } catch (e) {
    console.error(e);
    showError('Could not select a subject', [String(e.message),
      'The brush mask still works — paint the subject by hand.']);
  } finally { busy(null); }
}

/* ---------- wiring ---------- */
document.addEventListener('DOMContentLoaded', () => {
  if (!window.native) return;
  const add = [...document.querySelectorAll('.chip')].find(c => c.textContent === '+ Brush');
  if (!add) return;
  const b = document.createElement('div');
  b.className = 'chip';
  b.textContent = '+ Subject';
  b.title = 'Find the subject automatically, then refine it with the brush';
  b.onclick = () => selectSubject();
  add.parentElement.insertBefore(b, add.nextSibling);
});