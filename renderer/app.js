/* ============================================================
   Safelight — a raw & photo developer
   p1: state, controls, curve editor, histogram, filmstrip
   ============================================================ */
'use strict';

const $ = (s, r) => (r || document).querySelector(s);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const HSL_BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
const MAXM = 6, MAXBRUSH = 4;

function idc() { return Math.random().toString(36).slice(2, 9); }

function defCurve() { return [[0, 0], [1, 1]]; }

function defaults() {
  return {
    // geometry
    rot90: 0, flipH: false, flipV: false, straighten: 0,
    crop: { x: 0, y: 0, w: 1, h: 1 }, cropAspect: 0,
    // white balance + basic
    temp: 0, tint: 0, exposure: 0, contrast: 0,
    highlights: 0, shadows: 0, whites: 0, blacks: 0,
    texture: 0, clarity: 0, dehaze: 0, vibrance: 0, saturation: 0,
    // curves
    curve: { rgb: defCurve(), r: defCurve(), g: defCurve(), b: defCurve() },
    // hsl
    hslH: new Array(8).fill(0), hslS: new Array(8).fill(0), hslL: new Array(8).fill(0),
    // color grading
    shHue: 220, shSat: 0, miHue: 0, miSat: 0, hiHue: 40, hiSat: 0, cgBal: 0,
    // detail
    sharpen: 0, sharpRadius: 1.0, sharpDetail: 25, nrLum: 0, nrColor: 0, nrDetail: 50,
    // effects
    vignette: 0, vigFeather: 50, vigRound: 0, grain: 0, grainSize: 25,
    // masks
    masks: []
  };
}

function defMaskAdj() {
  return { exposure: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0, temp: 0, tint: 0, texture: 0 };
}

function newMask(type, w, h) {
  const m = { id: idc(), type, name: '', invert: false, opacity: 100, adj: defMaskAdj(), brush: -1, show: true };
  if (type === 'linear') m.geo = { x0: .5, y0: .25, x1: .5, y1: .75 };
  if (type === 'radial') m.geo = { cx: .5, cy: .5, rx: .28, ry: .28, ang: 0, feather: 50 };
  if (type === 'lum') m.geo = { lo: 0, hi: .35, feather: .12 };
  if (type === 'color') m.geo = { hue: 210, tol: 30, satMin: .08 };
  if (type === 'brush') m.geo = { size: 12, soft: 60, flow: 60 };
  return m;
}

const MASKLABEL = { linear: 'Linear', radial: 'Radial', brush: 'Brush', lum: 'Luminance', color: 'Color' };

/* ---------------- global state ---------------- */
const A = {
  imgs: [], cur: -1, dummy: defaults(),
  selMask: -1, curveCh: 'rgb', before: false, cropMode: false,
  view: { zoom: 0, ox: 0, oy: 0, fit: true },
  clipboard: null, presets: {}, hist: null, painting: false,
  drag: null
};
const S = () => (A.cur >= 0 ? A.imgs[A.cur].s : A.dummy);
const IM = () => (A.cur >= 0 ? A.imgs[A.cur] : null);

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 1600);
}

/* ---------------- control factory ---------------- */
const ctrls = [];

function fmtVal(spec, v) {
  if (spec.fmt === 'int') return String(Math.round(v));
  if (spec.fmt === 'deg') return v.toFixed(1) + '°';
  return v.toFixed(2);
}

/* spec: {k,label,min,max,step,def,fmt,scope} scope() returns the object holding k */
function mkSlider(parent, spec) {
  const row = document.createElement('div'); row.className = 'row';
  const lab = document.createElement('label'); lab.textContent = spec.label;
  const val = document.createElement('input'); val.className = 'val'; val.type = 'text'; val.spellcheck = false;
  row.append(lab, val);
  const sr = document.createElement('div'); sr.className = 'srow';
  const rng = document.createElement('input'); rng.type = 'range';
  rng.min = spec.min; rng.max = spec.max; rng.step = spec.step;
  sr.append(rng); parent.append(row, sr);

  const get = () => { const o = spec.scope(); return o ? o[spec.k] : spec.def; };
  const set = (v, commit) => {
    const o = spec.scope(); if (!o) return;
    o[spec.k] = clamp(v, spec.min, spec.max);
    c.sync(); requestRender(commit !== false);
  };
  const c = {
    spec, sync() {
      const v = get(); rng.value = v; val.value = fmtVal(spec, v);
      row.classList.toggle('mod', Math.abs(v - spec.def) > 1e-6);
    }
  };
  rng.addEventListener('input', () => set(parseFloat(rng.value)));
  rng.addEventListener('dblclick', () => set(spec.def));
  lab.addEventListener('dblclick', () => set(spec.def));
  val.addEventListener('change', () => { const n = parseFloat(val.value); if (!isNaN(n)) set(n); else c.sync(); });
  val.addEventListener('keydown', e => { if (e.key === 'Enter') val.blur(); });

  // horizontal scrub on label / value
  const scrub = el => el.addEventListener('pointerdown', e => {
    if (e.target === val && document.activeElement === val) return;
    el.setPointerCapture(e.pointerId);
    const x0 = e.clientX, v0 = get(), span = (spec.max - spec.min);
    const move = ev => {
      const dx = (ev.clientX - x0) / 260 * span * (ev.shiftKey ? .2 : 1);
      let nv = v0 + dx;
      nv = Math.round(nv / spec.step) * spec.step;
      set(nv);
    };
    const up = () => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); requestRender(true); };
    el.addEventListener('pointermove', move); el.addEventListener('pointerup', up);
  });
  scrub(lab); scrub(val);
  ctrls.push(c); c.sync();
  return c;
}

function mkSection(parent, title, open, build) {
  const s = document.createElement('div'); s.className = 'sect' + (open ? '' : ' closed');
  const h = document.createElement('h3'); h.textContent = title;
  const b = document.createElement('div'); b.className = 'body';
  s.append(h, b); parent.append(s);
  h.addEventListener('click', () => s.classList.toggle('closed'));
  build(b, s, h);
  return s;
}

function toggleChip(parent, label, get, set) {
  const c = document.createElement('div'); c.className = 'chip'; c.textContent = label;
  c.addEventListener('click', () => { set(!get()); c.classList.toggle('on', get()); requestRender(true); });
  parent.append(c);
  const o = { sync: () => c.classList.toggle('on', get()) };
  ctrls.push(o); o.sync(); return c;
}

/* ---------------- monotone cubic spline ---------------- */
function splineFn(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0]);
  const n = p.length;
  if (n < 2) return x => x;
  const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = xs[i + 1] - xs[i] || 1e-6; dy[i] = ys[i + 1] - ys[i]; m[i] = dy[i] / dx[i]; }
  const t = new Array(n);
  t[0] = m[0]; t[n - 1] = m[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = (m[i - 1] * m[i] <= 0) ? 0 : (m[i - 1] + m[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
    if (s > 9) { const f = 3 / Math.sqrt(s); t[i] = f * a * m[i]; t[i + 1] = f * b * m[i]; }
  }
  return x => {
    if (x <= xs[0]) return clamp(ys[0] + t[0] * (x - xs[0]), 0, 1);
    if (x >= xs[n - 1]) return clamp(ys[n - 1] + t[n - 1] * (x - xs[n - 1]), 0, 1);
    let i = 0; while (i < n - 2 && x > xs[i + 1]) i++;
    const h = dx[i], u = (x - xs[i]) / h, u2 = u * u, u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
    return clamp(h00 * ys[i] + h10 * h * t[i] + h01 * ys[i + 1] + h11 * h * t[i + 1], 0, 1);
  };
}

function curveIsIdentity(c) {
  return c.length === 2 && c[0][0] === 0 && c[0][1] === 0 && c[1][0] === 1 && c[1][1] === 1;
}

function buildLUT() {
  const N = 1024, data = new Float32Array(N * 4);
  const f = { rgb: splineFn(S().curve.rgb), r: splineFn(S().curve.r), g: splineFn(S().curve.g), b: splineFn(S().curve.b) };
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    data[i * 4] = f.r(x); data[i * 4 + 1] = f.g(x); data[i * 4 + 2] = f.b(x); data[i * 4 + 3] = f.rgb(x);
  }
  return data;
}

/* ---------------- tone curve editor ---------------- */
function drawCurve() {
  const cv = $('#curve'), g = cv.getContext('2d');
  const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  const W = Math.max(80, Math.round(r.width * dpr)), H = W;
  if (cv.width !== W) { cv.width = W; cv.height = H; }
  g.clearRect(0, 0, W, H);
  // histogram behind
  if (A.hist) {
    const h = A.hist.lum, mx = A.hist.max || 1;
    g.fillStyle = 'rgba(120,140,160,.16)';
    g.beginPath(); g.moveTo(0, H);
    for (let i = 0; i < 256; i++) g.lineTo(i / 255 * W, H - Math.pow(h[i] / mx, .42) * H * .92);
    g.lineTo(W, H); g.fill();
  }
  // grid
  g.strokeStyle = 'rgba(255,255,255,.055)'; g.lineWidth = 1;
  for (let i = 1; i < 4; i++) {
    g.beginPath(); g.moveTo(W * i / 4, 0); g.lineTo(W * i / 4, H); g.stroke();
    g.beginPath(); g.moveTo(0, H * i / 4); g.lineTo(W, H * i / 4); g.stroke();
  }
  g.strokeStyle = 'rgba(255,255,255,.09)'; g.setLineDash([3, 4]);
  g.beginPath(); g.moveTo(0, H); g.lineTo(W, 0); g.stroke(); g.setLineDash([]);
  // curve
  const col = { rgb: '#e9e9e9', r: '#e8756f', g: '#7fd484', b: '#7fa6e8' }[A.curveCh];
  const pts = S().curve[A.curveCh], f = splineFn(pts);
  g.strokeStyle = col; g.lineWidth = 1.6 * dpr; g.beginPath();
  for (let i = 0; i <= 128; i++) { const x = i / 128; const y = f(x); i ? g.lineTo(x * W, (1 - y) * H) : g.moveTo(x * W, (1 - y) * H); }
  g.stroke();
  // points
  pts.forEach((p, i) => {
    g.beginPath(); g.arc(p[0] * W, (1 - p[1]) * H, (A.curvePick === i ? 5.5 : 4) * dpr, 0, 6.2832);
    g.fillStyle = A.curvePick === i ? col : '#0d1116'; g.strokeStyle = col; g.lineWidth = 1.4 * dpr;
    g.fill(); g.stroke();
  });
}

function curveHit(pts, x, y) {
  let best = -1, bd = 0.045;
  pts.forEach((p, i) => { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = i; } });
  return best;
}

function wireCurve(cv) {
  const pos = e => {
    const r = cv.getBoundingClientRect();
    return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp(1 - (e.clientY - r.top) / r.height, 0, 1)];
  };
  cv.addEventListener('pointerdown', e => {
    if (A.cur < 0) return;
    e.preventDefault(); cv.setPointerCapture(e.pointerId);
    const pts = S().curve[A.curveCh];
    const [x, y] = pos(e);
    let i = curveHit(pts, x, y);
    if (e.button === 2 || e.altKey) { if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); A.curvePick = -1; drawCurve(); requestRender(true); } return; }
    if (i < 0) { pts.push([x, y]); pts.sort((a, b) => a[0] - b[0]); i = pts.findIndex(p => p[0] === x && p[1] === y); }
    A.curvePick = i;
    const isEnd = (i === 0 || i === pts.length - 1);
    const move = ev => {
      const [mx, my] = pos(ev);
      const p = pts[A.curvePick];
      if (!isEnd) {
        const lo = pts[A.curvePick - 1][0] + .004, hi = pts[A.curvePick + 1][0] - .004;
        p[0] = clamp(mx, lo, hi);
      }
      p[1] = my;
      drawCurve(); requestRender(false);
    };
    const up = () => {
      cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up);
      requestRender(true); syncCurveBadge();
    };
    cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up);
    drawCurve(); requestRender(false);
  });
  cv.addEventListener('contextmenu', e => e.preventDefault());
  cv.addEventListener('dblclick', () => { S().curve[A.curveCh] = defCurve(); A.curvePick = -1; drawCurve(); requestRender(true); syncCurveBadge(); });
}

