/* ============================================================
   denoiseworker.js — neural denoise off the interface thread
   ------------------------------------------------------------
   The batch denoiser (batchdenoise.js) hands this worker one
   developed-linear frame at a time: the same half-float RGBA the
   raw decoder produces. It runs the network tile by tile, puts the
   result back into linear light at the frame's own exposure, and
   returns a finished .fedr file — compressed — ready to be written.

   Nothing here touches the page, so sliders, the filmstrip and
   scrolling never wait on it, however long a frame takes.
   ============================================================ */
'use strict';

importScripts('vendor/ort/ort.min.js', 'denoisecore.js');

const W_ = {
  ort: null, session: null, backend: 'wasm', label: 'CPU',
  overlap: 96, tile: 0,
  paused: false, cancelled: false, resume: null
};

/* ---------- half floats ---------- */
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
function half2f(h) {
  const s = (h & 0x8000) >> 15, e = (h & 0x7C00) >> 10, f = h & 0x03FF;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}
let _h2f = null;
function H2F() {
  if (_h2f) return _h2f;
  _h2f = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) _h2f[i] = half2f(i);
  return _h2f;
}
const encSRGB = v => v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
const decSRGB = v => v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

/* ---------- the runtime ---------- */
async function setup(d) {
  const ort = self.ort;
  if (!ort) throw new Error('the inference runtime failed to load');
  ort.env.wasm.wasmPaths = d.wasmPaths;
  ort.env.wasm.numThreads = d.threads || 1;
  ort.env.webgpu.powerPreference = 'high-performance';
  ort.env.logLevel = 'error';
  W_.ort = ort;

  let gpu = false;
  if (d.device !== 'cpu') {
    try { gpu = !!(self.navigator.gpu && await self.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' })); }
    catch { gpu = false; }
  }
  if (d.device === 'gpu' && !gpu) throw new Error('no WebGPU adapter on this machine — set Device to Auto or CPU');
  const opts = { executionProviders: gpu ? ['webgpu', 'wasm'] : ['wasm'], graphOptimizationLevel: 'all' };
  if (d.ext && d.ext.length) opts.externalData = d.ext.map(e => ({ path: e.path, data: e.data }));
  let onGpu = gpu;
  try {
    W_.session = await ort.InferenceSession.create(d.main, opts);
    onGpu = gpu && !!(ort.env.webgpu && ort.env.webgpu.adapter);
  } catch (e) {
    if (!gpu) throw e;
    W_.session = await ort.InferenceSession.create(d.main, Object.assign({}, opts, { executionProviders: ['wasm'] }));
    onGpu = false;
  }
  W_.backend = onGpu ? 'webgpu' : 'wasm';
  W_.label = onGpu ? 'GPU' : `CPU × ${ort.env.wasm.numThreads}`;
  return { label: W_.label, backend: W_.backend };
}

/* waits here while paused; throws once cancelled */
async function checkpoint() {
  await new Promise(r => setTimeout(r, 0));            // let pause/cancel messages in
  while (W_.paused && !W_.cancelled) await new Promise(r => { W_.resume = r; });
  if (W_.cancelled) throw new Error('cancelled');
}

function ctxFor(id) {
  return {
    ort: W_.ort, session: W_.session, backend: W_.backend, overlap: W_.overlap, tile: W_.tile,
    progress: f => self.postMessage({ type: 'progress', id, f }),
    checkpoint
  };
}

/* ---------- one frame ----------
   The network was trained on noise as it looks on screen, so a dark frame is
   lifted first — by the photo's own exposure slider if it has been edited, or
   to a typical mid-grey otherwise — then put back down afterwards, so the file
   that comes out sits exactly where the raw did and every edit still fits it.
   Highlights the lift would push past white keep their original pixels. */
function chooseGain(rgba, n, exposure) {
  if (Number.isFinite(exposure) && Math.abs(exposure) > 0.01) return Math.min(32, Math.max(1, Math.pow(2, exposure)));
  const h2f = H2F(), lum = [];
  const stride = Math.max(1, Math.floor(n / 200000));
  for (let i = 0; i < n; i += stride) {
    const o = i * 4;
    lum.push(0.2126 * h2f[rgba[o]] + 0.7152 * h2f[rgba[o + 1]] + 0.0722 * h2f[rgba[o + 2]]);
  }
  lum.sort((a, b) => a - b);
  const med = lum[Math.floor(lum.length / 2)] || 0;
  return med > 0 ? Math.min(16, Math.max(1, 0.12 / med)) : 16;
}

/* sRGB code value (16-bit) -> linear, for the way back out */
let _dec = null;
function DEC() {
  if (_dec) return _dec;
  _dec = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) _dec[i] = decSRGB(i / 65535);
  return _dec;
}

/* lift, encode: the network's input for one frame */
function prepFrame(d) {
  const rgba = new Uint16Array(d.rgba);
  const n = d.w * d.h, h2f = H2F();
  const gain = chooseGain(rgba, n, d.exposure);
  // every half float maps to one input value at this gain: a table, not 70 M pow() calls
  const enc = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) { const v = h2f[i] * gain; enc[i] = Number.isFinite(v) ? clamp01(encSRGB(v > 0 ? v : 0)) : 0; }
  const src = new Float32Array(n * 3);
  for (let i = 0, p = 0, q = 0; i < n; i++, p += 3, q += 4) {
    src[p] = enc[rgba[q]]; src[p + 1] = enc[rgba[q + 1]]; src[p + 2] = enc[rgba[q + 2]];
  }
  return { rgba, src, gain };
}

