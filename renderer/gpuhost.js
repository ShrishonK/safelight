/* ============================================================
   gpuhost.js — a GPU session for the batch denoiser that can be
   thrown away and rebuilt
   ------------------------------------------------------------
   ONNX Runtime keeps one WebGPU device for the life of its page. If
   that device is lost — the computer sleeps, the display driver
   resets, Windows reclaims the GPU — every later run on it simply
   never answers, and a batch would wait on it forever.

   So the batch's runtime lives in a hidden frame of its own, with its
   own copy of ONNX Runtime and its own GPU device. When a run stalls
   or the device reports itself lost, the frame is removed — taking the
   dead device with it — and a fresh one is built, and the frame that
   was in progress starts again.
   ============================================================ */
'use strict';

const GH = { frame: null, win: null, ort: null, session: null, info: '', lost: false, gen: 0 };

/* a test can swap in a CPU runtime here; the app itself only ever asks for the GPU */
let GH_PROVIDERS = ['webgpu'];

async function ghCreate(rec) {
  ghDestroy();
  const gen = ++GH.gen;
  const f = document.createElement('iframe');
  f.style.display = 'none';
  f.setAttribute('aria-hidden', 'true');
  // srcdoc shares this page's origin and base URL, so the runtime loads from the app as usual
  f.srcdoc = '<!doctype html><meta charset="utf-8"><script src="vendor/ort/ort.min.js"></scr' + 'ipt>';
  const loaded = new Promise((res, rej) => {
    f.onload = res;
    setTimeout(() => rej(new Error('the GPU runtime did not start')), 60000);
  });
  document.body.append(f);
  await loaded;
  const w = f.contentWindow, ort = w && w.ort;
  if (!ort) { f.remove(); throw new Error('the GPU runtime did not load'); }
  ort.env.wasm.wasmPaths = new URL('vendor/ort/', document.baseURI).href;
  ort.env.wasm.numThreads = 1;
  ort.env.webgpu.powerPreference = 'high-performance';
  ort.env.logLevel = 'error';
  if (GH_PROVIDERS[0] === 'webgpu') {
    let adapter = null;
    try { adapter = w.navigator.gpu && await w.navigator.gpu.requestAdapter({ powerPreference: 'high-performance' }); } catch { adapter = null; }
    if (!adapter) { f.remove(); throw new Error('no WebGPU adapter'); }
  }
  // the runtime checks its inputs against its own frame's types, so hand it copies made there
  const opts = { executionProviders: GH_PROVIDERS.slice(), graphOptimizationLevel: 'all' };
  if (rec.ext && rec.ext.length) opts.externalData = rec.ext.map(e => ({ path: e.path, data: new w.Uint8Array(e.data) }));
  let session;
  try { session = await ort.InferenceSession.create(new w.Uint8Array(rec.main), opts); }
  catch (e) { f.remove(); throw e; }
  if (GH_PROVIDERS[0] === 'webgpu' && !(ort.env.webgpu && ort.env.webgpu.adapter)) {
    try { await session.release(); } catch { }
    f.remove();
    throw new Error('the GPU session came up without WebGPU');
  }
  Object.assign(GH, { frame: f, win: w, ort, session, lost: false });
  // which card it is: the 3060 reports as NVIDIA "ampere", a 1660 Ti as "turing"
  GH.info = '';
  try {
    const a = ort.env.webgpu.adapter, i = a && (a.info || (a.requestAdapterInfo && await a.requestAdapterInfo()));
    if (i) GH.info = [i.vendor, i.architecture, i.description].filter(Boolean).join(' ').trim();
  } catch { }
  // a lost device never answers again: notice it, so the next tile rebuilds instead of waiting
  try {
    Promise.resolve(ort.env.webgpu.device).then(dev => {
      if (dev && dev.lost) dev.lost.then(info => {
        if (GH.gen !== gen) return;
        GH.lost = true;
        console.warn('batch denoise: GPU device lost —', info && (info.message || info.reason));
      });
    }).catch(() => { });
  } catch { }
  console.log('batch denoise: GPU runtime ready' + (GH.info ? ' on ' + GH.info : ''));
  return GH;
}

function ghDestroy() {
  const { session, frame } = GH;
  GH.frame = null; GH.win = null; GH.ort = null; GH.session = null; GH.lost = false;
  GH.gen++;
  // a session on a lost device may never answer release(): don't wait for it
  if (session) { try { session.release().catch(() => { }); } catch { } }
  if (frame) frame.remove();
}

function ghAlive() { return !!(GH.session && !GH.lost); }
