/* ============================================================
   ai.js — neural denoising through ONNX Runtime Web
   ------------------------------------------------------------
   Unlike the slider denoiser, this does not average neighbours:
   it runs a trained network that reconstructs what was probably
   there. It is slow and one-shot, so it produces a NEW photo in
   the filmstrip rather than running on every slider move — the
   original is never touched.
   ============================================================ */
'use strict';

const AI = {
  ort: null,
  session: null,
  modelName: null,
  device: 'auto', // 'auto' | 'gpu' | 'cpu'
  tile: 0,        // 0 = pick from the backend (see tileFor)
  overlap: 96,    // deep networks darken well beyond a few pixels at a tile edge
  cancel: false
};

/* Every tile repeats the overlap, so small tiles waste most of their work: at 512 px
   with this overlap, 2.6x the frame is computed; at 1024 px, 1.5x. GPUs take the big
   tile in their stride; on the CPU the gain is smaller but still worth having. */
const tileFor = backend => AI.tile || (backend === 'webgpu' ? 1024 : 768);

/* the model is large, so it lives in IndexedDB after the first fetch */
const MODEL_DB = 'safelight-models';

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(MODEL_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('models');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function modelGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('models', 'readonly').objectStore('models').get(key);
    t.onsuccess = () => res(t.result || null);
    t.onerror = () => rej(t.error);
  });
}
async function modelPut(key, buf) {
  const db = await idb();
  return new Promise((res, rej) => {
    const t = db.transaction('models', 'readwrite').objectStore('models').put(buf, key);
    t.onsuccess = () => res(true);
    t.onerror = () => rej(t.error);
  });
}
async function modelList() {
  const db = await idb();
  return new Promise((res) => {
    const t = db.transaction('models', 'readonly').objectStore('models').getAllKeys();
    t.onsuccess = () => res(t.result || []);
    t.onerror = () => res([]);
  });
}

async function ensureOrt() {
  if (AI.ort) return AI.ort;
  await loadScript('vendor/ort/ort.min.js');
  const ort = window.ort;
  if (!ort) throw new Error('the inference runtime failed to load');
  // must be an absolute URL: a bare relative path is treated as a module specifier
  const base = new URL('vendor/ort/', document.baseURI).href;
  ort.env.wasm.wasmPaths = base;
  ort.env.wasm.numThreads = 1;
  // main.js turns SharedArrayBuffer on, so the CPU path can use worker threads.
  // The threaded runtime spawns its workers from its own module URL, and a file://
  // page can't fetch() that, so hand it the module as a blob read over IPC instead.
  const cores = navigator.hardwareConcurrency || 2;
  if (typeof SharedArrayBuffer !== 'undefined' && cores > 2 && window.native) {
    try {
      const r = await N.readAsset('vendor/ort/ort-wasm-simd-threaded.jsep.mjs');
      if (r && r.bytes) {
        const mjs = URL.createObjectURL(new Blob([r.bytes], { type: 'text/javascript' }));
        ort.env.wasm.wasmPaths = { mjs, wasm: base + 'ort-wasm-simd-threaded.jsep.wasm' };
        ort.env.wasm.numThreads = Math.min(8, cores - 2);   // leave room for the UI and the GPU driver
      }
    } catch (e) { console.warn('threaded runtime unavailable, staying single-threaded', e); }
  }
  // laptops with two GPUs should get the discrete one
  ort.env.webgpu.powerPreference = 'high-performance';
  ort.env.logLevel = 'error';
  AI.ort = ort;
  return ort;
}

/* the webgpu backend only publishes its adapter once it actually came up */
function webgpuLive(ort) {
  try { return !!(ort.env.webgpu && ort.env.webgpu.adapter); } catch { return false; }
}

async function haveWebGPU() {
  try { return !!(navigator.gpu && await navigator.gpu.requestAdapter()); }
  catch { return false; }
}

