/* ============================================================
   exif.js — what the camera was doing when the shutter opened
   ------------------------------------------------------------
   JPEG/TIFF-based files are parsed here; camera raw comes from
   the decoder's own identify pass, which is more reliable across
   the odder formats.
   ============================================================ */
'use strict';

const TAGS = {
  0x010F: 'make', 0x0110: 'model', 0x829A: 'shutter', 0x829D: 'aperture',
  0x8827: 'iso', 0x8833: 'isoAlt', 0x920A: 'focal', 0x9003: 'date', 0x9004: 'dateAlt',
  0xA434: 'lens', 0x9204: 'bias', 0x9207: 'metering', 0xA402: 'expMode', 0x8822: 'progMode'
};

function parseExif(bytes) {
  try {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let tiff = -1;
    if (b[0] === 0xFF && b[1] === 0xD8) {
      // JPEG: walk the marker segments looking for APP1/Exif
      let p = 2;
      while (p < b.length - 4) {
        if (b[p] !== 0xFF) { p++; continue; }
        const marker = b[p + 1], len = (b[p + 2] << 8) | b[p + 3];
        if (marker === 0xE1 &&
          b[p + 4] === 0x45 && b[p + 5] === 0x78 && b[p + 6] === 0x69 && b[p + 7] === 0x66) {
          tiff = p + 10; break;
        }
        if (marker === 0xDA) break;                 // start of scan: no more metadata
        p += 2 + len;
      }
    } else if ((b[0] === 0x49 && b[1] === 0x49) || (b[0] === 0x4D && b[1] === 0x4D)) {
      tiff = 0;                                      // TIFF, and most raws are TIFF underneath
    }
    if (tiff < 0 || tiff + 8 > b.length) return null;

    const le = b[tiff] === 0x49;
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const u16 = o => dv.getUint16(o, le);
    const u32 = o => dv.getUint32(o, le);
    const i32 = o => dv.getInt32(o, le);
    if (u16(tiff + 2) !== 42) return null;

    const out = {};
    const readIFD = (off, depth) => {
      if (depth > 2 || off <= 0 || off + 2 > b.length) return;
      const n = u16(off);
      if (n > 512) return;
      for (let i = 0; i < n; i++) {
        const e = off + 2 + i * 12;
        if (e + 12 > b.length) return;
        const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
        const sizes = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
        const size = (sizes[type] || 1) * count;
        const val = size <= 4 ? e + 8 : tiff + u32(e + 8);
        if (val < 0 || val + Math.min(size, 4) > b.length) continue;
        if (tag === 0x8769 || tag === 0xA005) { readIFD(tiff + u32(e + 8), depth + 1); continue; }
        const name = TAGS[tag];
        if (!name) continue;
        if (type === 2) {
          let s = '';
          for (let k = 0; k < count && val + k < b.length; k++) {
            const ch = b[val + k]; if (!ch) break; s += String.fromCharCode(ch);
          }
          out[name] = s.trim();
        } else if (type === 3) out[name] = u16(val);
        else if (type === 4) out[name] = u32(val);
        else if (type === 5) { const d = u32(val + 4); out[name] = d ? u32(val) / d : 0; }
        else if (type === 10) { const d = i32(val + 4); out[name] = d ? i32(val) / d : 0; }
      }
      const next = u32(off + 2 + n * 12);
      if (next) readIFD(tiff + next, depth + 1);
    };
    readIFD(tiff + u32(tiff + 4), 0);

    if (out.iso === undefined && out.isoAlt !== undefined) out.iso = out.isoAlt;
    if (!out.date && out.dateAlt) out.date = out.dateAlt;
    return Object.keys(out).length ? out : null;
  } catch (e) {
    console.warn('exif parse failed', e);
    return null;
  }
}

/* ---------- formatting ---------- */
function fmtShutter(sec) {
  if (!sec && sec !== 0) return null;
  if (sec >= 1) return (Math.round(sec * 10) / 10) + 's';
  return '1/' + Math.round(1 / sec);
}
function captureLine(x) {
  if (!x) return '';
  return [x.shutterText, x.apertureText, x.isoText, x.focalText].filter(Boolean).join(' · ');
}