/* back to linear at the raw's own level, into the frame we were given */
function finishFrame(d, rgba, out, gain, secs) {
  const n = d.w * d.h, h2f = H2F();
  const k = Math.max(0, Math.min(1, d.strength == null ? 1 : d.strength));
  const dec = DEC(), ig = 1 / gain;
  const back = v => dec[v <= 0 ? 0 : v >= 1 ? 65535 : (v * 65535 + 0.5) | 0] * ig;
  for (let i = 0, p = 0, q = 0; i < n; i++, p += 3, q += 4) {
    const r0 = h2f[rgba[q]], g0 = h2f[rgba[q + 1]], b0 = h2f[rgba[q + 2]];
    const m = Math.max(r0, g0, b0) * gain;
    let keep = m <= 0.8 ? 0 : m >= 1 ? 1 : (m - 0.8) / 0.2;
    keep = keep * keep * (3 - 2 * keep);
    const mix = k * (1 - keep);
    rgba[q] = toHalf(r0 + (back(out[p]) - r0) * mix);
    rgba[q + 1] = toHalf(g0 + (back(out[p + 1]) - g0) * mix);
    rgba[q + 2] = toHalf(b0 + (back(out[p + 2]) - b0) * mix);
  }
  // compressing and writing happen elsewhere, so the next frame can start
  const head = Object.assign({}, d.meta || {}, {
    width: d.w, height: d.h, name: d.name,
    colorspace: 'srgb-linear', format: 'rgba16f', version: 2,
    compression: 'deflate-shuffle',
    denoised: { model: d.model, strength: k, gain: Math.round(gain * 100) / 100, device: d.device || W_.label, seconds: Math.round(secs), from: d.from, at: new Date().toISOString() }
  });
  return head;
}

/* the whole frame here, for when the network runs in this worker */
async function denoiseFrame(d) {
  const { rgba, src, gain } = prepFrame(d);
  const t0 = performance.now();
  const ctx = ctxFor(d.id);
  const out = await DNC.runModel(ctx, src, d.w, d.h);
  W_.tile = ctx.tile;
  const secs = (performance.now() - t0) / 1000;
  await checkpoint();
  const head = finishFrame(d, rgba, out, gain, secs);
  return { head, rgba, secs, gain };
}

/* ---------- messages ---------- */
self.onmessage = async e => {
  const d = e.data;
  if (d.type === 'pause') { W_.paused = true; return; }
  if (d.type === 'resume') { W_.paused = false; if (W_.resume) { W_.resume(); W_.resume = null; } return; }
  if (d.type === 'cancel') { W_.cancelled = true; if (W_.resume) { W_.resume(); W_.resume = null; } return; }
  if (d.type === 'setup') {
    try { self.postMessage({ type: 'ready', ...(await setup(d)) }); }
    catch (err) { self.postMessage({ type: 'fatal', error: String(err && err.message || err) }); }
    return;
  }
  // the page runs the network; this worker does the per-pixel work either side of it
  if (d.type === 'prep') {
    try {
      const r = prepFrame(d);
      self.postMessage({ type: 'prepped', id: d.id, rgba: r.rgba, src: r.src, gain: r.gain }, [r.rgba.buffer, r.src.buffer]);
    } catch (err) { self.postMessage({ type: 'failed', id: d.id, error: String(err && err.message || err) }); }
    return;
  }
  if (d.type === 'finish') {
    try {
      const rgba = new Uint16Array(d.rgba);
      const head = finishFrame(d, rgba, new Float32Array(d.out), d.gain, d.secs);
      self.postMessage({ type: 'finished', id: d.id, head, rgba }, [rgba.buffer]);
    } catch (err) { self.postMessage({ type: 'failed', id: d.id, error: String(err && err.message || err) }); }
    return;
  }
  if (d.type === 'frame') {
    W_.cancelled = false;
    try {
      const r = await denoiseFrame(d);
      self.postMessage({ type: 'done', id: d.id, head: r.head, rgba: r.rgba, secs: r.secs, gain: r.gain }, [r.rgba.buffer]);
    } catch (err) {
      self.postMessage({ type: 'failed', id: d.id, error: String(err && err.message || err) });
    }
  }
};
