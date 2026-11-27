/* ============================================================
   presetimport.js — reading presets made for other editors
   ------------------------------------------------------------
   Presets shared online almost never come as Safelight files.
   They come as:
     .xmp         Lightroom Classic / Camera Raw presets (and sidecars)
     .lrtemplate  older Lightroom presets (a Lua table)
     .dng         Lightroom mobile presets: a photo with the settings
                  embedded as an XMP packet
     .zip         a pack of any of the above, often in folders
   This file turns any of those into Safelight presets. Nothing here
   touches the page, so it runs (and is tested) under Node as well.

   A Lightroom preset only lists the settings it changes, so the
   presets made here are "partial": they land on top of the photo's
   current look instead of resetting everything else. The slider
   maths differ between the two apps, so a translated preset is
   close to the original look, not pixel-identical.
   ============================================================ */
'use strict';

(function (root) {
  const CRS_NS = 'http://ns.adobe.com/camera-raw-settings/1.0/';
  const BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'];
  const clampN = (v, a, b) => v < a ? a : v > b ? b : v;
  const stemOf = n => String(n || '').split(/[\\/]/).pop().replace(/\.[^.]+$/, '');

  /* ---------- text helpers ---------- */
  function latin1(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return s;
  }
  function utf8(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); } catch { return latin1(bytes); }
  }
  function unescapeXml(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)))
      .replace(/&amp;/g, '&');
  }

  /* ---------- XMP ----------
     Settings appear either as attributes (crs:Exposure2012="+0.50") or as
     elements; curves are rdf:Seq lists and names are rdf:Alt. Structured
     values (local adjustments, the Look a profile points at) carry crs:
     attributes of their own that must not be mistaken for the preset's. */
  function parseXmp(text) {
    if (!text) return null;
    // the prefix bound to the Camera Raw namespace is almost always crs, but not necessarily
    let P = 'crs';
    const decl = new RegExp('xmlns:([A-Za-z0-9_]+)\\s*=\\s*["\']' + CRS_NS.replace(/[.\/]/g, '\\$&') + '["\']').exec(text);
    if (decl) P = decl[1];
    if (text.indexOf(P + ':') < 0) return null;

    // drop struct-valued elements (their inner crs: attributes belong to them, not to the preset)
    let body = text;
    const elemRe = new RegExp('<' + P + ':([A-Za-z0-9_]+)\\b[^>]*?(?<!/)>([\\s\\S]*?)</' + P + ':\\1>', 'g');
    const crs = {};
    body = body.replace(elemRe, (whole, key, inner) => {
      if (/<rdf:Description|rdf:parseType\s*=\s*["']Resource/.test(inner)) return '';
      const lis = [];
      inner.replace(/<rdf:li\b[^>]*?(?:\/>|>([\s\S]*?)<\/rdf:li>)/g, (_, v) => { lis.push(unescapeXml((v || '').trim())); return ''; });
      if (/<rdf:Alt/.test(inner)) crs[key] = lis.length ? lis[0] : '';
      else if (/<rdf:(Seq|Bag)/.test(inner)) crs[key] = lis;
      else crs[key] = unescapeXml(inner.trim());
      return '';
    });
    const attrRe = new RegExp('\\b' + P + ':([A-Za-z0-9_]+)\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\')', 'g');
    let m;
    while ((m = attrRe.exec(body))) {
      if (!(m[1] in crs)) crs[m[1]] = unescapeXml(m[2] !== undefined ? m[2] : m[3]);
    }
    if (!Object.keys(crs).length) return null;
    return crs;
  }

  /* the XMP packet inside a DNG (or a JPEG): Lightroom mobile presets travel this way */
  function xmpFromBinary(bytes) {
    const s = latin1(bytes);
    let a = s.indexOf('<x:xmpmeta');
    if (a < 0) a = s.indexOf('<rdf:RDF');
    if (a < 0) return null;
    let b = s.indexOf('</x:xmpmeta>', a);
    if (b < 0) b = s.indexOf('</rdf:RDF>', a);
    if (b < 0) return null;
    // the packet is UTF-8; re-decode just that slice so names with accents survive
    const raw = bytes.subarray(a, b + 16);
    return utf8(raw);
  }

  /* ---------- .lrtemplate ----------
     s = { title = "Name", value = { settings = { Exposure2012 = 0.5, ToneCurvePV2012 = { 0, 0, 255, 255 }, ... } } } */
  function parseLua(text) {
    let i = 0;
    const ws = () => {
      for (;;) {
        while (i < text.length && /\s/.test(text[i])) i++;
        if (text.startsWith('--', i)) { while (i < text.length && text[i] !== '\n') i++; continue; }
        break;
      }
    };
    const value = () => {
      ws();
      const c = text[i];
      if (c === '{') return table();
      if (c === '"' || c === "'") return str();
      if (text.startsWith('ZSTR', i)) { i += 4; return value(); }
      const m = /^(true|false|nil|[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/.exec(text.slice(i, i + 64));
      if (!m) throw new Error('unreadable .lrtemplate near "' + text.slice(i, i + 20) + '"');
      i += m[0].length;
      if (m[0] === 'true') return true;
      if (m[0] === 'false') return false;
      if (m[0] === 'nil') return null;
      return parseFloat(m[0]);
    };
    const str = () => {
      const q = text[i++]; let out = '';
      while (i < text.length && text[i] !== q) {
        if (text[i] === '\\') { i++; const e = text[i++]; out += e === 'n' ? '\n' : e === 't' ? '\t' : e; }
        else out += text[i++];
      }
      i++;
      return out;
    };
    const table = () => {
      i++;                                     // {
      const obj = {}, arr = [];
      for (;;) {
        ws();
        if (text[i] === '}') { i++; break; }
        let key = null;
        const km = /^([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(text.slice(i, i + 200));
        if (km) { key = km[1]; i += km[0].length; }
        else if (text[i] === '[') {
          i++; ws(); const k = value(); ws(); if (text[i] === ']') i++; ws(); if (text[i] === '=') i++;
          key = String(k);
        }
        const v = value();
        if (key === null) arr.push(v); else obj[key] = v;
        ws();
        if (text[i] === ',' || text[i] === ';') i++;
      }
      return Object.keys(obj).length ? Object.assign(obj, arr.length ? { _list: arr } : {}) : arr;
    };
    const eq = text.indexOf('=');
    const brace = text.indexOf('{');
    if (brace < 0) throw new Error('not a Lightroom template');
    i = eq >= 0 && eq < brace ? brace : brace;
    return value();
  }

  function parseLrTemplate(text) {
    const t = parseLua(text);
    const settings = t && t.value && t.value.settings;
    if (!settings || typeof settings !== 'object') throw new Error('this .lrtemplate has no develop settings');
    const crs = {};
    for (const [k, v] of Object.entries(settings)) {
      // curves come as a flat list: x0, y0, x1, y1, ...
      if (Array.isArray(v) && /^ToneCurve/.test(k)) {
        const pts = [];
        for (let j = 0; j + 1 < v.length; j += 2) pts.push(v[j] + ', ' + v[j + 1]);
        crs[k] = pts;
      } else if (v !== null && typeof v !== 'object') crs[k] = String(v);
    }
    return { crs, name: t.title || t.internalName || null, group: null };
  }

  /* ---------- curves ---------- */
  function monotone(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0]);
    const n = p.length;
    if (n < 2) return x => x;
    const xs = p.map(q => q[0]), ys = p.map(q => q[1]);
    const dx = [], m = [];
    for (let i = 0; i < n - 1; i++) { dx[i] = xs[i + 1] - xs[i] || 1e-6; m[i] = (ys[i + 1] - ys[i]) / dx[i]; }
    const t = new Array(n);
    t[0] = m[0]; t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = (m[i - 1] * m[i] <= 0) ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
      if (s > 9) { const f = 3 / Math.sqrt(s); t[i] = f * a * m[i]; t[i + 1] = f * b * m[i]; }
    }
    return x => {
      if (x <= xs[0]) return ys[0];
      if (x >= xs[n - 1]) return ys[n - 1];
      let k = 0; while (k < n - 2 && x > xs[k + 1]) k++;
      const h = dx[k], u = (x - xs[k]) / h, u2 = u * u, u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * ys[k] + (u3 - 2 * u2 + u) * h * t[k] + (-2 * u3 + 3 * u2) * ys[k + 1] + (u3 - u2) * h * t[k + 1];
    };
  }

  /* "x, y" strings in 0-255 -> [[x, y]] in 0-1; null if it's the identity */
  function curvePoints(list) {
    if (!Array.isArray(list) || list.length < 2) return null;
    const pts = [];
    for (const it of list) {
      const m = /(-?[\d.]+)\s*,\s*(-?[\d.]+)/.exec(String(it));
      if (m) pts.push([clampN(parseFloat(m[1]) / 255, 0, 1), clampN(parseFloat(m[2]) / 255, 0, 1)]);
    }
    if (pts.length < 2) return null;
    pts.sort((a, b) => a[0] - b[0]);
    if (pts.every(([x, y]) => Math.abs(x - y) < 1 / 512)) return null;
    return pts.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]);
  }

  /* Lightroom's region ("parametric") curve, approximated by bumps over each region */
  function parametricFn(crs) {
    const v = k => parseFloat(crs[k]) || 0;
    const sh = v('ParametricShadows'), dk = v('ParametricDarks'), lt = v('ParametricLights'), hi = v('ParametricHighlights');
    if (!sh && !dk && !lt && !hi) return null;
    const s1 = (parseFloat(crs.ParametricShadowSplit) || 25) / 100;
    const s2 = (parseFloat(crs.ParametricMidtoneSplit) || 50) / 100;
    const s3 = (parseFloat(crs.ParametricHighlightSplit) || 75) / 100;
    const regions = [[sh, 0, s1], [dk, s1, s2], [lt, s2, s3], [hi, s3, 1]];
    const bell = (x, a, b) => {
      const c = (a + b) / 2, w = Math.max(.08, (b - a)) * .9;
      const d = (x - c) / w;
      return Math.abs(d) >= 1 ? 0 : .5 * (1 + Math.cos(Math.PI * d));
    };
    return x => {
      let y = x;
      for (const [amt, a, b] of regions) if (amt) y += amt / 100 * .14 * bell(x, a, b) * Math.min(1, 4 * x * (1 - x) + .25);
      return clampN(y, 0, 1);
    };
  }

  function rgbCurve(crs) {
    const pts = curvePoints(crs.ToneCurvePV2012 || crs.ToneCurve);
    const par = parametricFn(crs);
    if (!par) return pts;
    const pf = pts ? monotone(pts) : (x => x);
    const out = [];
    let last = 0;
    for (let k = 0; k <= 10; k++) {
      const x = k / 10;
      let y = clampN(pf(par(x)), 0, 1);
      if (y < last) y = last;                 // never let the approximation fold over
      last = y;
      out.push([x, Math.round(y * 1000) / 1000]);
    }
    return out;
  }

  /* ---------- Camera Raw settings -> Safelight settings ---------- */
  const KELVIN_REF = 5500;
  function crsToSettings(crs) {
    const s = {};
    const has = k => crs[k] !== undefined && crs[k] !== '' && !Array.isArray(crs[k]);
    const n = k => parseFloat(crs[k]);
    const setDiv = (to, from, div, lo, hi) => { if (has(from) && isFinite(n(from))) s[to] = clampN(n(from) / div, lo, hi); };

    // white balance: relative ("incremental") values map straight across; an absolute
    // temperature is read as a shift from daylight, since Safelight's slider is relative
    const wb = String(crs.WhiteBalance || '').toLowerCase();
    if (has('IncrementalTemperature')) s.temp = clampN(n('IncrementalTemperature'), -100, 100);
    else if (has('Temperature') && wb !== 'as shot' && wb !== 'auto') {
      const r = Math.pow(clampN(n('Temperature'), 2000, 50000) / KELVIN_REF, 1.2);
      const a = (r - 1) / (r + 1);
      s.temp = Math.round(clampN(a / .42 * 100, -100, 100));
    }
    if (has('IncrementalTint')) s.tint = clampN(n('IncrementalTint'), -100, 100);
    else if (has('Tint') && wb !== 'as shot' && wb !== 'auto') s.tint = Math.round(clampN(n('Tint') / 1.5, -100, 100));

    // tone (process 2012 and later)
    if (has('Exposure2012')) s.exposure = clampN(n('Exposure2012'), -5, 5);
    else if (has('Exposure')) s.exposure = clampN(n('Exposure'), -5, 5);
    setDiv('contrast', 'Contrast2012', 100, -1, 1);
    setDiv('highlights', 'Highlights2012', 100, -1, 1);
    setDiv('shadows', 'Shadows2012', 100, -1, 1);
    setDiv('whites', 'Whites2012', 100, -1, 1);
    setDiv('blacks', 'Blacks2012', 100, -1, 1);
    setDiv('texture', 'Texture', 100, -1, 1);
    if (has('Clarity2012')) setDiv('clarity', 'Clarity2012', 100, -1, 1); else setDiv('clarity', 'Clarity', 100, -1, 1);
    setDiv('dehaze', 'Dehaze', 100, -1, 1);
    setDiv('vibrance', 'Vibrance', 100, -1, 1);
    setDiv('saturation', 'Saturation', 100, -1, 1);
    if (String(crs.ConvertToGrayscale).toLowerCase() === 'true') s.saturation = -1;

    // curves
    const rgb = rgbCurve(crs);
    const r = curvePoints(crs.ToneCurvePV2012Red), g = curvePoints(crs.ToneCurvePV2012Green), b = curvePoints(crs.ToneCurvePV2012Blue);
    if (rgb || r || g || b) s.curve = { rgb: rgb || null, r: r || null, g: g || null, b: b || null };

    // colour mixer: the same eight bands, the same -100..100 range
    for (const [key, pre] of [['hslH', 'HueAdjustment'], ['hslS', 'SaturationAdjustment'], ['hslL', 'LuminanceAdjustment']]) {
      const arr = BANDS.map(bn => has(pre + bn) ? clampN(n(pre + bn), -100, 100) : null);
      if (arr.some(v => v !== null)) s[key] = arr;
    }

    // split toning / colour grading
    const cg = [['shHue', 'SplitToningShadowHue', 0, 360], ['shSat', 'SplitToningShadowSaturation', 0, 100],
      ['hiHue', 'SplitToningHighlightHue', 0, 360], ['hiSat', 'SplitToningHighlightSaturation', 0, 100],
      ['cgBal', 'SplitToningBalance', -100, 100],
      ['miHue', 'ColorGradeMidtoneHue', 0, 360], ['miSat', 'ColorGradeMidtoneSat', 0, 100],
      ['shLum', 'ColorGradeShadowLum', -100, 100], ['miLum', 'ColorGradeMidtoneLum', -100, 100],
      ['hiLum', 'ColorGradeHighlightLum', -100, 100], ['cgBlend', 'ColorGradeBlending', 0, 100]];
    for (const [to, from, lo, hi] of cg) if (has(from) && isFinite(n(from))) s[to] = clampN(n(from), lo, hi);

    // detail
    setDiv('sharpen', 'Sharpness', 100, 0, 1.5);
    if (has('SharpenRadius')) s.sharpRadius = clampN(n('SharpenRadius'), .5, 3);
    if (has('SharpenDetail')) s.sharpDetail = clampN(n('SharpenDetail'), 0, 100);
    setDiv('nrLum', 'LuminanceSmoothing', 100, 0, 1);
    setDiv('nrColor', 'ColorNoiseReduction', 100, 0, 1);
    if (has('LuminanceNoiseReductionDetail')) s.nrDetail = clampN(n('LuminanceNoiseReductionDetail'), 0, 100);

    // effects
    setDiv('vignette', 'PostCropVignetteAmount', 100, -1, 1);
    if (has('PostCropVignetteFeather')) s.vigFeather = clampN(n('PostCropVignetteFeather'), 0, 100);
    setDiv('vigRound', 'PostCropVignetteRoundness', 100, -1, 1);
    setDiv('grain', 'GrainAmount', 100, 0, 1);
    if (has('GrainSize')) s.grainSize = clampN(n('GrainSize'), 0, 100);
    return s;
  }

  /* ---------- one preset from Camera Raw settings ---------- */
  function fromCrs(crs, fallbackName, group, source) {
    const type = String(crs.PresetType || '').toLowerCase();
    if (type === 'look' || crs.RGBTable || crs.LookTable) {
      throw new Error('a creative profile, not a preset — Safelight cannot use profiles');
    }
    const settings = crsToSettings(crs);
    if (!Object.keys(settings).length) throw new Error('no settings Safelight understands');
    const name = (crs.Name && String(crs.Name).trim()) || fallbackName;
    // the group the preset's author gave it wins over the folder or zip it came in
    return { name, group: (crs.Group && String(crs.Group).trim()) || group || null, notes: '', settings, partial: true, source };
  }

  /* ---------- zip packs ----------
     Reads the central directory, so files stored after a data descriptor are fine.
     Deflate goes through the platform's DecompressionStream. */
  async function unzip(bytes, depth) {
    depth = depth || 0;
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip file, or a damaged one');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    for (let k = 0; k < count; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const flags = dv.getUint16(p + 8, true);
      const local = dv.getUint32(p + 42, true);
      const nameBytes = u8.subarray(p + 46, p + 46 + nlen);
      const name = (flags & 0x800) ? utf8(nameBytes) : latin1(nameBytes);
      p += 46 + nlen + xlen + clen;
      if (name.endsWith('/') || /(^|\/)__MACOSX\//.test(name) || /(^|\/)\._/.test(name) || /(^|\/)\.DS_Store$/.test(name)) continue;
      if (!/\.(xmp|lrtemplate|dng|slpreset|json|zip)$/i.test(name)) continue;
      if (flags & 1) throw new Error('this zip is password-protected');
      const lnlen = dv.getUint16(local + 26, true), lxlen = dv.getUint16(local + 28, true);
      const start = local + 30 + lnlen + lxlen;
      const data = u8.subarray(start, start + csize);
      let file;
      if (method === 0) file = data.slice();
      else if (method === 8) {
        const ds = new DecompressionStream('deflate-raw');
        file = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(ds)).arrayBuffer());
      } else continue;                        // other compression methods are rare in preset packs
      if (usize && file.length !== usize) continue;
      if (/\.zip$/i.test(name)) {
        if (depth < 2) for (const f of await unzip(file, depth + 1)) out.push({ name: f.name, path: name + '/' + f.path, bytes: f.bytes });
        continue;
      }
      out.push({ name: name.split('/').pop(), path: name, bytes: file });
    }
    return out;
  }

  /* ---------- the entry point ----------
     files: [{ name, bytes }] -> { presets: [...], skipped: [{ name, why }] } */
  async function readPresetFiles(files, packName) {
    const presets = [], skipped = [];
    const seen = new Map();                   // name -> index; a pack often ships each look as .xmp AND .dng
    const rank = src => ({ xmp: 3, lrtemplate: 2, dng: 1 })[src] || 4;
    const add = p => {
      const key = (p.group || '') + '\u0000' + p.name.toLowerCase();
      if (seen.has(key)) {
        const i = seen.get(key);
        if (rank(p.source) > rank(presets[i].source)) presets[i] = p;
        return;
      }
      seen.set(key, presets.length);
      presets.push(p);
    };
    const groupFor = path => {
      // the folder a preset sat in inside a pack names its group, unless it's a format folder
      const parts = String(path || '').split('/').slice(0, -1)
        .filter(d => !/^(xmp|dng|lrtemplate|presets?|lightroom( classic| mobile| cc)?|desktop|mobile|camera raw|acr)$/i.test(d.trim()));
      return parts.length ? parts[parts.length - 1] : null;
    };
    for (const f of files) {
      const bytes = f.bytes instanceof Uint8Array ? f.bytes : new Uint8Array(f.bytes);
      const ext = (/\.([^.]+)$/.exec(f.name) || [])[1];
      const lower = (ext || '').toLowerCase();
      try {
        if (lower === 'zip') {
          const inner = await unzip(bytes);
          if (!inner.length) { skipped.push({ name: f.name, why: 'no presets inside' }); continue; }
          const r = await readPresetFiles(inner.map(x => ({ name: x.name, bytes: x.bytes, path: x.path })), stemOf(f.name));
          r.presets.forEach(add);
          skipped.push(...r.skipped);
          continue;
        }
        const group = (f.path && groupFor(f.path)) || packName || null;
        if (lower === 'xmp') {
          const crs = parseXmp(utf8(bytes));
          if (!crs) throw new Error('no Lightroom settings in this file');
          add(fromCrs(crs, stemOf(f.name), group, 'xmp'));
        } else if (lower === 'lrtemplate') {
          const t = parseLrTemplate(utf8(bytes));
          add(fromCrs(t.crs, t.name || stemOf(f.name), group, 'lrtemplate'));
        } else if (lower === 'dng' || lower === 'jpg' || lower === 'jpeg') {
          const x = xmpFromBinary(bytes);
          const crs = x && parseXmp(x);
          if (!crs) throw new Error('this photo carries no Lightroom settings');
          const p = fromCrs(crs, stemOf(f.name), group, 'dng');
          // a mobile preset's embedded Name is usually the photo's, so prefer the file name
          if (!crs.PresetType) p.name = stemOf(f.name);
          add(p);
        } else if (lower === 'slpreset' || lower === 'json' || lower === 'slcar') {
          const obj = JSON.parse(utf8(bytes));
          const st = obj && (obj.settings || (obj.exposure !== undefined || obj.curve ? obj : null));
          if (!st) throw new Error('no settings found in this file');
          add({ name: obj.name || stemOf(f.name), group: obj.group || group, notes: obj.notes || '', settings: st, partial: !!obj.partial, source: 'safelight' });
        } else {
          skipped.push({ name: f.name, why: 'not a preset format Safelight knows' });
        }
      } catch (e) {
        skipped.push({ name: f.name, why: String(e && e.message || e) });
      }
    }
    return { presets, skipped };
  }

  const api = { parseXmp, xmpFromBinary, parseLrTemplate, crsToSettings, unzip, readPresetFiles, curvePoints, rgbCurve };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.PRESETIO = api;
})(typeof window !== 'undefined' ? window : globalThis);