function syncCurveBadge() {
  const b = $('#curveBadge'); if (!b) return;
  const c = S().curve;
  const n = ['rgb', 'r', 'g', 'b'].filter(k => !curveIsIdentity(c[k])).length;
  b.textContent = n ? n + ' active' : '';
}

/* ---------------- histogram ---------------- */
function drawHisto() {
  const cv = $('#histo'), g = cv.getContext('2d');
  const r = cv.getBoundingClientRect(), dpr = Math.min(devicePixelRatio || 1, 2);
  const W = Math.max(80, Math.round(r.width * dpr)), H = Math.round(78 * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  g.clearRect(0, 0, W, H);
  g.strokeStyle = 'rgba(255,255,255,.05)';
  for (let i = 1; i < 4; i++) { g.beginPath(); g.moveTo(W * i / 4, 0); g.lineTo(W * i / 4, H); g.stroke(); }
  if (!A.hist) return;
  const mx = A.hist.max || 1;
  g.globalCompositeOperation = 'screen';
  const chans = [['r', 'rgba(220,70,60,.75)'], ['g', 'rgba(70,200,90,.72)'], ['b', 'rgba(70,120,230,.75)']];
  for (const [k, col] of chans) {
    const h = A.hist[k];
    g.fillStyle = col; g.beginPath(); g.moveTo(0, H);
    for (let i = 0; i < 256; i++) g.lineTo(i / 255 * W, H - Math.pow(h[i] / mx, .42) * H * .95);
    g.lineTo(W, H); g.fill();
  }
  g.globalCompositeOperation = 'source-over';
  // clipping markers
  const shad = A.hist.clipLo, high = A.hist.clipHi;
  if (high > 0.0005) { g.fillStyle = 'rgba(255,92,77,.9)'; g.fillRect(W - 6 * dpr, 0, 6 * dpr, 6 * dpr); }
  if (shad > 0.0005) { g.fillStyle = 'rgba(120,170,255,.9)'; g.fillRect(0, 0, 6 * dpr, 6 * dpr); }
}


/* ============================================================
   noise measurement + auto denoise
   Noise only exists at 1:1, so this develops a native-resolution
   window with NR, sharpening and local contrast switched off, then
   reads the high-frequency energy that is left.
   ============================================================ */
function measureNoise(im) {
  const s = im.s, G = geom(s, im.w, im.h);
  const W = Math.min(256, Math.round(G.outW)), H = Math.min(256, Math.round(G.outH));
  const VS = [W / G.outW, H / G.outH];
  const probe = Object.assign({}, JSON.parse(JSON.stringify(s)), {
    nrLum: 0, nrColor: 0, sharpen: 0, clarity: 0, texture: 0, dehaze: 0,
    grain: 0, vignette: 0, masks: []
  });
  // one window can land on something atypically flat (a black jacket) or busy
  // (a star field), so sample a spread and take the median
  const spots = [[.5, .5], [.3, .28], [.7, .28], [.3, .72], [.7, .72]];
  const saved = im.s;
  const lums = [], chrs = [];
  try {
    im.s = probe;
    for (const spot of spots) {
      const vo = [clamp(spot[0], VS[0] / 2, 1 - VS[0] / 2), clamp(spot[1], VS[1] / 2, 1 - VS[1] / 2)];
      const R = develop(im, W, H, VS, vo, true);
      const px = new Uint8Array(W * H * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, R.out.fb);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const r = windowNoise(px, W, H);
      lums.push(r.lum); chrs.push(r.chroma);
    }
  } finally {
    im.s = saved;
    freeExport();
  }
  const mid = a => { a.sort((p, q) => p - q); return a[a.length >> 1] || 0; };
  return { lum: mid(lums), chroma: mid(chrs), spots: spots.length };
}

/* high-frequency energy of one window, in output-referred sigma */
function windowNoise(px, W, H) {
  // A plain mean would count every star and edge as noise, and a median lands on
  // 8-bit quantisation steps, so take a trimmed mean of the quiet middle of the
  // distribution: flat areas, sub-quantum resolution.
  const lum = [], chr = [];
  const Y = (i) => (0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]) / 255;
  const C1 = (i) => (px[i] - px[i + 2]) / 255;                       // red - blue
  const C2 = (i) => (px[i + 1] - (px[i] + px[i + 2]) * 0.5) / 255;   // green - magenta
  const lap = (f, i) => Math.abs(4 * f(i) - f(i - 4) - f(i + 4) - f(i - W * 4) - f(i + W * 4));
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      lum.push(lap(Y, i));
      chr.push(Math.max(lap(C1, i), lap(C2, i)));
    }
  }
  const band = a => {
    a.sort((p, q) => p - q);
    const lo = Math.floor(a.length * 0.45), hi = Math.floor(a.length * 0.90);
    let t = 0; for (let i = lo; i < hi; i++) t += a[i];
    return t / Math.max(1, hi - lo);
  };
  const k = 1.253 / Math.sqrt(20);   // mean|.| -> sigma, undo the Laplacian gain
  return { lum: band(lum) * k, chroma: band(chr) * k };
}

function autoDenoise() {
  const im = IM();
  if (!im) { toast('Open a photo first'); return null; }
  const n = measureNoise(im);
  const s = im.s;
  // floors: sensor read noise below these is not worth smoothing
  // calibrated against underexposed high-ISO night frames: a lifted one measures
  // around 3.5 / 3.0 and wants roughly 0.35 luminance, 0.55 colour
  s.nrLum = +clamp((n.lum - 0.0012) * 150, 0, 0.75).toFixed(2);
  s.nrColor = +clamp((n.chroma - 0.0010) * 260, 0, 0.90).toFixed(2);
  // heavy smoothing needs a higher sharpening threshold or it re-etches the grain
  if (s.nrDetail === undefined) s.nrDetail = 50;
  // more smoothing needs a higher detail threshold to hold edges and stars
  s.nrDetail = Math.round(clamp(45 + s.nrLum * 45, 45, 85));
  if (s.sharpen > 0 && s.nrLum > 0.25) s.sharpDetail = Math.max(s.sharpDetail, 60);
  syncAll();
  requestRender(true);
  toast(`Noise ${(n.lum * 1000).toFixed(1)} lum / ${(n.chroma * 1000).toFixed(1)} colour → NR ${s.nrLum} / ${s.nrColor}`);
  return { n, applied: { nrLum: s.nrLum, nrColor: s.nrColor } };
}

/* ---------------- filmstrip ---------------- */
function buildStrip() {
  const st = $('#strip'); st.innerHTML = '';
  if (!A.imgs.length) { st.innerHTML = '<div class="striphint">Filmstrip<br>drop files anywhere</div>'; return; }
  A.imgs.forEach((im, i) => {
    const d = document.createElement('div'); d.className = 'thumb' + (i === A.cur ? ' sel' : '');
    d.innerHTML = `<img src="${im.thumb}" alt=""><div class="n">${im.name.slice(0, 12)}</div>` +
      (im.dirty ? '<div class="edited"></div>' : '');
    d.addEventListener('click', () => selectImage(i));
    st.append(d);
  });
}
/* ============================================================
   p2: WebGL2 engine — shaders, FBOs, pipeline
   ============================================================ */

let gl, GLQ, PROG = {}, FBO = {}, LUTTEX = null, BRUSHTEX = [], floatOK = true;

const VS = `#version 300 es
in vec2 p; out vec2 v;
void main(){ v = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;

const VS_FLIP = `#version 300 es
in vec2 p; out vec2 v;
void main(){ v = p*0.5+0.5; gl_Position = vec4(p.x,-p.y,0.,1.); }`;

const COMMON = `
precision highp float; precision highp sampler2D;
const vec3 LW = vec3(0.2126,0.7152,0.0722);
float luma(vec3 c){ return dot(c,LW); }
vec3 s2l(vec3 c){ c=max(c,0.); return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(vec3(0.04045),c)); }
vec3 l2s(vec3 c){ c=max(c,0.); return mix(c*12.92, 1.055*pow(c,vec3(1./2.4))-0.055, step(vec3(0.0031308),c)); }
vec3 rgb2hsv(vec3 c){
  vec4 K = vec4(0., -1./3., 2./3., -1.);
  vec4 p = mix(vec4(c.bg,K.wz), vec4(c.gb,K.xy), step(c.b,c.g));
  vec4 q = mix(vec4(p.xyw,c.r), vec4(c.r,p.yzx), step(p.x,c.r));
  float d = q.x-min(q.w,q.y);
  return vec3(abs(q.z+(q.w-q.y)/(6.*d+1e-10)), d/(q.x+1e-10), q.x);
}
vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1., 2./3., 1./3., 3.);
  vec3 p = abs(fract(c.xxx+K.xyz)*6.-K.www);
  return c.z*mix(K.xxx, clamp(p-K.xxx,0.,1.), c.y);
}
vec3 wbGain(float tp, float tn){
  tp/=100.; tn/=100.;
  return vec3(1.+tp*0.42+tn*0.06, 1.-tn*0.34-abs(tp)*0.015, 1.-tp*0.42+tn*0.06);
}
// exposure/contrast/hi/sh/sat/wb applied in linear light
vec3 toneOps(vec3 c, float ex, float con, float hi, float sh, float sat, float tp, float tn){
  c *= wbGain(tp,tn);
  c *= exp2(ex);
  float L = max(luma(c),0.);
  float t = L/(L+1.0);
  if(hi!=0.){ c *= 1.+hi*smoothstep(0.26,0.72,t)*0.95; }
  if(sh!=0.){ c *= 1.+sh*(1.-smoothstep(0.02,0.34,t))*1.7; }
  if(con!=0.){ c = 0.18*pow(max(c,1e-5)/0.18, vec3(1.+con*0.7)); }
  if(sat!=0.){ float g = luma(c); c = mix(vec3(g), c, 1.+sat); }
  return c;
}`;

/* ---------- pass 1 : geometry + white balance + tone ---------- */
const FS_BASE = `#version 300 es
${COMMON}
uniform sampler2D uSrc;
uniform vec2 uSrcSize, uOutSize, uVS, uVO, uCenter;
uniform mat2 uM;
uniform float uSrcLinear, uTemp, uTint, uExp, uCon, uHi, uSh, uWh, uBl;
in vec2 v; out vec4 o;
void main(){
  vec2 iuv = (v-0.5)*uVS + uVO;
  vec2 q = (iuv-0.5)*uOutSize;
  vec2 sp = uCenter + uM*q;
  vec2 uv = sp/uSrcSize;
  vec3 c;
  if(any(lessThan(uv,vec2(0.))) || any(greaterThan(uv,vec2(1.)))) { o=vec4(0.,0.,0.,1.); return; }
  vec4 t = texture(uSrc, uv);
  c = uSrcLinear>0.5 ? max(t.rgb,0.) : s2l(t.rgb);
  c *= wbGain(uTemp,uTint);
  c *= exp2(uExp);
  float L = max(luma(c),0.);
  float t2 = L/(L+1.0);
  if(uHi!=0.) c *= 1.+uHi*smoothstep(0.26,0.72,t2)*0.95;
  if(uSh!=0.) c *= 1.+uSh*(1.-smoothstep(0.02,0.34,t2))*1.7;
  if(uWh!=0.) c *= 1.+uWh*smoothstep(0.18,0.95,t2)*0.75;
  if(uBl!=0.) c += uBl*0.055*(1.-smoothstep(0.,0.24,t2));
  if(uCon!=0.) c = 0.18*pow(max(c,1e-5)/0.18, vec3(1.+uCon*0.7));
  o = vec4(max(c,0.),1.);
}`;

/* ---------- separable blur ---------- */
const FS_BLUR = `#version 300 es
${COMMON}
uniform sampler2D uTex; uniform vec2 uDir;
in vec2 v; out vec4 o;
void main(){
  vec3 s = texture(uTex,v).rgb*0.2270270;
  s += (texture(uTex,v+uDir*1.3846).rgb + texture(uTex,v-uDir*1.3846).rgb)*0.3162162;
  s += (texture(uTex,v+uDir*3.2307).rgb + texture(uTex,v-uDir*3.2307).rgb)*0.0702702;
  o = vec4(s,1.);
}`;

/* ---------- downsample (for histogram) ---------- */
const FS_DS = `#version 300 es
${COMMON}
uniform sampler2D uTex; in vec2 v; out vec4 o;
void main(){ o = texture(uTex,v); }`;

/* ---------- display ---------- */
const FS_SHOW = `#version 300 es
${COMMON}
uniform sampler2D uTex, uRaw; uniform float uSplit, uBefore;
in vec2 v; out vec4 o;
void main(){
  vec3 c = texture(uTex,v).rgb;
  if(uBefore>0.5){
    if(uSplit<0.5 || v.x < uSplit) c = l2s(texture(uRaw,v).rgb);
    if(uSplit>0.5 && abs(v.x-uSplit)<0.0012) c = vec3(0.9,0.65,0.24);
  }
  o = vec4(c,1.);
}`;

/* ---------- pass 3 : the developer ---------- */
const FS_FINAL = `#version 300 es
${COMMON}
#define MAXM 6
uniform sampler2D uBase, uBlur, uBlur2, uLUT, uBrush0, uBrush1, uBrush2, uBrush3;
uniform vec2 uTexel, uVS, uVO;
uniform float uAspect, uSeed;
uniform float uClarity, uTexture, uDehaze, uVib, uSat;
uniform float uSharp, uSharpR, uSharpD, uNrL, uNrC, uNrD;
uniform float uVig, uVigF, uVigR, uGrain, uGrainS;
uniform vec3 uCGs, uCGm, uCGh; uniform float uCGbal;
uniform float uHslH[8], uHslS[8], uHslL[8], uHslC[8];
uniform int uMCount, uShowMask;
uniform float uMType[MAXM];
uniform vec4 uMGeoA[MAXM], uMGeoB[MAXM], uMAdjA[MAXM], uMAdjB[MAXM], uMFlags[MAXM];
in vec2 v; out vec4 o;