/* load a model from the cache, or from bytes the user just supplied */
async function loadModel(key, rec, onProgress) {
  const ort = await ensureOrt();
  if (!rec) {
    rec = await modelGet(key);
    if (!rec) throw new Error('model "' + key + '" is not installed');
  }
  // older records were a bare Uint8Array
  if (rec instanceof Uint8Array || rec instanceof ArrayBuffer) rec = { main: rec, ext: [] };
  if (onProgress) onProgress('Starting the model');
  const gpu = AI.device !== 'cpu' && await haveWebGPU();
  if (AI.device === 'gpu' && !gpu) throw new Error('no WebGPU adapter on this machine — set Device to Auto or CPU');
  const providers = gpu ? ['webgpu', 'wasm'] : ['wasm'];
  const opts = { executionProviders: providers, graphOptimizationLevel: 'all' };
  // Big exports keep their weights in a sibling .onnx.data file; the graph refers
  // to it by relative name, so hand it over under exactly that name.
  if (rec.ext && rec.ext.length) opts.externalData = rec.ext.map(e => ({ path: e.path, data: e.data }));
  if (AI.session) { try { await AI.session.release(); } catch { } AI.session = null; }
  let onGpu = gpu;
  try {
    AI.session = await ort.InferenceSession.create(rec.main, opts);
    // ORT drops an execution provider that fails to start without saying so
    onGpu = gpu && webgpuLive(ort);
  } catch (e) {
    if (!gpu) throw e;
    AI.session = await ort.InferenceSession.create(rec.main, Object.assign({}, opts, { executionProviders: ['wasm'] }));
    onGpu = false;
  }
  AI.modelName = key;
  AI.loadedDevice = AI.device;
  AI.backend = onGpu ? 'webgpu' : 'wasm';
  AI.label = onGpu ? 'GPU' : `CPU × ${ort.env.wasm.numThreads} thread${ort.env.wasm.numThreads === 1 ? '' : 's'}`;
  return AI.session;
}

/* ---------- pixel plumbing ----------
   Models of this kind are trained on gamma-encoded RGB in 0..1, so the
   linear working image is encoded on the way in and decoded on the way out. */
/* fp16 exports run roughly twice as fast on GPUs that support shader-f16 */
let _h2f = null;
function halfToFloatLUT() {
  if (_h2f) return _h2f;
  _h2f = new Float32Array(65536);
  for (let i = 0; i < 65536; i++) _h2f[i] = half2f(i);
  return _h2f;
}
function modelIsHalf(sess) {
  try { return sess.inputMetadata[0].type === 'float16'; } catch { return false; }
}

function tileToTensor(ort, rgba, W, H, x0, y0, tw, th, half) {
  const data = new Float32Array(3 * tw * th);
  const plane = tw * th;
  for (let y = 0; y < th; y++) {
    const sy = Math.min(H - 1, Math.max(0, y0 + y));
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(W - 1, Math.max(0, x0 + x));
      const s = (sy * W + sx) * 4, d = y * tw + x;
      data[d] = rgba[s] / 255;
      data[plane + d] = rgba[s + 1] / 255;
      data[2 * plane + d] = rgba[s + 2] / 255;
    }
  }
  if (half) {
    const h = new Uint16Array(data.length);
    for (let i = 0; i < data.length; i++) h[i] = toHalf(data[i]);
    return new ort.Tensor('float16', h, [1, 3, th, tw]);
  }
  return new ort.Tensor('float32', data, [1, 3, th, tw]);
}

/* cosine ramp so tile seams disappear instead of showing as a grid */
function featherWeight(i, n, overlap) {
  let w = 1;
  if (i < overlap) w *= 0.5 - 0.5 * Math.cos(Math.PI * (i + 0.5) / overlap);
  if (i >= n - overlap) w *= 0.5 - 0.5 * Math.cos(Math.PI * (n - 0.5 - i) / overlap);
  return Math.max(w, 1e-4);
}

/* Some exports fix the spatial input size instead of leaving it dynamic (e.g. a
   320x320-only graph); feeding such a model any other size fails outright at
   OrtRun with a dimension mismatch. Read the declared shape back off the session
   so tiling respects it instead of always assuming the configured tile fits. */
