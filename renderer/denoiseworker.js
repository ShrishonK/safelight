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

importScripts('vendor/ort/ort.min.js');

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

function modelIsHalf(sess) { try { return sess.inputMetadata[0].type === 'float16'; } catch { return false; } }
function modelFixedSize(sess) {
  try {
    const s = sess.inputMetadata && sess.inputMetadata[0] && sess.inputMetadata[0].shape;
    if (!s || s.length !== 4) return null;
    return (typeof s[2] === 'number' && s[2] > 0 && s[2] === s[3]) ? s[2] : null;
  } catch { return null; }
}
function featherWeight(i, n, ov) {
  let w = 1;
  if (i < ov) w *= 0.5 - 0.5 * Math.cos(Math.PI * (i + 0.5) / ov);
  if (i >= n - ov) w *= 0.5 - 0.5 * Math.cos(Math.PI * (n - 0.5 - i) / ov);
  return Math.max(w, 1e-4);
}

/* waits here while paused; throws once cancelled */
async function checkpoint() {
  await new Promise(r => setTimeout(r, 0));            // let pause/cancel messages in
  while (W_.paused && !W_.cancelled) await new Promise(r => { W_.resume = r; });
  if (W_.cancelled) throw new Error('cancelled');
}

/* src: Float32Array of gamma-encoded RGB 0..1, interleaved, W*H*3 */
async function runTiles(src, W, H, tile, progress) {
  const ort = W_.ort, sess = W_.session;
  const inName = sess.inputNames[0], outName = sess.outputNames[0];
  const half = modelIsHalf(sess), h2f = half ? H2F() : null;
  const OV = W_.overlap;
  const round64 = n => Math.max(64, Math.ceil(n / 64) * 64);
  const T = modelFixedSize(sess) || Math.min(round64(tile), round64(Math.max(W, H) + 2 * OV));
  const step = Math.max(64, T - OV * 2);
  const starts = n => {
    const out = [], last = n + OV - T;
    for (let p = -OV; p < last; p += step) out.push(p);
    out.push(Math.max(-OV, last));
    return [...new Set(out)];
  };
  const xs = starts(W), ys = starts(H);
  const acc = new Float32Array(W * H * 3), wsum = new Float32Array(W * H);
  const total = xs.length * ys.length;
  const plane = T * T;
  const inF = new Float32Array(3 * plane), inH = half ? new Uint16Array(3 * plane) : null;
  let done = 0;

  for (const y0 of ys) {
    for (const x0 of xs) {
      await checkpoint();
      for (let y = 0; y < T; y++) {
        const sy = Math.min(H - 1, Math.max(0, y0 + y));
        for (let x = 0; x < T; x++) {
          const sx = Math.min(W - 1, Math.max(0, x0 + x));
          const s = (sy * W + sx) * 3, d = y * T + x;
          inF[d] = src[s]; inF[plane + d] = src[s + 1]; inF[2 * plane + d] = src[s + 2];
        }
      }
      let input;
      if (half) { for (let i = 0; i < inF.length; i++) inH[i] = toHalf(inF[i]); input = new ort.Tensor('float16', inH, [1, 3, T, T]); }
      else input = new ort.Tensor('float32', inF, [1, 3, T, T]);
      let res;
      try { res = await sess.run({ [inName]: input }); }
      catch (e) { if (done === 0) e.firstTile = true; throw e; }
      const tensor = res[outName];
      if (tensor.dims.length === 4 && tensor.dims[1] === 1) {
        throw new Error('that model outputs a single-channel mask, not a photo — it is a segmentation model, not a denoiser');
      }
      let o = tensor.data;
      if (half) { const f = new Float32Array(o.length); for (let i = 0; i < o.length; i++) f[i] = h2f[o[i]]; o = f; }
      for (let y = 0; y < T; y++) {
        const gy = y0 + y;
        if (gy < 0 || gy >= H) continue;
        const wy = featherWeight(y, T, OV);
        for (let x = 0; x < T; x++) {
          const gx = x0 + x;
          if (gx < 0 || gx >= W) continue;
          const w = wy * featherWeight(x, T, OV);
          const si = y * T + x, di = (gy * W + gx) * 3;
          acc[di] += o[si] * w; acc[di + 1] += o[plane + si] * w; acc[di + 2] += o[2 * plane + si] * w;
          wsum[gy * W + gx] += w;
        }
      }
      if (tensor.dispose) tensor.dispose();
      done++;
      progress(done / total);
    }
  }
  for (let i = 0, p = 0; i < W * H; i++, p += 3) {
    const w = wsum[i];
    for (let c = 0; c < 3; c++) {
      const v = w > 0 ? acc[p + c] / w : NaN;
      acc[p + c] = Number.isFinite(v) ? v : src[p + c];   // never leave a hole
    }
  }
  return acc;
}

async function runModel(src, W, H, progress) {
  const fixed = modelFixedSize(W_.session);
  let tile = W_.tile || (W_.backend === 'webgpu' ? 768 : 512);
  for (;;) {
    try { return await runTiles(src, W, H, fixed || tile, progress); }
    catch (e) {
      if (e.firstTile && !fixed && tile > 256 && !W_.cancelled) { tile /= 2; W_.tile = tile; continue; }
      throw e;
    }
  }
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

async function denoiseFrame(d) {
  const { w: W, h: H, strength } = d;
  const rgba = new Uint16Array(d.rgba);
  const n = W * H, h2f = H2F();
  const gain = chooseGain(rgba, n, d.exposure);

  // every half float maps to one input value at this gain: a table, not 70 M pow() calls
  const enc = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) { const v = h2f[i] * gain; enc[i] = Number.isFinite(v) ? clamp01(encSRGB(v > 0 ? v : 0)) : 0; }
  let src = new Float32Array(n * 3);
  for (let i = 0, p = 0, q = 0; i < n; i++, p += 3, q += 4) {
    src[p] = enc[rgba[q]]; src[p + 1] = enc[rgba[q + 1]]; src[p + 2] = enc[rgba[q + 2]];
  }
  const t0 = performance.now();
  let out = await runModel(src, W, H, f => self.postMessage({ type: 'progress', id: d.id, f }));
  src = null;
  const secs = (performance.now() - t0) / 1000;

  // back to linear at the raw's own level, into the frame we were given
  const k = Math.max(0, Math.min(1, strength == null ? 1 : strength));
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
  out = null;
  await checkpoint();
  // compressing and writing happen elsewhere, so this worker can start on the next frame
  const head = Object.assign({}, d.meta || {}, {
    width: W, height: H, name: d.name,
    colorspace: 'srgb-linear', format: 'rgba16f', version: 2,
    compression: 'deflate-shuffle',
    denoised: { model: d.model, strength: k, gain: Math.round(gain * 100) / 100, device: W_.label, seconds: Math.round(secs), from: d.from, at: new Date().toISOString() }
  });
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