float hash(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453); }

float maskW(int i, vec2 iuv, vec3 lin){
  float ty = uMType[i]; vec4 ga = uMGeoA[i], gb = uMGeoB[i]; float w = 0.;
  if(ty<1.5){
    vec2 d = ga.zw-ga.xy; float l2 = max(dot(d,d),1e-6);
    w = smoothstep(0.,1.,clamp(dot(iuv-ga.xy,d)/l2,0.,1.));
  } else if(ty<2.5){
    vec2 p = iuv-ga.xy; p.x *= uAspect;
    float ca=cos(gb.x), sa=sin(gb.x);
    vec2 q = vec2(p.x*ca+p.y*sa, -p.x*sa+p.y*ca);
    float d = length(q/max(vec2(ga.z*uAspect,ga.w),vec2(1e-4)));
    float f = clamp(gb.y,0.02,1.);
    w = 1.-smoothstep(1.-f,1.,d);
  } else if(ty<3.5){
    int bi = int(uMFlags[i].z); vec2 bu = vec2(iuv.x,iuv.y);
    if(bi==0) w = texture(uBrush0,bu).a;
    else if(bi==1) w = texture(uBrush1,bu).a;
    else if(bi==2) w = texture(uBrush2,bu).a;
    else w = texture(uBrush3,bu).a;
  } else if(ty<4.5){
    float L = l2s(vec3(max(luma(lin),0.))).r;
    float f = max(gb.z,0.004);
    w = smoothstep(ga.x-f,ga.x+f,L)*(1.-smoothstep(ga.y-f,ga.y+f,L));
  } else {
    vec3 hs = rgb2hsv(clamp(l2s(lin),0.,1.));
    float dh = abs(hs.x*360.-ga.x); dh = min(dh,360.-dh);
    w = (1.-smoothstep(ga.y*0.55,ga.y,dh))*smoothstep(gb.x*0.4,gb.x,hs.y);
  }
  if(uMFlags[i].x>0.5) w = 1.-w;
  return clamp(w,0.,1.)*uMFlags[i].y;
}