function modelFixedSize(sess) {
  try {
    const shape = sess.inputMetadata && sess.inputMetadata[0] && sess.inputMetadata[0].shape;
    if (!shape || shape.length !== 4) return null;
    const h = shape[2], w = shape[3];
    return (typeof h === 'number' && typeof w === 'number' && h > 0 && w > 0 && h === w) ? h : null;
  } catch { return null; }
}

/* run the model over one RGBA byte image, returning denoised RGB floats 0..1.
   A big tile can exhaust GPU memory on a small card; that shows up on the first
   tile, so halve the tile and start over rather than give up. */
async function runModel(rgba, W, H, onProgress) {
  const sess = AI.session;
  if (!sess) throw new Error('no model loaded');
  const fixed = modelFixedSize(sess);
  let tile = tileFor(AI.backend);
  for (;;) {
    try {
      return await runTiles(rgba, W, H, fixed || tile, onProgress);
    } catch (e) {
      if (e.firstTile && !fixed && tile > 256 && !AI.cancel) {
        console.warn(`denoise: ${tile}px tiles failed (${e.message}), retrying at ${tile / 2}px`);
        tile /= 2;
        continue;
      }
      throw e;
    }
  }
}

async function runTiles(rgba, W, H, tile, onProgress) {
  const ort = AI.ort, sess = AI.session;
  const inName = sess.inputNames[0], outName = sess.outputNames[0];
  const half = modelIsHalf(sess), H2F = half ? halfToFloatLUT() : null;
  const OV = AI.overlap;
  // Networks with several downsampling stages need sides that are a multiple of 64,
  // or they return a differently sized tensor and everything after this is garbage.
  const round64 = n => Math.max(64, Math.ceil(n / 64) * 64);
  const T = modelFixedSize(sess) || Math.min(round64(tile), round64(Math.max(W, H) + 2 * OV));
  const step = Math.max(64, T - OV * 2);

  // Tiles overhang the frame by the overlap and sample replicated edge pixels.
  // Convolutions zero-pad internally, which darkens the outermost pixels of every
  // tile; overhanging puts that artefact outside the picture instead of on its border.
  const starts = (n) => {
    const out = [], last = n + OV - T;
    for (let p = -OV; p < last; p += step) out.push(p);
    out.push(Math.max(-OV, last));
    return [...new Set(out)];
  };
  const xs = starts(W), ys = starts(H);
  const acc = new Float32Array(W * H * 3), wsum = new Float32Array(W * H);
  let done = 0;
  const total = xs.length * ys.length;

  for (const y0 of ys) {
    for (const x0 of xs) {
      if (AI.cancel) throw new Error('cancelled');
      const input = tileToTensor(ort, rgba, W, H, x0, y0, T, T, half);
      let res;
      try { res = await sess.run({ [inName]: input }); }
      catch (e) { if (done === 0) e.firstTile = true; throw e; }
      const tensor = res[outName];
      let o = tensor.data;
      if (half) { const f = new Float32Array(o.length); for (let i = 0; i < o.length; i++) f[i] = H2F[o[i]]; o = f; }
      const plane = T * T;
      for (let y = 0; y < T; y++) {
        const gy = y0 + y;
        if (gy < 0 || gy >= H) continue;
        const wy = featherWeight(y, T, OV);
        for (let x = 0; x < T; x++) {
          const gx = x0 + x;
          if (gx < 0 || gx >= W) continue;
          const w = wy * featherWeight(x, T, OV);
          const si = y * T + x, di = (gy * W + gx) * 3;
          acc[di] += o[si] * w;
          acc[di + 1] += o[plane + si] * w;
          acc[di + 2] += o[2 * plane + si] * w;
          wsum[gy * W + gx] += w;
        }
      }
      if (tensor.dispose) tensor.dispose();
      done++;
      if (onProgress) onProgress(`Denoising tile ${done} of ${total} · ${AI.label}`);
      await new Promise(r => setTimeout(r, 0));   // let the UI breathe
    }
  }
  let repaired = 0;
  for (let i = 0, p = 0, q = 0; i < W * H; i++, p += 3, q += 4) {
    const w = wsum[i];
    for (let ch = 0; ch < 3; ch++) {
      const v = w > 0 ? acc[p + ch] / w : NaN;
      // never leave a hole: anything uncovered or non-finite keeps the original pixel
      if (Number.isFinite(v)) acc[p + ch] = v;
      else { acc[p + ch] = rgba[q + ch] / 255; repaired++; }
    }
  }
  if (repaired) console.warn('denoise: kept source pixels for', repaired / 3, 'px');
  return acc;
}

