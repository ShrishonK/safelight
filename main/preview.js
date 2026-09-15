'use strict';
/* ============================================================
   preview.js — the JPEG a camera already rendered
   ------------------------------------------------------------
   Nearly every raw carries a finished JPEG next to the sensor
   data. Pulling it out takes a few small reads, so thumbnails
   and the first look at a photo never wait for a demosaic, and
   the renderer never has to receive a whole 25-60 MB raw just
   to show a 300 px picture.
   ============================================================ */
const fs = require('fs');

const HEAD = 512 * 1024;            // covers IFD0 and the makernote of every raw seen so far
const SCAN = 24 * 1024 * 1024;      // how far the format-agnostic fallback looks

/* ---------- JPEG ---------- */
/* dimensions of the JPEG starting at b[off], or null if it is not a plain 8-bit
   baseline/progressive JPEG (lossless JPEG is how many raws store sensor data) */
function jpegInfo(b, off) {
  try { return parseJpegHeader(b, off); } catch (e) { return null; }   // truncated or not a JPEG at all
}
function parseJpegHeader(b, off) {
  if (b[off] !== 0xFF || b[off + 1] !== 0xD8) return null;
  let p = off + 2, orientation = 0;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xFF) return null;
    let m = b[p + 1];
    while (m === 0xFF && p + 2 < b.length) { p++; m = b[p + 1]; }   // fill bytes
    if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { p += 2; continue; }
    const len = b.readUInt16BE(p + 2);
    if (len < 2) return null;
    if (m === 0xE1 && p + 10 + 8 <= b.length && b.toString('latin1', p + 4, p + 10) === 'Exif\0\0') {
      orientation = tiffOrientation(b, p + 10) || orientation;
    }
    if (m === 0xC0 || m === 0xC1 || m === 0xC2) {
      if (p + 9 > b.length || b[p + 4] !== 8) return null;
      return { width: b.readUInt16BE(p + 7), height: b.readUInt16BE(p + 5), orientation, headerEnd: p + 2 + len };
    }
    if ((m >= 0xC3 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) || m === 0xDA) return null;
    p += 2 + len;
  }
  return null;
}

function tiffOrientation(b, t) {
  try {
    const le = b[t] === 0x49;
    const u16 = o => le ? b.readUInt16LE(o) : b.readUInt16BE(o);
    const u32 = o => le ? b.readUInt32LE(o) : b.readUInt32BE(o);
    const ifd = t + u32(t + 4), n = u16(ifd);
    for (let i = 0; i < n && ifd + 2 + i * 12 + 12 <= b.length; i++) {
      const e = ifd + 2 + i * 12;
      if (u16(e) === 0x0112) return u16(e + 8);
    }
  } catch (e) { /* truncated header: no orientation */ }
  return 0;
}

/* ---------- a file we read in pieces ---------- */
async function openSource(path) {
  const fh = await fs.promises.open(path, 'r');
  const size = (await fh.stat()).size;
  const head = Buffer.alloc(Math.min(HEAD, size));
  await fh.read(head, 0, head.length, 0);
  return {
    fh, size, head,
    async bytes(pos, len) {
      if (pos < 0 || pos >= size) return Buffer.alloc(0);
      len = Math.min(len, size - pos);
      if (pos + len <= head.length) return head.subarray(pos, pos + len);
      const b = Buffer.alloc(len);
      const { bytesRead } = await fh.read(b, 0, len, pos);
      return b.subarray(0, bytesRead);
    },
    close() { return fh.close(); }
  };
}

/* ---------- TIFF-shaped raws: CR2 NEF ARW DNG PEF SRW RW2 ORF ---------- */
async function tiffCandidates(src) {
  const h = src.head;
  if (h.length < 16) return null;
  const le = h[0] === 0x49 && h[1] === 0x49, be = h[0] === 0x4D && h[1] === 0x4D;
  if (!le && !be) return null;
  const magic = le ? h.readUInt16LE(2) : h.readUInt16BE(2);
  // 42 is TIFF; Olympus writes 0x4F52/0x5352, Panasonic 0x55
  if (![42, 0x4F52, 0x5352, 0x55].includes(magic)) return null;
  const rd = (b, o, n) => n === 2 ? (le ? b.readUInt16LE(o) : b.readUInt16BE(o)) : (le ? b.readUInt32LE(o) : b.readUInt32BE(o));

  const out = { list: [], orientation: 0 };
  const seen = new Set();
  const walk = async (off, depth, isIfd0) => {
    for (let hops = 0; off > 0 && off < src.size && hops < 8 && depth < 4; hops++) {
      if (seen.has(off)) return;
      seen.add(off);
      const nb = await src.bytes(off, 2);
      if (nb.length < 2) return;
      const n = rd(nb, 0, 2);
      if (!n || n > 1000) return;
      const ifd = await src.bytes(off, 2 + n * 12 + 4);
      if (ifd.length < 2 + n * 12) return;
      const tags = {};
      const subs = [];
      for (let i = 0; i < n; i++) {
        const e = 2 + i * 12;
        const tag = rd(ifd, e, 2), type = rd(ifd, e + 2, 2), count = rd(ifd, e + 4, 4);
        const inline = type === 3 ? rd(ifd, e + 8, 2) : rd(ifd, e + 8, 4);
        tags[tag] = { type, count, value: inline, raw: rd(ifd, e + 8, 4) };
        if (tag === 0x014A) {                       // SubIFDs: NEF and DNG keep previews here
          if (count === 1) subs.push(tags[tag].raw);
          else {
            const arr = await src.bytes(tags[tag].raw, Math.min(count, 16) * 4);
            for (let k = 0; k + 4 <= arr.length; k += 4) subs.push(rd(arr, k, 4));
          }
        }
      }
      if (isIfd0 && tags[0x0112]) out.orientation = tags[0x0112].value;
      if (tags[0x0201] && tags[0x0202]) out.list.push({ off: tags[0x0201].raw, len: tags[0x0202].raw });
      const comp = tags[0x0103] && tags[0x0103].value;
      if ((comp === 6 || comp === 7 || comp === 99) && tags[0x0111] && tags[0x0117] && tags[0x0111].count === 1) {
        out.list.push({ off: tags[0x0111].raw, len: tags[0x0117].raw });
      }
      if (tags[0x002E] && tags[0x002E].count > 64) {   // Panasonic JpgFromRaw
        out.list.push({ off: tags[0x002E].raw, len: tags[0x002E].count });
      }
      for (const s of subs) await walk(s, depth + 1, false);
      const nextOff = 2 + n * 12;
      if (ifd.length < nextOff + 4) return;
      off = rd(ifd, nextOff, 4);
      isIfd0 = false;
    }
  };
  await walk(rd(h, 4, 4), 0, true);
  return out;
}

