/* ============================================================
   rawworker.js — camera raw decoding off the interface thread
   ------------------------------------------------------------
   dcraw is compiled to asm.js and allocates hundreds of megabytes
   while it demosaics. Running it here keeps sliders, the filmstrip
   and scrolling responsive during a decode, and the page closes
   this worker after every job so all of that memory goes straight
   back to the system instead of waiting on a garbage collector.
   ============================================================ */
'use strict';

importScripts('vendor/dcraw.js');

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

function parsePPM(b) {
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
  return { w, h, maxv, off: i };
}

function identify(bytes) {
  try {
    const txt = self.dcraw(bytes, { verbose: true, identify: true });
    if (typeof txt !== 'string') return {};
    const g = k => (txt.match(new RegExp(k + ':\\s*(.+)')) || [, ''])[1].trim();
    const size = /Output size:\s*(\d+)\s*x\s*(\d+)/.exec(txt);
    return {
      camera: g('Camera'), iso: g('ISO speed'), shutter: g('Shutter'),
      aperture: g('Aperture'), focal: g('Focal length'), timestamp: g('Timestamp'),
      outW: size ? +size[1] : 0, outH: size ? +size[2] : 0
    };
  } catch (e) { return {}; }                // metadata is a nicety, not a requirement
}

/* decoded PPM -> linear RGBA half floats, box-reduced until it fits the GPU */
function toLinearHalf(out, maxTex) {
  let { w, h, maxv, off } = parsePPM(out);
  const LUT = halfLUT(), ONE = toHalf(1);
  const scale = maxv === 255 ? 257 : 1;     // 8-bit fallback -> promote to 16-bit range
  let k = 1;
  while (maxTex && (Math.ceil(w / k) > maxTex || Math.ceil(h / k) > maxTex)) k *= 2;
  const tw = Math.floor(w / k), th = Math.floor(h / k);
  const rgba = new Uint16Array(tw * th * 4);
  if (k === 1) {
    for (let n = tw * th, p = off, o = 0; o < n * 4; o += 4, p += 6) {
      const r = ((out[p] << 8) | out[p + 1]) * scale;
      const g = ((out[p + 2] << 8) | out[p + 3]) * scale;
      const b = ((out[p + 4] << 8) | out[p + 5]) * scale;
      rgba[o] = LUT[r > 65535 ? 65535 : r];
      rgba[o + 1] = LUT[g > 65535 ? 65535 : g];
      rgba[o + 2] = LUT[b > 65535 ? 65535 : b];
      rgba[o + 3] = ONE;
    }
  } else {
    const kk = k * k;
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < k; dy++) {
        let p = off + ((y * k + dy) * w + x * k) * 6;
        for (let dx = 0; dx < k; dx++, p += 6) {
          r += (out[p] << 8) | out[p + 1]; g += (out[p + 2] << 8) | out[p + 3]; b += (out[p + 4] << 8) | out[p + 5];
        }
      }
      const o = (y * tw + x) * 4;
      rgba[o] = LUT[Math.min(65535, Math.round(r * scale / kk))];
      rgba[o + 1] = LUT[Math.min(65535, Math.round(g * scale / kk))];
      rgba[o + 2] = LUT[Math.min(65535, Math.round(b * scale / kk))];
      rgba[o + 3] = ONE;
    }
  }
  return { w: tw, h: th, rgba, reduced: k };
}

self.onmessage = e => {
  const { id, bytes, half, maxTex, skipIdentify } = e.data;
  try {
    const buf = new Uint8Array(bytes);
    const meta = skipIdentify ? {} : identify(buf);
    const opts = { useCameraWhiteBalance: true, use16BitLinearMode: true };
    if (half) opts.setHalfSizeMode = true;
    let out;
    try {
      out = self.dcraw(buf, opts);
    } catch (err) {
      const m = String(err && err.message || err);
      throw new Error(/memory|allocat/i.test(m) ? 'the decoder ran out of memory on this frame' : 'the decoder failed: ' + m.slice(0, 160));
    }
    if (out && typeof out === 'object' && !(out instanceof Uint8Array)) out = Object.values(out)[0];
    if (!out || typeof out === 'string' || out.length < 64) throw new Error('this file is not a raw image the decoder recognises');
    const r = toLinearHalf(out, maxTex);
    out = null;
    self.postMessage({ id, ok: true, w: r.w, h: r.h, rgba: r.rgba, reduced: r.reduced, meta }, [r.rgba.buffer]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