/* ---------- the command ---------- */
async function aiDenoise(opts) {
  const im = IM();
  if (!im) { toast('Open a photo first'); return; }
  if (!AI.session) { aiModelDialog(); return; }
  opts = Object.assign({ strength: 1 }, opts);
  AI.cancel = false;

  try {
    // Render the current develop at full size. Exposure matters: the model must
    // see the noise as it will actually appear, not as it sits in the raw file.
    await busy('Preparing the frame');
    const G = geom(im.s, im.w, im.h);
    let W = Math.round(G.outW), H = Math.round(G.outH);
    const MAXPX = 40e6;
    if (W * H > MAXPX) { const k = Math.sqrt(MAXPX / (W * H)); W = Math.round(W * k); H = Math.round(H * k); }

    const clean = Object.assign({}, JSON.parse(JSON.stringify(im.s)), {
      nrLum: 0, nrColor: 0, sharpen: 0, grain: 0
    });
    const saved = im.s;
    let rgba;
    try {
      im.s = clean;
      const R = develop(im, W, H, [1, 1], [.5, .5], true);
      rgba = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, R.out.fb);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    } finally { im.s = saved; freeExport(); }

    const t0 = performance.now();
    const out = await runModel(rgba, W, H, m => busy(m));
    const secs = ((performance.now() - t0) / 1000).toFixed(1);

    // blend, then hand back a new image with the result baked in
    await busy('Building the denoised photo');
    const half = new Uint16Array(W * H * 4);
    const S2LH = srgbToLinearHalfLUT(), ONE = toHalf(1);
    const k = clamp(opts.strength, 0, 1);
    for (let i = 0, p = 0, q = 0; i < W * H; i++, p += 3, q += 4) {
      for (let ch = 0; ch < 3; ch++) {
        const src = rgba[q + ch] / 255;
        const v = clamp(src + (out[p + ch] - src) * k, 0, 1);
        half[q + ch] = S2LH[Math.round(v * 65535)];
      }
      half[q + 3] = ONE;
    }

    const name = im.name.replace(/\.[^.]+$/, '') + ' \u00b7 denoised';
    const ni = imageFromLinear(name, W, H, half, im.meta);
    ni.s = defaults();                     // the develop is baked into the pixels
    A.imgs.splice(A.cur + 1, 0, ni);
    buildStrip();
    selectImage(A.cur + 1);
    toast(`Denoised in ${secs}s on ${AI.label} \u00b7 new frame added`);
  } catch (e) {
    console.error(e);
    if (String(e.message) !== 'cancelled') showError('Denoise failed', [String(e.message)]);
  } finally { busy(null); }
}

/* sRGB code value -> half float of the matching linear value */
let _s2lh = null;
function srgbToLinearHalfLUT() {
  if (_s2lh) return _s2lh;
  _s2lh = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) {
    const v = i / 65535;
    _s2lh[i] = toHalf(v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  }
  return _s2lh;
}

/* ---------- installing ---------- */
/* files: [{name, bytes}] — one .onnx plus any .onnx.data / .bin siblings */
async function installModelFiles(files) {
  const main = files.find(f => /\.onnx$/i.test(f.name));
  const ext = files.filter(f => f !== main && /\.(data|bin|onnx_data)$/i.test(f.name));
  if (!main) {
    if (ext.length) throw new Error('that is only the weights file — select the .onnx as well');
    throw new Error('no .onnx file in that selection');
  }
  const rec = {
    main: new Uint8Array(main.bytes),
    ext: ext.map(f => ({ path: f.name, data: new Uint8Array(f.bytes) }))
  };
  await modelPut(main.name, rec);
  await loadModel(main.name, rec, m => busy(m));
  const mb = (rec.main.length + rec.ext.reduce((a, e) => a + e.data.length, 0)) / 1e6;
  return { name: main.name, parts: 1 + rec.ext.length, mb: mb.toFixed(0) };
}