/* normalise both sources into one shape */
function captureInfo(im) {
  if (!im) return null;
  if (im.capture) return im.capture;
  const c = {};
  const e = im.exif;
  if (e) {
    c.camera = [e.make, e.model].filter(Boolean).join(' ').replace(/(\w+) \1/i, '$1');
    c.lens = e.lens || '';
    c.shutterText = fmtShutter(e.shutter);
    c.apertureText = e.aperture ? 'f/' + (Math.round(e.aperture * 10) / 10) : null;
    c.isoText = e.iso ? 'ISO ' + e.iso : null;
    c.focalText = e.focal ? Math.round(e.focal) + 'mm' : null;
    c.biasText = (e.bias || e.bias === 0) && e.bias !== 0
      ? (e.bias > 0 ? '+' : '') + (Math.round(e.bias * 10) / 10) + ' EV' : null;
    c.date = e.date || '';
  } else if (im.meta && (im.meta.camera || im.meta.shutter)) {
    // straight from the raw decoder's identify pass
    const m = im.meta;
    c.camera = m.camera || '';
    c.shutterText = m.shutter ? String(m.shutter).replace(/\s*sec\.?$/i, 's').trim() : null;
    c.apertureText = m.aperture ? String(m.aperture).trim() : null;
    c.isoText = m.iso ? 'ISO ' + String(m.iso).trim() : null;
    c.focalText = m.focal ? String(m.focal).trim() : null;
    c.lens = m.lens || '';
    c.date = m.timestamp || '';
  }
  im.capture = c;
  return c;
}

/* ---------- the panel ---------- */
function buildCapturePanel() {
  if (document.getElementById('capBody')) return;
  const insp = document.getElementById('insp');
  if (!insp) return;
  const sect = document.createElement('div'); sect.className = 'sect';
  const h = document.createElement('h3'); h.textContent = 'Capture';
  const badge = document.createElement('span'); badge.className = 'badge'; badge.id = 'capBadge';
  h.append(badge);
  const body = document.createElement('div'); body.className = 'body'; body.id = 'capBody';
  sect.append(h, body);
  h.addEventListener('click', () => sect.classList.toggle('closed'));
  insp.prepend(sect);
  updateCapture();
}

function updateCapture() {
  const body = document.getElementById('capBody');
  if (!body) return;
  const im = IM();
  const c = captureInfo(im);
  const badge = document.getElementById('capBadge');
  if (!im) { body.innerHTML = '<div class="empty">No photo open.</div>'; if (badge) badge.textContent = ''; return; }
  const rows = [
    ['Camera', c && c.camera],
    ['Lens', c && c.lens],
    ['Shutter', c && c.shutterText],
    ['Aperture', c && c.apertureText],
    ['ISO', c && c.isoText && c.isoText.replace('ISO ', '')],
    ['Focal length', c && c.focalText],
    ['Exposure comp.', c && c.biasText],
    ['Taken', c && c.date],
    ['Pixels', `${im.w} × ${im.h}`],
    ['File', im.name]
  ].filter(r => r[1]);
  body.innerHTML = rows.map(([k, v]) =>
    `<div class="row" style="margin:3px 0"><label style="cursor:default">${k}</label>` +
    `<span class="val" style="cursor:default;min-width:0;max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${String(v).replace(/"/g, '')}">${v}</span></div>`
  ).join('') || '<div class="empty">No capture data in this file.</div>';
  if (badge) badge.textContent = captureLine(c);
}

/* ---------- wiring ---------- */
document.addEventListener('DOMContentLoaded', () => {
  buildCapturePanel();

  // read metadata from the bytes as they come in, before anything is decoded
  const prevLoad = window.loadFiles;
  window.loadFiles = async function (files) {
    const list = [...files];
    const meta = new Map();
    for (const f of list) {
      if (!/\.(jpg|jpeg|tif|tiff|png|arw|cr2|nef|dng|raf|rw2|orf|pef|srw)$/i.test(f.name)) continue;
      try {
        const head = new Uint8Array(await f.slice(0, 384 * 1024).arrayBuffer());
        const x = parseExif(head);
        if (x) meta.set(f.name, x);
      } catch (e) { /* metadata is optional */ }
    }
    const r = await prevLoad.call(this, list);
    if (meta.size) {
      for (const im of A.imgs) {
        if (im.exif || !meta.has(im.name)) continue;
        im.exif = meta.get(im.name); im.capture = null;
      }
    }
    updateCapture();
    return r;
  };

  const prevSelect = window.selectImage;
  window.selectImage = function (i) { prevSelect.call(this, i); updateCapture(); };
});