/* ---------- Fujifilm ---------- */
function rafCandidates(src) {
  const h = src.head;
  if (h.length < 100 || h.toString('latin1', 0, 15) !== 'FUJIFILMCCD-RAW') return null;
  return { list: [{ off: h.readUInt32BE(84), len: h.readUInt32BE(88) }], orientation: 0 };
}

/* ---------- anything else: look for JPEGs by their markers ---------- */
async function scanCandidates(src) {
  const b = src.size <= src.head.length ? src.head : await src.bytes(0, Math.min(SCAN, src.size));
  const list = [];
  const soi = Buffer.from([0xFF, 0xD8, 0xFF]);
  for (let p = b.indexOf(soi), tries = 0; p >= 0 && tries < 400; p = b.indexOf(soi, p + 3), tries++) {
    const info = jpegInfo(b, p);
    if (!info) continue;
    const end = b.indexOf(Buffer.from([0xFF, 0xD9]), info.headerEnd);
    if (end < 0) continue;
    list.push({ off: p, len: end + 2 - p, info });
    p = end;
  }
  return { list, orientation: 0 };
}

/* check a candidate really is a displayable JPEG and measure it */
async function measure(src, c) {
  if (!(c.off > 0) || c.off >= src.size) return null;
  if (c.info) return c;
  const head = await src.bytes(c.off, 256 * 1024);
  const info = jpegInfo(head, 0);
  if (!info) return null;
  let len = c.len;
  if (!(len > 0) || c.off + len > src.size) len = 0;
  return { off: c.off, len, info };
}

async function readJpeg(src, c) {
  if (c.len) return Buffer.from(await src.bytes(c.off, c.len));
  // length unknown: the first EOI after the headers ends the image
  const eoi = Buffer.from([0xFF, 0xD9]);
  const chunks = [];
  for (let pos = c.off, total = 0; pos < src.size && total < 64 * 1024 * 1024;) {
    const b = await src.bytes(pos, 4 * 1024 * 1024);
    if (!b.length) break;
    const from = total === 0 ? c.info.headerEnd : 0;
    const at = b.indexOf(eoi, from);
    if (at >= 0) { chunks.push(b.subarray(0, at + 2)); break; }
    chunks.push(Buffer.from(b.subarray(0, b.length - 1)));   // keep a byte so a split FF D9 is still found
    pos += b.length - 1; total += b.length - 1;
  }
  return Buffer.concat(chunks);
}

/* want 'thumb': the smallest preview that still fills a thumbnail
   want 'large': the biggest one, for the first look at a photo */
async function extractPreview(path, want) {
  let src;
  try {
    src = await openSource(path);
    let found = rafCandidates(src) || await tiffCandidates(src);
    let measured = [];
    if (found) for (const c of found.list) { const m = await measure(src, c); if (m) measured.push(m); }
    if (!measured.length) {
      const scan = await scanCandidates(src);
      measured = scan.list;
      if (!found) found = scan;
    }
    if (!measured.length) return null;
    const area = m => m.info.width * m.info.height;
    measured.sort((a, b) => area(a) - area(b));
    let pick = measured[measured.length - 1];
    if (want === 'thumb') pick = measured.find(m => Math.max(m.info.width, m.info.height) >= 480) || pick;
    const bytes = await readJpeg(src, pick);
    if (bytes.length < 256) return null;
    return {
      bytes,
      width: pick.info.width, height: pick.info.height,
      // a JPEG with its own EXIF orientation is rotated by the decoder already
      orientation: pick.info.orientation ? 0 : (found.orientation || 0)
    };
  } catch (e) {
    return null;
  } finally {
    if (src) src.close().catch(() => { });
  }
}

module.exports = { extractPreview, jpegInfo };