/* ---------- model management ---------- */
async function aiModelDialog() {
  const installed = await modelList();
  document.getElementById('card').innerHTML = `
    <h4>Neural denoise model</h4>
    <div class="cbody">
      <div class="hint">Safelight ships the runtime but not a model — they are 60–130 MB and licensed
      separately. Install the <b>.onnx</b> file, and if the download also came with an
      <b>.onnx.data</b> file, select both together. Cached afterwards, so this is a one-off.</div>
      <div class="field"><span>Installed</span><select id="aiPick">${installed.length
      ? installed.map(k => `<option>${k}</option>`).join('')
      : '<option value="">none yet</option>'}</select></div>
      <div class="field"><span>Add a model</span><button class="tb" id="aiAdd">Choose files…</button></div>
      <div class="field"><span>Strength</span><input type="number" id="aiStr" min="10" max="100" step="5" value="100"></div>
      <div class="field"><span>Device</span><select id="aiDev">
        <option value="auto">Auto (GPU if available)</option><option value="gpu">GPU</option><option value="cpu">CPU</option>
      </select></div>
      <div class="hint">Suggested: SCUNet colour real, or NAFNet SIDD. NAFNet is several times faster than
      SCUNet, and an fp16 export of either runs about twice as fast on a GPU. You can also drag the
      model files straight onto the window.</div>
    </div>
    <div class="foot">
      <button class="tb" id="aiCancel">Close</button>
      <button class="tb primary" id="aiRun"${installed.length ? '' : ' disabled'}>Denoise</button>
    </div>`;
  document.getElementById('aiDev').value = AI.device;
  document.getElementById('modal').classList.add('open');
  document.getElementById('aiCancel').onclick = () => document.getElementById('modal').classList.remove('open');
  document.getElementById('aiAdd').onclick = async () => {
    const picked = await N.openDialog();
    if (!picked.length) return;
    document.getElementById('modal').classList.remove('open');
    await busy('Installing the model');
    try {
      const r = await installModelFiles(picked);
      toast(`Model ready: ${r.name} · ${r.mb} MB · ${AI.label}`);
      aiModelDialog();
    } catch (e) { showError('That model would not load', [String(e.message)]); }
    finally { busy(null); }
  };
  document.getElementById('aiRun').onclick = async () => {
    const key = document.getElementById('aiPick').value;
    const strength = (parseInt(document.getElementById('aiStr').value) || 100) / 100;
    AI.device = document.getElementById('aiDev').value;
    N.storeSet({ aiDevice: AI.device });
    document.getElementById('modal').classList.remove('open');
    try {
      if (!AI.session || AI.modelName !== key || AI.loadedDevice !== AI.device) {
        await busy('Loading ' + key); await loadModel(key, null, m => busy(m));
      }
    } catch (e) { busy(null); showError('Could not load the model', [String(e.message)]); return; }
    aiDenoise({ strength });
  };
}

/* ---------- wiring ---------- */
document.addEventListener('DOMContentLoaded', () => {
  if (!window.native) return;
  N.storeGet().then(st => { if (st && ['auto', 'gpu', 'cpu'].includes(st.aiDevice)) AI.device = st.aiDevice; });
  // sit the button next to the measurement-based one in Detail
  const chips = [...document.querySelectorAll('.chip')].find(c => c.textContent === 'Auto denoise');
  if (!chips) return;
  const b = document.createElement('div');
  b.className = 'chip'; b.textContent = 'Neural denoise…';
  b.title = 'Run a trained model over the frame';
  b.onclick = () => aiModelDialog();
  chips.parentElement.append(b);
});