void main(){
  vec2 iuv = (v-0.5)*uVS + uVO;
  vec3 c = texture(uBase,v).rgb;
  vec3 low = texture(uBlur,v).rgb;

  // --- noise reduction: two rings for luminance, a chroma pyramid for colour ---
  if(uNrL>0.001){
    float lc = luma(c);
    float sg = 0.014 + 0.20*uNrL;
    vec3 acc = c; float ws = 1.;
    for(int i=0;i<8;i++){
      float a = float(i)*0.7853981 + 0.3927;
      vec2 dir = vec2(cos(a),sin(a));
      vec3 s1 = texture(uBase, v+dir*uTexel*1.5).rgb;
      vec3 s2 = texture(uBase, v+dir*uTexel*3.1).rgb;
      float d1 = luma(s1)-lc, d2 = luma(s2)-lc;
      float w1 = exp(-d1*d1/(sg*sg));
      float w2 = 0.55*exp(-d2*d2/(sg*sg));
      acc += s1*w1 + s2*w2; ws += w1 + w2;
    }
    vec3 den = acc/ws;
    // Split into a smoothed base and a detail layer, then soft-threshold the
    // detail: anything smaller than the noise floor is dropped, anything above
    // it is returned untouched. Edges and stars come back at full strength
    // instead of being averaged away.
    vec3 d = c - den;
    float dl = luma(d);
    float thr = (0.004 + 0.02*uNrL) * (1.0 - 0.92*uNrD);
    float keep = max(abs(dl) - thr, 0.0);
    float scale = abs(dl) > 1e-6 ? keep/abs(dl) : 0.0;
    // a floor so heavily smoothed areas keep some microtexture and don't go plastic
    scale = max(scale, 0.10*uNrD);
    c = den + d*scale;
  }
  if(uNrC>0.001){
    float lc = luma(c);
    vec3 coarse = texture(uBlur2, v).rgb;
    vec3 ref = mix(low, coarse, clamp(uNrC*1.3-0.25,0.,1.));
    vec3 chroma = ref - vec3(luma(ref));
    c = mix(c, vec3(lc)+chroma, clamp(uNrC,0.,1.)*0.95);
  }

  // --- small-radius reference for texture / sharpen ---
  vec3 sm = c*0.36;
  sm += (texture(uBase,v+vec2(uTexel.x,0.)*uSharpR).rgb + texture(uBase,v-vec2(uTexel.x,0.)*uSharpR).rgb)*0.16;
  sm += (texture(uBase,v+vec2(0.,uTexel.y)*uSharpR).rgb + texture(uBase,v-vec2(0.,uTexel.y)*uSharpR).rgb)*0.16;

  // --- masks (local adjustments, linear light) ---
  for(int i=0;i<MAXM;i++){
    if(i>=uMCount) break;
    float w = maskW(i, iuv, c);
    if(w<=0.001) continue;
    vec4 a = uMAdjA[i], b = uMAdjB[i];
    vec3 mc = toneOps(c, a.x, a.y, a.z, a.w, b.x, b.y, b.z);
    if(b.w!=0.) mc += (c-sm)*b.w*2.2;
    c = mix(c, mc, w);
  }

  // --- dehaze ---
  if(uDehaze!=0.){
    float veil = min(low.r,min(low.g,low.b));
    float k = clamp(uDehaze,-1.,1.)*0.55;
    c = (c - k*veil)/max(1.-k*veil,0.15);
    if(uDehaze>0.){ float g=luma(c); c = mix(vec3(g),c,1.+uDehaze*0.22); }
    c = max(c,0.);
  }
  // --- clarity (mid frequency) + texture (high frequency) ---
  if(uClarity!=0.){
    float L = luma(c); float m = 1.-abs(L/(L+1.)-0.5)*1.4;
    c += (c-low)*uClarity*0.9*clamp(m,0.,1.);
    c = max(c,0.);
  }
  if(uTexture!=0.) c = max(c+(c-sm)*uTexture*1.8, 0.);

  // --- sharpen (unsharp with detail threshold) ---
  if(uSharp>0.001){
    vec3 hi = c-sm;
    float e = clamp((abs(luma(hi))-0.004*(1.-uSharpD))*24.,0.,1.);
    c = max(c + hi*uSharp*2.2*mix(1.,e,uSharpD), 0.);
  }

  // --- to display space ---
  vec3 d = clamp(l2s(c),0.,1.);

  // --- tone curve : per-channel then master ---
  d.r = texture(uLUT, vec2(d.r,0.5)).r;
  d.g = texture(uLUT, vec2(d.g,0.5)).g;
  d.b = texture(uLUT, vec2(d.b,0.5)).b;
  d.r = texture(uLUT, vec2(d.r,0.5)).a;
  d.g = texture(uLUT, vec2(d.g,0.5)).a;
  d.b = texture(uLUT, vec2(d.b,0.5)).a;

  // --- HSL by band ---
  {
    vec3 hs = rgb2hsv(d);
    float H = hs.x*360.;
    float hAdj=0., sAdj=0., lAdj=0.;
    for(int i=0;i<8;i++){
      float ctr = uHslC[i];
      float dh = abs(H-ctr); dh = min(dh,360.-dh);
      float w = 1.-smoothstep(22.,58.,dh);
      w *= smoothstep(0.03,0.14,hs.y);
      hAdj += w*uHslH[i]; sAdj += w*uHslS[i]; lAdj += w*uHslL[i];
    }
    if(hAdj!=0.||sAdj!=0.||lAdj!=0.){
      hs.x = fract(hs.x + hAdj*0.00055);
      hs.y = clamp(hs.y*(1.+sAdj*0.011),0.,1.);
      hs.z = clamp(hs.z*(1.+lAdj*0.0085),0.,1.);
      d = hsv2rgb(hs);
    }
  }

  // --- color grading ---
  if(uCGs!=vec3(0.)||uCGm!=vec3(0.)||uCGh!=vec3(0.)){
    float L = clamp(luma(d)+uCGbal*0.3,0.,1.);
    float ws = 1.-smoothstep(0.0,0.55,L);
    float wh = smoothstep(0.45,1.0,L);
    float wm = clamp(1.-ws-wh,0.,1.);
    d = clamp(d + uCGs*ws + uCGm*wm + uCGh*wh, 0., 1.);
  }

  // --- vibrance / saturation ---
  {
    float mx = max(d.r,max(d.g,d.b)), mn = min(d.r,min(d.g,d.b));
    float sat = mx-mn, g = luma(d);
    if(uVib!=0.) d = clamp(mix(vec3(g), d, 1.+uVib*(1.-sat)*1.1), 0., 1.);
    if(uSat!=0.) d = clamp(mix(vec3(luma(d)), d, 1.+uSat), 0., 1.);
  }

  // --- vignette ---
  if(uVig!=0.){
    vec2 p = (iuv-0.5); p.x *= uAspect;
    float r = length(p)/(0.7071*mix(1.,1.28,uVigR));
    float f = clamp(uVigF/100.,0.02,1.);
    float m = smoothstep(1.0,1.0-f,r);
    d = clamp(d*(1.+uVig*(1.-m)*0.95),0.,1.);
  }
  // --- grain ---
  if(uGrain>0.001){
    float sc = mix(1400.,220.,uGrainS/100.);
    float n = hash(floor(iuv*sc)+uSeed)-0.5;
    d = clamp(d + n*uGrain*0.16*(1.-abs(luma(d)-0.4)*0.6), 0., 1.);
  }

  if(uShowMask>=0){
    float w = maskW(uShowMask, iuv, c);
    d = mix(d*0.55, vec3(0.94,0.30,0.22), w*0.62);
  }
  o = vec4(d,1.);
}`;

/* ---------------- gl plumbing ---------------- */
function compile(vsrc, fsrc) {
  const p = gl.createProgram();
  for (const [t, s] of [[gl.VERTEX_SHADER, vsrc], [gl.FRAGMENT_SHADER, fsrc]]) {
    const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      console.error(gl.getShaderInfoLog(sh), s.split('\n').map((l, i) => (i + 1) + ' ' + l).join('\n'));
      throw new Error('shader compile failed');
    }
    gl.attachShader(p, sh);
  }
  gl.bindAttribLocation(p, 0, 'p');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) { const inf = gl.getActiveUniform(p, i); u[inf.name.replace('[0]', '')] = gl.getUniformLocation(p, inf.name); }
  return { p, u };
}

function initGL() {
  const cv = $('#gl');
  gl = cv.getContext('webgl2', { alpha: false, antialias: false, depth: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
  if (!gl) { alert('This browser has no WebGL2. Try Chrome, Edge, Safari 16+ or Firefox.'); throw new Error('no webgl2'); }
  floatOK = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
  gl.getExtension('OES_texture_float_linear');
  GLQ = gl.createVertexArray(); gl.bindVertexArray(GLQ);
  const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  PROG.base = compile(VS, FS_BASE);
  PROG.blur = compile(VS, FS_BLUR);
  PROG.final = compile(VS, FS_FINAL);
  PROG.ds = compile(VS, FS_DS);
  PROG.show = compile(VS_FLIP, FS_SHOW);
  LUTTEX = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, LUTTEX);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  for (let i = 0; i < MAXBRUSH; i++) BRUSHTEX[i] = mkTex();
}

function mkTex() {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
  return t;
}

function fbo(name, w, h, float) {
  w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
  const f = FBO[name];
  if (f && f.w === w && f.h === h && f.float === float) return f;
  if (f) { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fb); }
  const tex = mkTex();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  const useF = float && floatOK;
  if (useF) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  return FBO[name] = { tex, fb, w, h, float };
}

function bindTarget(f) {
  if (f) { gl.bindFramebuffer(gl.FRAMEBUFFER, f.fb); gl.viewport(0, 0, f.w, f.h); }
  else { gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, gl.canvas.width, gl.canvas.height); }
}
function use(pr) { gl.useProgram(pr.p); return pr.u; }
function tex(unit, t) { gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); return unit; }
function draw() { gl.drawArrays(gl.TRIANGLES, 0, 3); }

/* ---------------- geometry ---------------- */
function geom(s, sw, sh) {
  const cw = Math.max(8, s.crop.w * sw), ch = Math.max(8, s.crop.h * sh);
  const a = s.straighten * Math.PI / 180;
  const ca = Math.abs(Math.cos(a)), sa = Math.abs(Math.sin(a));
  const zoom = Math.max((cw * ca + ch * sa) / cw, (cw * sa + ch * ca) / ch);
  const swap = (((s.rot90 % 4) + 4) % 4) % 2 === 1;
  const outW = swap ? ch : cw, outH = swap ? cw : ch;
  // forward: src(centered) -> flip -> rotate(a) -> zoom -> rot90 -> out
  const fx = s.flipH ? -1 : 1, fy = s.flipV ? -1 : 1;
  let M = [fx, 0, 0, fy];                    // [m00,m01,m10,m11] row-major
  const c1 = Math.cos(a), s1 = Math.sin(a);
  M = mul2([c1, -s1, s1, c1], M);
  M = mul2([zoom, 0, 0, zoom], M);
  const r = ((s.rot90 % 4) + 4) % 4, cr = Math.round(Math.cos(r * Math.PI / 2)), sr = Math.round(Math.sin(r * Math.PI / 2));
  M = mul2([cr, -sr, sr, cr], M);
  const inv = inv2(M);
  const cx = (s.crop.x + s.crop.w / 2) * sw, cy = (s.crop.y + s.crop.h / 2) * sh;
  return { outW, outH, inv, cx, cy };
}
function mul2(a, b) { return [a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3], a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3]]; }
function inv2(m) { const d = m[0] * m[3] - m[1] * m[2] || 1e-6; return [m[3] / d, -m[1] / d, -m[2] / d, m[0] / d]; }

/* ---------------- pipeline ---------------- */
function hex2lin(h) { const c = s2lJS(h); return c; }
function s2lJS(c) { return c.map(x => x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)); }
function hsv2rgbJS(h, s, v) {
  h = ((h % 360) + 360) % 360 / 60; const i = Math.floor(h), f = h - i;
  const p = v * (1 - s), q = v * (1 - s * f), t = v * (1 - s * (1 - f));
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i % 6];
}

function uploadLUT() {
  gl.bindTexture(gl.TEXTURE_2D, LUTTEX);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, 1024, 1, 0, gl.RGBA, gl.FLOAT, buildLUT());
}

/* renders the developed image into FBO 'out' at viewport size vw x vh */
function develop(im, vw, vh, VS_, VO_, forExport) {
  const s = im.s, G = geom(s, im.w, im.h);
  const base = fbo(forExport ? 'ebase' : 'base', vw, vh, true);
  const bw = Math.max(2, Math.round(vw / 4)), bh = Math.max(2, Math.round(vh / 4));
  const b1 = fbo(forExport ? 'eb1' : 'b1', bw, bh, true);
  const b2 = fbo(forExport ? 'eb2' : 'b2', bw, bh, true);
  const out = fbo(forExport ? 'eout' : 'out', vw, vh, false);

  // pass 1
  let u = use(PROG.base);
  bindTarget(base);
  gl.uniform1i(u.uSrc, tex(0, im.tex));
  gl.uniform2f(u.uSrcSize, im.w, im.h);
  gl.uniform2f(u.uOutSize, G.outW, G.outH);
  gl.uniform2f(u.uVS, VS_[0], VS_[1]);
  gl.uniform2f(u.uVO, VO_[0], VO_[1]);
  gl.uniform2f(u.uCenter, G.cx, G.cy);
  gl.uniformMatrix2fv(u.uM, false, new Float32Array([G.inv[0], G.inv[2], G.inv[1], G.inv[3]]));
  gl.uniform1f(u.uSrcLinear, im.linear ? 1 : 0);
  gl.uniform1f(u.uTemp, s.temp); gl.uniform1f(u.uTint, s.tint);
  gl.uniform1f(u.uExp, s.exposure); gl.uniform1f(u.uCon, s.contrast);
  gl.uniform1f(u.uHi, s.highlights); gl.uniform1f(u.uSh, s.shadows);
  gl.uniform1f(u.uWh, s.whites); gl.uniform1f(u.uBl, s.blacks);
  draw();

  // pass 2 : low-frequency blur at quarter res
  u = use(PROG.blur);
  const F = 0.0062;                       // halo radius as a fraction of the frame
  const fx = F / VS_[0], fy = F * (G.outW / G.outH) / VS_[1];
  bindTarget(b1);
  gl.uniform1i(u.uTex, tex(0, base.tex));
  gl.uniform2f(u.uDir, fx, 0); draw();
  bindTarget(b2);
  gl.uniform1i(u.uTex, tex(0, b1.tex));
  gl.uniform2f(u.uDir, 0, fy); draw();
  // a much coarser level: chroma blotches are low frequency and the quarter-res
  // blur above is far too fine to reach them
  const cw2 = Math.max(2, Math.round(vw / 16)), ch2 = Math.max(2, Math.round(vh / 16));
  const b3 = fbo(forExport ? 'eb3' : 'b3', cw2, ch2, true);
  const b4 = fbo(forExport ? 'eb4' : 'b4', cw2, ch2, true);
  bindTarget(b3);
  gl.uniform1i(u.uTex, tex(0, b2.tex));
  gl.uniform2f(u.uDir, fx * 4.5, 0); draw();
  bindTarget(b4);
  gl.uniform1i(u.uTex, tex(0, b3.tex));
  gl.uniform2f(u.uDir, 0, fy * 4.5); draw();

  // pass 3 : develop
  u = use(PROG.final);
  bindTarget(out);
  gl.uniform1i(u.uBase, tex(0, base.tex));
  gl.uniform1i(u.uBlur, tex(1, b2.tex));
  gl.uniform1i(u.uBlur2, tex(7, b4.tex));
  gl.uniform1i(u.uLUT, tex(2, LUTTEX));
  for (let i = 0; i < MAXBRUSH; i++) gl.uniform1i(u['uBrush' + i], tex(3 + i, BRUSHTEX[i]));
  gl.uniform2f(u.uTexel, 1 / vw, 1 / vh);
  gl.uniform2f(u.uVS, VS_[0], VS_[1]); gl.uniform2f(u.uVO, VO_[0], VO_[1]);
  gl.uniform1f(u.uAspect, G.outW / G.outH);
  gl.uniform1f(u.uSeed, im.seed || 7.3);
  gl.uniform1f(u.uClarity, s.clarity); gl.uniform1f(u.uTexture, s.texture);
  gl.uniform1f(u.uDehaze, s.dehaze); gl.uniform1f(u.uVib, s.vibrance); gl.uniform1f(u.uSat, s.saturation);
  gl.uniform1f(u.uSharp, s.sharpen); gl.uniform1f(u.uSharpR, s.sharpRadius);
  gl.uniform1f(u.uSharpD, s.sharpDetail / 100); gl.uniform1f(u.uNrL, s.nrLum); gl.uniform1f(u.uNrC, s.nrColor);
  gl.uniform1f(u.uNrD, (s.nrDetail === undefined ? 50 : s.nrDetail) / 100);
  gl.uniform1f(u.uVig, s.vignette); gl.uniform1f(u.uVigF, s.vigFeather); gl.uniform1f(u.uVigR, s.vigRound);
  gl.uniform1f(u.uGrain, s.grain); gl.uniform1f(u.uGrainS, s.grainSize);
  const cg = (h, sat) => { const c = hsv2rgbJS(h, 1, 1); const k = sat / 100 * 0.42; return [(c[0] - 0.5) * k, (c[1] - 0.5) * k, (c[2] - 0.5) * k]; };
  gl.uniform3fv(u.uCGs, cg(s.shHue, s.shSat));
  gl.uniform3fv(u.uCGm, cg(s.miHue, s.miSat));
  gl.uniform3fv(u.uCGh, cg(s.hiHue, s.hiSat));
  gl.uniform1f(u.uCGbal, s.cgBal / 100);
  gl.uniform1fv(u.uHslC, new Float32Array([0,30,60,120,180,240,285,330]));
  gl.uniform1fv(u.uHslH, new Float32Array(s.hslH));
  gl.uniform1fv(u.uHslS, new Float32Array(s.hslS));
  gl.uniform1fv(u.uHslL, new Float32Array(s.hslL));
  // masks
  const n = Math.min(s.masks.length, MAXM);
  const ty = new Float32Array(MAXM), ga = new Float32Array(MAXM * 4), gb = new Float32Array(MAXM * 4),
    aa = new Float32Array(MAXM * 4), ab = new Float32Array(MAXM * 4), fl = new Float32Array(MAXM * 4);
  const TY = { linear: 1, radial: 2, brush: 3, lum: 4, color: 5 };
  for (let i = 0; i < n; i++) {
    const m = s.masks[i], g = m.geo, a = m.adj;
    ty[i] = TY[m.type];
    if (m.type === 'linear') ga.set([g.x0, g.y0, g.x1, g.y1], i * 4);
    else if (m.type === 'radial') { ga.set([g.cx, g.cy, g.rx, g.ry], i * 4); gb.set([g.ang * Math.PI / 180, g.feather / 100, 0, 0], i * 4); }
    else if (m.type === 'lum') { ga.set([g.lo, g.hi, 0, 0], i * 4); gb.set([0, 0, g.feather, 0], i * 4); }
    else if (m.type === 'color') { ga.set([g.hue, g.tol, 0, 0], i * 4); gb.set([g.satMin, 0, 0, 0], i * 4); }
    aa.set([a.exposure, a.contrast, a.highlights, a.shadows], i * 4);
    ab.set([a.saturation, a.temp, a.tint, a.texture], i * 4);
    fl.set([m.invert ? 1 : 0, m.opacity / 100, Math.max(0, m.brush), 0], i * 4);
  }
  gl.uniform1i(u.uMCount, n);
  gl.uniform1fv(u.uMType, ty); gl.uniform4fv(u.uMGeoA, ga); gl.uniform4fv(u.uMGeoB, gb);
  gl.uniform4fv(u.uMAdjA, aa); gl.uniform4fv(u.uMAdjB, ab); gl.uniform4fv(u.uMFlags, fl);
  const showing = (!forExport && A.selMask >= 0 && A.showMask && A.selMask < n) ? A.selMask : -1;
  gl.uniform1i(u.uShowMask, showing);
  draw();
  return { out, base, G };
}
/* ============================================================
   p3: UI wiring, interaction, export
   ============================================================ */

/* ---------------- panels ---------------- */
function clearGroup(g) { for (let i = ctrls.length - 1; i >= 0; i--) if (ctrls[i].grp === g) ctrls.splice(i, 1); }
function sl(parent, k, label, min, max, step, def, fmt, scope, grp) {
  const c = mkSlider(parent, { k, label, min, max, step, def, fmt: fmt || 'f2', scope: scope || (() => S()) });
  c.grp = grp || 'main'; return c;
}

function buildPanels() {
  const P = $('#insp');

  mkSection(P, 'Scope', true, b => {
    const h = document.createElement('canvas'); h.id = 'histo'; b.append(h);
    const st = document.createElement('div'); st.className = 'hint'; st.id = 'scopeInfo';
    st.textContent = 'No photo loaded.'; b.append(st);
  });

  mkSection(P, 'Crop & rotate', false, b => {
    const g1 = document.createElement('div'); g1.className = 'grp'; b.append(g1);
    const chip = (t, fn) => { const c = document.createElement('div'); c.className = 'chip'; c.textContent = t; c.onclick = fn; g1.append(c); return c; };
    chip('⟲ 90°', () => { S().rot90 = (S().rot90 + 3) % 4; A.view.fit = true; requestRender(true); });
    chip('⟳ 90°', () => { S().rot90 = (S().rot90 + 1) % 4; A.view.fit = true; requestRender(true); });
    chip('Flip H', () => { S().flipH = !S().flipH; requestRender(true); });
    chip('Flip V', () => { S().flipV = !S().flipV; requestRender(true); });
    sl(b, 'straighten', 'Straighten', -45, 45, .1, 0, 'deg');
    const g2 = document.createElement('div'); g2.className = 'grp'; b.append(g2);
    const cropBtn = document.createElement('div'); cropBtn.className = 'chip'; cropBtn.id = 'cropBtn';
    cropBtn.textContent = 'Crop tool'; cropBtn.onclick = toggleCrop; g2.append(cropBtn);
    const ar = document.createElement('div'); ar.className = 'grp'; b.append(ar);
    [['Free', 0], ['1:1', 1], ['3:2', 3 / 2], ['2:3', 2 / 3], ['4:5', .8], ['16:9', 16 / 9]].forEach(([t, r]) => {
      const c = document.createElement('div'); c.className = 'chip'; c.textContent = t;
      c.onclick = () => { S().cropAspect = r; [...ar.children].forEach(x => x.classList.remove('on')); c.classList.add('on'); applyAspect(); };
      ar.append(c);
    });
    const rst = document.createElement('div'); rst.className = 'grp'; b.append(rst);
    const rc = document.createElement('div'); rc.className = 'chip'; rc.textContent = 'Reset crop';
    rc.onclick = () => { S().crop = { x: 0, y: 0, w: 1, h: 1 }; A.cropDraft = null; A.view.fit = true; requestRender(true); };
    rst.append(rc);
    b.insertAdjacentHTML('beforeend', '<div class="hint">In crop mode, drag inside the frame to move it, corners to resize. Press <b>C</b> to apply.</div>');
  });

  mkSection(P, 'Basic', true, b => {
    sl(b, 'temp', 'Temperature', -100, 100, .5, 0, 'int');
    sl(b, 'tint', 'Tint', -100, 100, .5, 0, 'int');
    b.insertAdjacentHTML('beforeend', '<div class="divline"></div>');
    sl(b, 'exposure', 'Exposure', -5, 5, .01, 0);
    sl(b, 'contrast', 'Contrast', -1, 1, .01, 0);
    sl(b, 'highlights', 'Highlights', -1, 1, .01, 0);
    sl(b, 'shadows', 'Shadows', -1, 1, .01, 0);
    sl(b, 'whites', 'Whites', -1, 1, .01, 0);
    sl(b, 'blacks', 'Blacks', -1, 1, .01, 0);
    b.insertAdjacentHTML('beforeend', '<div class="divline"></div>');
    sl(b, 'texture', 'Texture', -1, 1, .01, 0);
    sl(b, 'clarity', 'Clarity', -1, 1, .01, 0);
    sl(b, 'dehaze', 'Dehaze', -1, 1, .01, 0);
    sl(b, 'vibrance', 'Vibrance', -1, 1, .01, 0);
    sl(b, 'saturation', 'Saturation', -1, 1, .01, 0);
  });

  mkSection(P, 'Tone curve', true, (b, sect, h) => {
    const bd = document.createElement('span'); bd.className = 'badge'; bd.id = 'curveBadge'; h.append(bd);
    const w = document.createElement('div'); w.className = 'chwrap';
    [['rgb', 'RGB', ''], ['r', 'R', 'ch-r'], ['g', 'G', 'ch-g'], ['b', 'B', 'ch-b']].forEach(([k, t, cl]) => {
      const c = document.createElement('div'); c.className = 'chip ' + cl + (k === 'rgb' ? ' on' : '');
      c.textContent = t;
      c.onclick = () => { A.curveCh = k; A.curvePick = -1; [...w.children].forEach(x => x.classList.remove('on')); c.classList.add('on'); drawCurve(); };
      w.append(c);
    });
    b.append(w);
    const cv = document.createElement('canvas'); cv.id = 'curve'; b.append(cv);
    wireCurve(cv);
    b.insertAdjacentHTML('beforeend', '<div class="hint">Click to add a point · drag to shape · alt-click removes · double-click the grid resets this channel.</div>');
  });

  mkSection(P, 'Color mixer (HSL)', false, b => {
    const bar = document.createElement('div'); bar.className = 'grp'; b.append(bar);
    HSL_BANDS.forEach((n, i) => {
      const c = document.createElement('div'); c.className = 'chip' + (i === 0 ? ' on' : ''); c.textContent = n.slice(0, 3);
      c.title = n;
      c.onclick = () => { A.band = i; [...bar.children].forEach(x => x.classList.remove('on')); c.classList.add('on'); rebuildHSL(); };
      bar.append(c);
    });
    const host = document.createElement('div'); host.id = 'hslHost'; b.append(host);
    A.band = 0; rebuildHSL();
  });

  mkSection(P, 'Color grading', false, b => {
    b.insertAdjacentHTML('beforeend', '<div class="hint">Shadows</div>');
    sl(b, 'shHue', 'Hue', 0, 360, 1, 220, 'int'); sl(b, 'shSat', 'Saturation', 0, 100, 1, 0, 'int');
    b.insertAdjacentHTML('beforeend', '<div class="divline"></div><div class="hint">Midtones</div>');
    sl(b, 'miHue', 'Hue', 0, 360, 1, 0, 'int'); sl(b, 'miSat', 'Saturation', 0, 100, 1, 0, 'int');
    b.insertAdjacentHTML('beforeend', '<div class="divline"></div><div class="hint">Highlights</div>');
    sl(b, 'hiHue', 'Hue', 0, 360, 1, 40, 'int'); sl(b, 'hiSat', 'Saturation', 0, 100, 1, 0, 'int');
    b.insertAdjacentHTML('beforeend', '<div class="divline"></div>');
    sl(b, 'cgBal', 'Balance', -100, 100, 1, 0, 'int');
  });

  mkSection(P, 'Detail', false, b => {
    sl(b, 'sharpen', 'Sharpening', 0, 1.5, .01, 0);
    sl(b, 'sharpRadius', 'Radius', .5, 3, .05, 1);
    sl(b, 'sharpDetail', 'Detail', 0, 100, 1, 25, 'int');
    b.insertAdjacentHTML('beforeend', '<div class="divline"></div>');
    const ag = document.createElement('div'); ag.className = 'grp';
    const ab = document.createElement('div'); ab.className = 'chip';
    ab.textContent = 'Auto denoise'; ab.title = 'Measure this frame and set both sliders';
    ab.onclick = () => autoDenoise();
    ag.append(ab); b.append(ag);
    sl(b, 'nrLum', 'Noise · luminance', 0, 1, .01, 0);
    sl(b, 'nrColor', 'Noise · color', 0, 1, .01, 0);
    sl(b, 'nrDetail', 'Noise · detail', 0, 100, 1, 50, 'int');
    b.insertAdjacentHTML('beforeend', '<div class="hint">Long exposures: start at 0.25 luminance, 0.4 color, then raise sharpening detail to protect stars.</div>');
  });

  mkSection(P, 'Effects', false, b => {
    sl(b, 'vignette', 'Vignette', -1, 1, .01, 0);
    sl(b, 'vigFeather', 'Feather', 0, 100, 1, 50, 'int');
    sl(b, 'vigRound', 'Roundness', -1, 1, .01, 0);
    b.insertAdjacentHTML('beforeend', '<div class="divline"></div>');
    sl(b, 'grain', 'Grain', 0, 1, .01, 0);
    sl(b, 'grainSize', 'Grain size', 0, 100, 1, 25, 'int');
  });

  mkSection(P, 'Masks', true, (b, sect, h) => {
    const bd = document.createElement('span'); bd.className = 'badge'; bd.id = 'maskBadge'; h.append(bd);
    const add = document.createElement('div'); add.className = 'grp';
    [['linear', 'Linear'], ['radial', 'Radial'], ['brush', 'Brush'], ['lum', 'Luminance'], ['color', 'Color']].forEach(([t, n]) => {
      const c = document.createElement('div'); c.className = 'chip'; c.textContent = '+ ' + n;
      c.onclick = () => addMask(t); add.append(c);
    });
    b.append(add);
    const list = document.createElement('div'); list.className = 'mlist'; list.id = 'maskList'; b.append(list);
    const host = document.createElement('div'); host.id = 'maskHost'; b.append(host);
  });
}

function rebuildHSL() {
  const host = $('#hslHost'); if (!host) return;
  clearGroup('hsl'); host.innerHTML = '';
  const i = A.band | 0;
  sl(host, i, 'Hue', -100, 100, 1, 0, 'int', () => S().hslH, 'hsl');
  sl(host, i, 'Saturation', -100, 100, 1, 0, 'int', () => S().hslS, 'hsl');
  sl(host, i, 'Luminance', -100, 100, 1, 0, 'int', () => S().hslL, 'hsl');
}

/* ---------------- masks ---------------- */
function addMask(type) {
  if (A.cur < 0) { toast('Open a photo first'); return; }
  const s = S();
  if (s.masks.length >= MAXM) { toast('Six masks max per photo'); return; }
  const m = newMask(type);
  if (type === 'brush') {
    const used = s.masks.filter(x => x.type === 'brush').length;
    if (used >= MAXBRUSH) { toast('Four brush masks max'); return; }
    m.brush = used; ensureBrush(used);
  }
  m.name = MASKLABEL[type] + ' ' + (s.masks.length + 1);
  s.masks.push(m); A.selMask = s.masks.length - 1; A.showMask = true;
  rebuildMasks(); requestRender(true);
}

function rebuildMasks() {
  const list = $('#maskList'), host = $('#maskHost'); if (!list) return;
  clearGroup('mask'); list.innerHTML = ''; host.innerHTML = '';
  const s = S(), ms = s.masks;
  $('#maskBadge').textContent = ms.length ? ms.length + '/' + MAXM : '';
  if (!ms.length) { list.innerHTML = '<div class="empty">No masks. Add one above — each carries its own exposure, colour and texture.</div>'; drawOverlay(); return; }
  ms.forEach((m, i) => {
    const d = document.createElement('div'); d.className = 'mitem' + (i === A.selMask ? ' sel' : '');
    d.innerHTML = `<span class="k">${MASKLABEL[m.type]}</span><span class="nm">${m.name}</span><span class="x">×</span>`;
    d.onclick = e => {
      if (e.target.classList.contains('x')) {
        ms.splice(i, 1); if (A.selMask >= ms.length) A.selMask = ms.length - 1;
        rebuildMasks(); requestRender(true); return;
      }
      A.selMask = i; A.showMask = true; rebuildMasks(); requestRender(true);
    };
    list.append(d);
  });
  const m = ms[A.selMask]; if (!m) return;
  const opts = document.createElement('div'); opts.className = 'grp'; host.append(opts);
  const inv = document.createElement('div'); inv.className = 'chip' + (m.invert ? ' on' : ''); inv.textContent = 'Invert';
  inv.onclick = () => { m.invert = !m.invert; inv.classList.toggle('on', m.invert); requestRender(true); }; opts.append(inv);
  const shw = document.createElement('div'); shw.className = 'chip' + (A.showMask ? ' on' : ''); shw.textContent = 'Show overlay';
  shw.onclick = () => { A.showMask = !A.showMask; shw.classList.toggle('on', A.showMask); requestRender(true); }; opts.append(shw);
  if (m.type === 'brush') {
    const clr = document.createElement('div'); clr.className = 'chip'; clr.textContent = 'Clear paint';
    clr.onclick = () => { const bc = IM().brushes[m.brush]; bc.ctx.clearRect(0, 0, bc.canvas.width, bc.canvas.height); uploadBrush(m.brush); requestRender(true); };
    opts.append(clr);
  }
  sl(host, 'opacity', 'Mask opacity', 0, 100, 1, 100, 'int', () => m, 'mask');

  host.insertAdjacentHTML('beforeend', '<div class="divline"></div>');
  if (m.type === 'radial') {
    sl(host, 'feather', 'Feather', 2, 100, 1, 50, 'int', () => m.geo, 'mask');
    sl(host, 'ang', 'Rotation', -180, 180, 1, 0, 'int', () => m.geo, 'mask');
  } else if (m.type === 'lum') {
    sl(host, 'lo', 'Range start', 0, 1, .005, 0, 'f2', () => m.geo, 'mask');
    sl(host, 'hi', 'Range end', 0, 1, .005, .35, 'f2', () => m.geo, 'mask');
    sl(host, 'feather', 'Falloff', .005, .4, .005, .12, 'f2', () => m.geo, 'mask');
  } else if (m.type === 'color') {
    sl(host, 'hue', 'Target hue', 0, 360, 1, 210, 'int', () => m.geo, 'mask');
    sl(host, 'tol', 'Hue range', 5, 120, 1, 30, 'int', () => m.geo, 'mask');
    sl(host, 'satMin', 'Min saturation', 0, .5, .005, .08, 'f2', () => m.geo, 'mask');
  } else if (m.type === 'brush') {
    sl(host, 'size', 'Brush size', 1, 60, .5, 12, 'f2', () => m.geo, 'mask');
    sl(host, 'soft', 'Feather', 0, 100, 1, 60, 'int', () => m.geo, 'mask');
    sl(host, 'flow', 'Flow', 5, 100, 1, 60, 'int', () => m.geo, 'mask');
    host.insertAdjacentHTML('beforeend', '<div class="hint">Paint on the photo. Hold <b>Alt</b> to erase, <b>[</b> / <b>]</b> resize.</div>');
  } else {
    host.insertAdjacentHTML('beforeend', '<div class="hint">Drag the handles on the photo to place the gradient.</div>');
  }
  host.insertAdjacentHTML('beforeend', '<div class="divline"></div>');
  const A_ = () => m.adj;
  sl(host, 'exposure', 'Exposure', -4, 4, .01, 0, 'f2', A_, 'mask');
  sl(host, 'contrast', 'Contrast', -1, 1, .01, 0, 'f2', A_, 'mask');
  sl(host, 'highlights', 'Highlights', -1, 1, .01, 0, 'f2', A_, 'mask');
  sl(host, 'shadows', 'Shadows', -1, 1, .01, 0, 'f2', A_, 'mask');
  sl(host, 'saturation', 'Saturation', -1, 1, .01, 0, 'f2', A_, 'mask');
  sl(host, 'temp', 'Temperature', -100, 100, 1, 0, 'int', A_, 'mask');
  sl(host, 'tint', 'Tint', -100, 100, 1, 0, 'int', A_, 'mask');
  sl(host, 'texture', 'Texture', -1, 1, .01, 0, 'f2', A_, 'mask');
  drawOverlay();
}

/* ---------------- brush surfaces ---------------- */
function ensureBrush(i) {
  const im = IM(); if (!im) return null;
  im.brushes = im.brushes || [];
  if (!im.brushes[i]) {
    const G = geom(im.s, im.w, im.h);
    const long = 1024, sc = long / Math.max(G.outW, G.outH);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(8, Math.round(G.outW * sc)); canvas.height = Math.max(8, Math.round(G.outH * sc));
    im.brushes[i] = { canvas, ctx: canvas.getContext('2d', { willReadFrequently: false }) };
  }
  return im.brushes[i];
}
function uploadBrush(i) {
  const b = ensureBrush(i); if (!b) return;
  gl.bindTexture(gl.TEXTURE_2D, BRUSHTEX[i]);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, b.canvas);
}
function uploadAllBrushes() {
  const im = IM();
  for (let i = 0; i < MAXBRUSH; i++) {
    if (im && im.brushes && im.brushes[i]) uploadBrush(i);
    else { gl.bindTexture(gl.TEXTURE_2D, BRUSHTEX[i]); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0])); }
  }
}
function paintAt(m, iuv, erase) {
  const b = ensureBrush(m.brush); if (!b) return;
  const W = b.canvas.width, H = b.canvas.height;
  const r = Math.max(2, m.geo.size / 100 * Math.max(W, H));
  const x = iuv[0] * W, y = iuv[1] * H;
  const ctx = b.ctx;
  ctx.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
  const soft = clamp(m.geo.soft / 100, 0, .98);
  const g = ctx.createRadialGradient(x, y, r * (1 - soft), x, y, r);
  const a = m.geo.flow / 100;
  g.addColorStop(0, `rgba(255,255,255,${a})`); g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}

/* ---------------- view + render ---------------- */
function viewInfo() {
  const im = IM(); if (!im) return null;
  const st = $('#stage').getBoundingClientRect();
  const G = geom(A.cropMode ? Object.assign({}, im.s, { crop: { x: 0, y: 0, w: 1, h: 1 } }) : im.s, im.w, im.h);
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const fit = Math.min((st.width - 24) / G.outW, (st.height - 24) / G.outH);
  if (A.view.fit) A.view.zoom = fit;
  const z = clamp(A.view.zoom, fit * .5, 16);
  const cssW = Math.min(st.width, G.outW * z), cssH = Math.min(st.height, G.outH * z);
  let vw = Math.round(cssW * dpr), vh = Math.round(cssH * dpr);
  const cap = 2600, k = Math.min(1, cap / Math.max(vw, vh, 1));
  vw = Math.max(2, Math.round(vw * k)); vh = Math.max(2, Math.round(vh * k));
  const VSx = Math.min(1, (cssW / z) / G.outW), VSy = Math.min(1, (cssH / z) / G.outH);
  const ox = VSx >= 1 ? .5 : clamp(A.view.ox || .5, VSx / 2, 1 - VSx / 2);
  const oy = VSy >= 1 ? .5 : clamp(A.view.oy || .5, VSy / 2, 1 - VSy / 2);
  A.view.ox = ox; A.view.oy = oy; A.view.zoom = z; A.view.fitZoom = fit;
  return { G, vw, vh, cssW, cssH, VS: [VSx, VSy], VO: [ox, oy], z, st };
}

let _raf = 0, _commit = false;
function requestRender(commit) {
  if (commit) _commit = true;
  if (_raf) return;
  _raf = requestAnimationFrame(() => { _raf = 0; const c = _commit; _commit = false; renderNow(c); });
}

function renderNow(commit) {
  const im = IM(); if (!im) { drawHisto(); return; }
  const V = viewInfo(); if (!V) return;
  const cv = $('#gl');
  if (cv.width !== V.vw || cv.height !== V.vh) { cv.width = V.vw; cv.height = V.vh; }
  cv.style.width = V.cssW + 'px'; cv.style.height = V.cssH + 'px';

  const saved = im.s;
  if (A.before) {
    const d = defaults();
    d.crop = saved.crop; d.rot90 = saved.rot90; d.flipH = saved.flipH; d.flipV = saved.flipV; d.straighten = saved.straighten;
    im.s = d;
  }
  if (A.cropMode) im.s = Object.assign({}, im.s, { crop: { x: 0, y: 0, w: 1, h: 1 } });
  uploadLUT();
  const R = develop(im, V.vw, V.vh, V.VS, V.VO, false);
  im.s = saved;

  // to screen
  const u = use(PROG.show);
  bindTarget(null);
  gl.uniform1i(u.uTex, tex(0, R.out.tex));
  if (u.uRaw) gl.uniform1i(u.uRaw, tex(1, R.out.tex));
  if (u.uBefore) gl.uniform1f(u.uBefore, 0);
  if (u.uSplit) gl.uniform1f(u.uSplit, 0);
  draw();

  drawOverlay();
  const st = $('#stat');
  st.textContent = `${im.name} · ${Math.round(V.G.outW)}×${Math.round(V.G.outH)} · ${Math.round(A.view.zoom * 100)}%` +
    (im.linear ? ' · linear raw' : '') + (A.before ? ' · BEFORE' : '');
  $('#badge').hidden = !A.before; $('#badge').textContent = 'BEFORE';

  if (commit) {
    im.dirty = true;
    readHistogram(R.out);
    drawHisto(); drawCurve(); syncCurveBadge();
    pushHistory();
    buildStrip();
  }
}

function readHistogram(out) {
  const hf = fbo('hist', 160, 160, false);
  const u = use(PROG.ds);
  bindTarget(hf);
  gl.uniform1i(u.uTex, tex(0, out.tex));
  draw();
  const px = new Uint8Array(160 * 160 * 4);
  gl.readPixels(0, 0, 160, 160, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const r = new Float32Array(256), g = new Float32Array(256), b = new Float32Array(256), lum = new Float32Array(256);
  let lo = 0, hi = 0, n = 0;
  for (let i = 0; i < px.length; i += 4) {
    const R = px[i], G = px[i + 1], B = px[i + 2];
    if (R === 0 && G === 0 && B === 0) { /* letterbox */ }
    r[R]++; g[G]++; b[B]++;
    const L = Math.round(0.2126 * R + 0.7152 * G + 0.0722 * B); lum[L]++;
    if (R > 253 || G > 253 || B > 253) hi++;
    if (R < 2 && G < 2 && B < 2) lo++;
    n++;
  }
  let mx = 0; for (let i = 1; i < 255; i++) mx = Math.max(mx, r[i], g[i], b[i]);
  A.hist = { r, g, b, lum, max: mx || 1, clipLo: lo / n, clipHi: hi / n };
  const info = $('#scopeInfo');
  if (info) info.textContent = `clipped highlights ${(A.hist.clipHi * 100).toFixed(2)}% · crushed blacks ${(A.hist.clipLo * 100).toFixed(2)}%`;
}

/* ---------------- overlay (mask handles + crop) ---------------- */
function img2screen(V, ix, iy) {
  const r = $('#gl').getBoundingClientRect(), s = $('#stage').getBoundingClientRect();
  return [r.left - s.left + ((ix - V.VO[0]) / V.VS[0] + .5) * V.cssW,
  r.top - s.top + ((iy - V.VO[1]) / V.VS[1] + .5) * V.cssH];
}
function screen2img(V, cx, cy) {
  const r = $('#gl').getBoundingClientRect();
  return [((cx - r.left) / V.cssW - .5) * V.VS[0] + V.VO[0], ((cy - r.top) / V.cssH - .5) * V.VS[1] + V.VO[1]];
}

function drawOverlay() {
  const ov = $('#overlay'), st = $('#stage').getBoundingClientRect();
  const dpr = Math.min(devicePixelRatio || 1, 2);
  ov.width = Math.round(st.width * dpr); ov.height = Math.round(st.height * dpr);
  ov.style.width = st.width + 'px'; ov.style.height = st.height + 'px';
  const g = ov.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, st.width, st.height);
  const im = IM(); if (!im) return;
  const V = viewInfo(); if (!V) return;
  const dot = (x, y, f) => {
    g.beginPath(); g.arc(x, y, f ? 7 : 5, 0, 6.2832);
    g.fillStyle = f ? '#e9a23b' : 'rgba(20,26,33,.85)'; g.strokeStyle = '#e9a23b'; g.lineWidth = 1.5;
    g.fill(); g.stroke();
  };
  if (A.cropMode) {
    const c = A.cropDraft || im.s.crop;
    const p0 = img2screen(V, c.x, c.y), p1 = img2screen(V, c.x + c.w, c.y + c.h);
    g.fillStyle = 'rgba(6,9,12,.62)';
    g.fillRect(0, 0, st.width, st.height);
    g.clearRect(p0[0], p0[1], p1[0] - p0[0], p1[1] - p0[1]);
    g.strokeStyle = '#e9a23b'; g.lineWidth = 1; g.strokeRect(p0[0], p0[1], p1[0] - p0[0], p1[1] - p0[1]);
    g.strokeStyle = 'rgba(233,162,59,.35)';
    for (let i = 1; i < 3; i++) {
      const x = lerp(p0[0], p1[0], i / 3), y = lerp(p0[1], p1[1], i / 3);
      g.beginPath(); g.moveTo(x, p0[1]); g.lineTo(x, p1[1]); g.stroke();
      g.beginPath(); g.moveTo(p0[0], y); g.lineTo(p1[0], y); g.stroke();
    }
    [[p0[0], p0[1]], [p1[0], p0[1]], [p0[0], p1[1]], [p1[0], p1[1]]].forEach(p => dot(p[0], p[1], true));
    return;
  }
  const m = im.s.masks[A.selMask]; if (!m || !A.showMask) return;
  g.strokeStyle = '#e9a23b'; g.lineWidth = 1.4;
  if (m.type === 'linear') {
    const a = img2screen(V, m.geo.x0, m.geo.y0), b = img2screen(V, m.geo.x1, m.geo.y1);
    g.setLineDash([5, 4]); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); g.setLineDash([]);
    // band lines perpendicular
    const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy) || 1, nx = -dy / L * 2000, ny = dx / L * 2000;
    g.strokeStyle = 'rgba(233,162,59,.5)';
    [[a, 1], [b, 1]].forEach(([p]) => { g.beginPath(); g.moveTo(p[0] - nx, p[1] - ny); g.lineTo(p[0] + nx, p[1] + ny); g.stroke(); });
    dot(a[0], a[1], true); dot(b[0], b[1], true);
  } else if (m.type === 'radial') {
    const c = img2screen(V, m.geo.cx, m.geo.cy);
    const rx = m.geo.rx / V.VS[0] * V.cssW, ry = m.geo.ry / V.VS[1] * V.cssH;
    g.save(); g.translate(c[0], c[1]); g.rotate(m.geo.ang * Math.PI / 180);
    g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, 6.2832); g.stroke();
    g.setLineDash([4, 4]); g.strokeStyle = 'rgba(233,162,59,.4)';
    const f = 1 - clamp(m.geo.feather / 100, .02, 1);
    g.beginPath(); g.ellipse(0, 0, rx * f, ry * f, 0, 0, 6.2832); g.stroke(); g.setLineDash([]);
    g.restore();
    dot(c[0], c[1], true);
  }
}

/* ---------------- stage interaction ---------------- */
function wireStage() {
  const stage = $('#stage');
  stage.addEventListener('wheel', e => {
    if (A.cur < 0) return;
    e.preventDefault();
    const V = viewInfo(); if (!V) return;
    const before = screen2img(V, e.clientX, e.clientY);
    A.view.fit = false;
    A.view.zoom = clamp(A.view.zoom * Math.exp(-e.deltaY * 0.0016), V.G ? A.view.fitZoom * .5 : .1, 16);
    const V2 = viewInfo();
    const after = screen2img(V2, e.clientX, e.clientY);
    A.view.ox += before[0] - after[0]; A.view.oy += before[1] - after[1];
    requestRender(false);
  }, { passive: false });

  stage.addEventListener('pointerdown', e => {
    if (A.cur < 0) return;
    const V = viewInfo(); if (!V) return;
    stage.setPointerCapture(e.pointerId);
    const iuv = screen2img(V, e.clientX, e.clientY);
    const im = IM(), s = im.s;

    if (A.cropMode) { startCropDrag(e, V, iuv); return; }
    const m = s.masks[A.selMask];
    if (m && m.type === 'brush' && !e.shiftKey && e.button === 0) {
      A.painting = true; paintAt(m, iuv, e.altKey); uploadBrush(m.brush); requestRender(false);
      A.drag = { kind: 'paint', m, erase: e.altKey }; return;
    }
    if (m && (m.type === 'linear' || m.type === 'radial') && !e.shiftKey && e.button === 0) {
      const near = (px, py) => { const a = img2screen(V, px, py), b = img2screen(V, iuv[0], iuv[1]); return Math.hypot(a[0] - b[0], a[1] - b[1]) < 16; };
      if (m.type === 'linear') {
        if (near(m.geo.x0, m.geo.y0)) { A.drag = { kind: 'lin0', m }; return; }
        if (near(m.geo.x1, m.geo.y1)) { A.drag = { kind: 'lin1', m }; return; }
        A.drag = { kind: 'linmove', m, o: [...iuv], g: { ...m.geo } }; return;
      } else {
        if (near(m.geo.cx, m.geo.cy)) { A.drag = { kind: 'radmove', m, o: [...iuv], g: { ...m.geo } }; return; }
        A.drag = { kind: 'radsize', m, o: [...iuv], g: { ...m.geo } }; return;
      }
    }
    A.drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: A.view.ox, oy: A.view.oy, VS: V.VS, cssW: V.cssW, cssH: V.cssH };
  });

  stage.addEventListener('pointermove', e => {
    const d = A.drag; if (!d) { return; }
    const V = viewInfo(); if (!V) return;
    const iuv = screen2img(V, e.clientX, e.clientY);
    if (d.kind === 'pan') {
      A.view.ox = d.ox - (e.clientX - d.sx) / d.cssW * d.VS[0];
      A.view.oy = d.oy - (e.clientY - d.sy) / d.cssH * d.VS[1];
      requestRender(false); return;
    }
    if (d.kind === 'paint') { paintAt(d.m, iuv, d.erase); uploadBrush(d.m.brush); requestRender(false); return; }
    if (d.kind === 'crop') { moveCropDrag(d, iuv); return; }
    const g = d.m.geo;
    if (d.kind === 'lin0') { g.x0 = iuv[0]; g.y0 = iuv[1]; }
    if (d.kind === 'lin1') { g.x1 = iuv[0]; g.y1 = iuv[1]; }
    if (d.kind === 'linmove') { const dx = iuv[0] - d.o[0], dy = iuv[1] - d.o[1]; g.x0 = d.g.x0 + dx; g.y0 = d.g.y0 + dy; g.x1 = d.g.x1 + dx; g.y1 = d.g.y1 + dy; }
    if (d.kind === 'radmove') { const dx = iuv[0] - d.o[0], dy = iuv[1] - d.o[1]; g.cx = d.g.cx + dx; g.cy = d.g.cy + dy; }
    if (d.kind === 'radsize') {
      const V2 = viewInfo(), asp = V2.G.outW / V2.G.outH;
      g.rx = Math.max(.01, Math.abs(iuv[0] - g.cx)); g.ry = Math.max(.01, Math.abs(iuv[1] - g.cy));
      if (e.shiftKey) { g.ry = g.rx * asp; }
    }
    requestRender(false);
  });

  const end = () => {
    if (A.drag) { A.drag = null; A.painting = false; requestRender(true); }
  };
  stage.addEventListener('pointerup', end);
  stage.addEventListener('pointercancel', end);
  stage.addEventListener('contextmenu', e => e.preventDefault());
}

/* ---------------- crop ---------------- */
function toggleCrop() {
  if (A.cur < 0) return;
  A.cropMode = !A.cropMode;
  $('#cropBtn').classList.toggle('on', A.cropMode);
  if (A.cropMode) { A.cropDraft = { ...S().crop }; A.view.fit = true; }
  else { S().crop = A.cropDraft || S().crop; A.cropDraft = null; A.view.fit = true; }
  requestRender(true);
}
function applyAspect() {
  const s = S(), r = s.cropAspect; if (!r) return;
  const im = IM(); if (!im) return;
  const c = A.cropDraft || s.crop;
  const imgAsp = im.w / im.h;
  let w = c.w, h = w * imgAsp / r;
  if (h > 1) { h = 1; w = h * r / imgAsp; }
  c.w = w; c.h = h;
  c.x = clamp(c.x, 0, 1 - w); c.y = clamp(c.y, 0, 1 - h);
  if (!A.cropMode) s.crop = c;
  requestRender(true);
}
function startCropDrag(e, V, iuv) {
  const c = A.cropDraft || (A.cropDraft = { ...S().crop });
  const corners = [[c.x, c.y], [c.x + c.w, c.y], [c.x, c.y + c.h], [c.x + c.w, c.y + c.h]];
  let hit = -1;
  corners.forEach((p, i) => {
    const a = img2screen(V, p[0], p[1]), b = img2screen(V, iuv[0], iuv[1]);
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 18) hit = i;
  });
  A.drag = { kind: 'crop', hit, o: [...iuv], c: { ...c } };
}
function moveCropDrag(d, iuv) {
  const c = A.cropDraft, s = S(), im = IM();
  const dx = iuv[0] - d.o[0], dy = iuv[1] - d.o[1];
  if (d.hit < 0) {
    c.x = clamp(d.c.x + dx, 0, 1 - d.c.w); c.y = clamp(d.c.y + dy, 0, 1 - d.c.h);
  } else {
    let x0 = d.c.x, y0 = d.c.y, x1 = d.c.x + d.c.w, y1 = d.c.y + d.c.h;
    if (d.hit === 0) { x0 = clamp(iuv[0], 0, x1 - .02); y0 = clamp(iuv[1], 0, y1 - .02); }
    if (d.hit === 1) { x1 = clamp(iuv[0], x0 + .02, 1); y0 = clamp(iuv[1], 0, y1 - .02); }
    if (d.hit === 2) { x0 = clamp(iuv[0], 0, x1 - .02); y1 = clamp(iuv[1], y0 + .02, 1); }
    if (d.hit === 3) { x1 = clamp(iuv[0], x0 + .02, 1); y1 = clamp(iuv[1], y0 + .02, 1); }
    c.x = x0; c.y = y0; c.w = x1 - x0; c.h = y1 - y0;
    if (s.cropAspect) {
      const imgAsp = im.w / im.h;
      c.h = c.w * imgAsp / s.cropAspect;
      if (c.y + c.h > 1) { c.h = 1 - c.y; c.w = c.h * s.cropAspect / imgAsp; }
    }
  }
  drawOverlay();
}

/* ---------------- history ---------------- */
function snapshot() { return JSON.stringify(S()); }
function pushHistory() {
  const im = IM(); if (!im) return;
  im.hist = im.hist || []; im.hp = im.hp === undefined ? -1 : im.hp;
  const s = snapshot();
  if (im.hist[im.hp] === s) return;
  im.hist = im.hist.slice(0, im.hp + 1);
  im.hist.push(s); if (im.hist.length > 60) im.hist.shift();
  im.hp = im.hist.length - 1;
}
function undo(dir) {
  const im = IM(); if (!im || !im.hist) return;
  const np = im.hp + dir;
  if (np < 0 || np >= im.hist.length) return;
  im.hp = np; im.s = JSON.parse(im.hist[np]);
  A.selMask = Math.min(A.selMask, im.s.masks.length - 1);
  syncAll(); rebuildMasks(); requestRender(false);
  toast(dir < 0 ? 'Undo' : 'Redo');
}

function syncAll() { ctrls.forEach(c => c.sync && c.sync()); drawCurve(); syncCurveBadge(); }
/* ============================================================
   p4: loading, export, shortcuts, boot
   ============================================================ */

/* ---------------- loading ---------------- */
async function loadFiles(files) {
  const list = [...files];
  if (!list.length) return;
  let first = A.imgs.length;
  for (const f of list) {
    try {
      const im = f.name.toLowerCase().endsWith('.fedr') ? await loadFedr(f) : await loadStd(f);
      if (im) A.imgs.push(im);
    } catch (err) {
      console.error(err);
      const raw = /\.(cr2|cr3|nef|arw|raf|rw2|orf|dng|pef|srw)$/i.test(f.name);
      toast(raw ? `${f.name}: camera raw needs rawprep.py first` : `Could not read ${f.name}`);
    }
  }
  $('#drop').hidden = A.imgs.length > 0;
  buildStrip();
  if (A.cur < 0 && A.imgs.length) selectImage(first < A.imgs.length ? first : 0);
  else buildStrip();
}

function baseImage(name, w, h, linear) {
  return { name, w, h, linear, s: defaults(), tex: null, brushes: [], seed: Math.random() * 40, dirty: false, hist: [], hp: -1 };
}

async function loadStd(file) {
  const bmp = await createImageBitmap(file, { colorSpaceConversion: 'default' });
  const im = baseImage(file.name, bmp.width, bmp.height, false);
  im.tex = mkTex();
  gl.bindTexture(gl.TEXTURE_2D, im.tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, bmp);
  im.thumb = thumbFromBitmap(bmp);
  bmp.close && bmp.close();
  return im;
}

/* .fedr : "FEDR" | u32 headerLen | JSON header | float16 RGBA planarless */
async function loadFedr(file) {
  const buf = await file.arrayBuffer();
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'FEDR') throw new Error('not a fedr file');
  const hlen = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, hlen)));
  const w = head.width, h = head.height;
  const data = new Uint16Array(buf, 8 + hlen, w * h * 4);
  const im = baseImage(head.name || file.name, w, h, true);
  im.meta = head;
  im.tex = mkTex();
  gl.bindTexture(gl.TEXTURE_2D, im.tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, data);
  im.thumb = thumbFromHalf(data, w, h);
  if (head.camera) im.name = head.name || file.name;
  return im;
}

function thumbFromBitmap(bmp) {
  const c = document.createElement('canvas');
  const k = 150 / Math.max(bmp.width, bmp.height);
  c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', .72);
}
function half2f(h) {
  const s = (h & 0x8000) >> 15, e = (h & 0x7C00) >> 10, f = h & 0x03FF;
  if (e === 0) return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : (s ? -Infinity : Infinity);
  return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}
function thumbFromHalf(data, w, h) {
  const c = document.createElement('canvas');
  const k = 150 / Math.max(w, h);
  const tw = Math.max(1, Math.round(w * k)), th = Math.max(1, Math.round(h * k));
  c.width = tw; c.height = th;
  const ctx = c.getContext('2d'), id = ctx.createImageData(tw, th);
  const enc = x => { x = Math.max(0, Math.min(1, x)); return Math.round(255 * (x <= .0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - .055)); };
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
    const sx = Math.min(w - 1, Math.round(x / k)), sy = Math.min(h - 1, Math.round(y / k));
    const si = (sy * w + sx) * 4, di = (y * tw + x) * 4;
    id.data[di] = enc(half2f(data[si])); id.data[di + 1] = enc(half2f(data[si + 1]));
    id.data[di + 2] = enc(half2f(data[si + 2])); id.data[di + 3] = 255;
  }
  ctx.putImageData(id, 0, 0);
  return c.toDataURL('image/jpeg', .72);
}

function selectImage(i) {
  if (i < 0 || i >= A.imgs.length) return;
  A.cur = i; A.selMask = -1; A.showMask = false; A.cropMode = false; A.cropDraft = null;
  const cb = $('#cropBtn'); if (cb) cb.classList.remove('on');
  A.view = { zoom: 0, ox: .5, oy: .5, fit: true };
  uploadAllBrushes();
  syncAll(); rebuildMasks(); buildStrip();
  $('#drop').hidden = true;
  requestRender(true);
}

/* ---------------- export ---------------- */
function freeExport() {
  ['ebase', 'eb1', 'eb2', 'eb3', 'eb4', 'eout'].forEach(k => {
    const f = FBO[k]; if (f) { gl.deleteTexture(f.tex); gl.deleteFramebuffer(f.fb); delete FBO[k]; }
  });
}

async function renderFull(im, opts) {
  const G = geom(im.s, im.w, im.h);
  let W = Math.round(G.outW), H = Math.round(G.outH);
  const MAXPX = 60e6;
  if (W * H > MAXPX) { const k = Math.sqrt(MAXPX / (W * H)); W = Math.round(W * k); H = Math.round(H * k); }
  const R = develop(im, W, H, [1, 1], [.5, .5], true);
  const px = new Uint8Array(W * H * 4);
  gl.bindFramebuffer(gl.FRAMEBUFFER, R.out.fb);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const id = ctx.createImageData(W, H);
  id.data.set(new Uint8ClampedArray(px.buffer, px.byteOffset, px.length));
  for (let i = 3; i < id.data.length; i += 4) id.data[i] = 255;
  ctx.putImageData(id, 0, 0);
  freeExport();

  let outCv = cv;
  let tw = W, th = H;
  if (opts.longEdge > 0) {
    const k = opts.longEdge / Math.max(W, H);
    if (k < 1) { tw = Math.max(1, Math.round(W * k)); th = Math.max(1, Math.round(H * k)); }
  }
  if (tw !== W || th !== H) {
    // two-step box reduction keeps stars crisp
    let cur = cv, cw = W, ch = H;
    while (cw / 2 > tw && ch / 2 > th) {
      const n = document.createElement('canvas'); n.width = Math.round(cw / 2); n.height = Math.round(ch / 2);
      n.getContext('2d').drawImage(cur, 0, 0, n.width, n.height);
      cur = n; cw = n.width; ch = n.height;
    }
    const n = document.createElement('canvas'); n.width = tw; n.height = th;
    const nx = n.getContext('2d'); nx.imageSmoothingQuality = 'high';
    nx.drawImage(cur, 0, 0, tw, th);
    outCv = n;
  }
  const mime = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' }[opts.format];
  const blob = await new Promise(res => outCv.toBlob(res, mime, opts.quality / 100));
  return { blob, w: tw, h: th, ext: opts.format === 'jpeg' ? 'jpg' : opts.format };
}

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const EXPORT = { format: 'jpeg', quality: 92, longEdge: 0, suffix: '-dev' };

function exportDialog(all) {
  if (A.cur < 0) { toast('Open a photo first'); return; }
  const card = $('#card');
  card.innerHTML = `
    <h4>Export ${all ? A.imgs.length + ' photos' : 'photo'}</h4>
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
      <button class="tb primary" id="exGo">Export</button>
    </div>`;
  $('#exFmt').value = EXPORT.format; $('#exQ').value = EXPORT.quality;
  $('#exL').value = EXPORT.longEdge || ''; $('#exS').value = EXPORT.suffix;
  const im = IM(), G = geom(im.s, im.w, im.h);
  $('#exInfo').textContent = `Full size ${Math.round(G.outW)} × ${Math.round(G.outH)} px`;
  $('#modal').classList.add('open');
  $('#exCancel').onclick = () => $('#modal').classList.remove('open');
  $('#exGo').onclick = async () => {
    EXPORT.format = $('#exFmt').value;
    EXPORT.quality = clamp(parseInt($('#exQ').value) || 92, 50, 100);
    EXPORT.longEdge = parseInt($('#exL').value) || 0;
    EXPORT.suffix = $('#exS').value;
    $('#modal').classList.remove('open');
    const targets = all ? A.imgs.map((_, i) => i) : [A.cur];
    const keep = A.cur;
    for (const i of targets) {
      const image = A.imgs[i];
      toast(`Exporting ${i + 1}/${targets.length} — ${image.name}`);
      A.cur = i; uploadAllBrushes(); uploadLUT();
      await new Promise(r => setTimeout(r, 16));
      try {
        const r = await renderFull(image, EXPORT);
        const base = image.name.replace(/\.[^.]+$/, '');
        download(r.blob, base + EXPORT.suffix + '.' + r.ext);
      } catch (e) { console.error(e); toast('Export failed for ' + image.name); }
    }
    A.cur = keep; uploadAllBrushes();
    toast(targets.length > 1 ? `Exported ${targets.length} photos` : 'Exported');
    requestRender(false);
  };
}

/* ---------------- presets, copy/paste ---------------- */
function copySettings() {
  if (A.cur < 0) return;
  const s = JSON.parse(snapshot());
  delete s.crop; delete s.rot90; delete s.flipH; delete s.flipV; delete s.straighten;
  A.clipboard = s; toast('Settings copied');
}
function pasteSettings() {
  if (A.cur < 0 || !A.clipboard) { toast('Nothing to paste'); return; }
  const im = IM(), keep = { crop: im.s.crop, rot90: im.s.rot90, flipH: im.s.flipH, flipV: im.s.flipV, straighten: im.s.straighten };
  im.s = Object.assign(defaults(), JSON.parse(JSON.stringify(A.clipboard)), keep);
  // brush masks cannot carry paint across photos
  im.s.masks = im.s.masks.filter(m => m.type !== 'brush');
  A.selMask = im.s.masks.length ? 0 : -1;
  syncAll(); rebuildMasks(); requestRender(true);
  toast('Settings pasted');
}
function resetAll() {
  if (A.cur < 0) return;
  IM().s = defaults(); A.selMask = -1; A.cropDraft = null;
  syncAll(); rebuildMasks(); requestRender(true); toast('Reset');
}

/* ---------------- shortcuts ---------------- */
function wireKeys() {
  addEventListener('keydown', e => {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)) {
      if (e.key === 'Escape') t.blur(); return;
    }
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key.toLowerCase() === 'e') { e.preventDefault(); exportDialog(e.shiftKey); return; }
    if (meta && e.key.toLowerCase() === 'c') { copySettings(); return; }
    if (meta && e.key.toLowerCase() === 'v') { pasteSettings(); return; }
    if (meta && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(e.shiftKey ? 1 : -1); return; }
    if (e.key === '\\') { if (!A.before) { A.before = true; requestRender(false); } e.preventDefault(); return; }
    if (meta) return;
    const k = e.key.toLowerCase();
    if (k === 'z') { A.view.fit = !A.view.fit; if (!A.view.fit) A.view.zoom = 1; requestRender(false); }
    if (k === 'c') toggleCrop();
    if (k === 'm') addMask('radial');
    if (k === 'g') addMask('linear');
    if (k === 'b') addMask('brush');
    if (k === 'l') addMask('lum');
    if (k === 'k') addMask('color');
    if (k === 'r' && !meta) resetAll();
    if (k === 'o') { A.showMask = !A.showMask; rebuildMasks(); requestRender(true); }
    if (e.key === '[' || e.key === ']') {
      const m = S().masks[A.selMask];
      if (m && m.type === 'brush') { m.geo.size = clamp(m.geo.size * (e.key === '[' ? .8 : 1.25), 1, 60); rebuildMasks(); }
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') selectImage(A.cur + 1);
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') selectImage(A.cur - 1);
    if (/^[1-9]$/.test(e.key)) {
      const slot = e.key;
      if (e.shiftKey) {
        const s = JSON.parse(snapshot());
        delete s.crop; delete s.rot90; delete s.flipH; delete s.flipV; delete s.straighten;
        s.masks = s.masks.filter(m => m.type !== 'brush');
        A.presets[slot] = s; toast('Preset ' + slot + ' saved');
      } else if (A.presets[slot] && A.cur >= 0) {
        const im = IM(), keep = { crop: im.s.crop, rot90: im.s.rot90, flipH: im.s.flipH, flipV: im.s.flipV, straighten: im.s.straighten };
        im.s = Object.assign(defaults(), JSON.parse(JSON.stringify(A.presets[slot])), keep);
        A.selMask = im.s.masks.length ? 0 : -1;
        syncAll(); rebuildMasks(); requestRender(true); toast('Preset ' + slot);
      }
    }
  });
  addEventListener('keyup', e => {
    if (e.key === '\\') { A.before = false; requestRender(false); }
  });
}

/* ---------------- boot ---------------- */
function boot() {
  initGL();
  buildPanels();
  wireStage();
  wireKeys();

  $('#btnOpen').onclick = () => $('#file').click();
  $('#file').onchange = e => { loadFiles(e.target.files); e.target.value = ''; };
  $('#btnFit').onclick = () => { A.view.fit = true; requestRender(false); };
  $('#btn100').onclick = () => { A.view.fit = false; A.view.zoom = 1; requestRender(false); };
  $('#btnBefore').onclick = () => { A.before = !A.before; $('#btnBefore').classList.toggle('on', A.before); requestRender(false); };
  $('#btnCopy').onclick = copySettings;
  $('#btnPaste').onclick = pasteSettings;
  $('#btnReset').onclick = resetAll;
  $('#btnExport').onclick = () => exportDialog(false);
  $('#btnExportAll').onclick = () => exportDialog(true);
  $('#modal').onclick = e => { if (e.target.id === 'modal') $('#modal').classList.remove('open'); };

  const stage = $('#stage');
  ['dragenter', 'dragover'].forEach(t => addEventListener(t, e => { e.preventDefault(); stage.classList.add('dragover'); }));
  ['dragleave', 'drop'].forEach(t => addEventListener(t, e => { e.preventDefault(); if (t === 'dragleave' && e.relatedTarget) return; stage.classList.remove('dragover'); }));
  addEventListener('drop', e => { e.preventDefault(); if (e.dataTransfer && e.dataTransfer.files.length) loadFiles(e.dataTransfer.files); });

  const ro = new ResizeObserver(() => { requestRender(false); drawHisto(); drawCurve(); });
  ro.observe(stage); ro.observe($('#insp'));

  drawHisto(); drawCurve();
  if (!floatOK) toast('No float render target — highlight headroom limited');
}
document.addEventListener('DOMContentLoaded', boot);