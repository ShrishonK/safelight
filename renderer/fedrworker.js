/* ============================================================
   fedrworker.js — pack and unpack compressed .fedr files off the interface thread
   ------------------------------------------------------------
   Inflating and re-interleaving a 24-megapixel frame is ~100 M byte
   moves; done on the page it stalls painting for a noticeable moment,
   so readFedr() hands it here. One job per worker, then it closes.
   ============================================================ */
'use strict';

/* .fedr v2: "FEDR" | u32 headerLen | JSON header | deflate(low bytes ‖ high bytes).
   Splitting each half float's two bytes into planes lets deflate find the
   structure in the high bytes; it roughly halves the file. */
async function encodeFedr(head, rgba) {
  const u8 = new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const n = rgba.length, shuf = new Uint8Array(n * 2);
  for (let i = 0; i < n; i++) { shuf[i] = u8[2 * i]; shuf[n + i] = u8[2 * i + 1]; }
  const packed = new Uint8Array(await new Response(new Blob([shuf]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  let hb = new TextEncoder().encode(JSON.stringify(head));
  const pad = (4 - hb.length % 4) % 4;
  if (pad) { const t = new Uint8Array(hb.length + pad); t.set(hb); t.fill(32, hb.length); hb = t; }
  const out = new Uint8Array(8 + hb.length + packed.length);
  out.set([70, 69, 68, 82], 0);
  new DataView(out.buffer).setUint32(4, hb.length, true);
  out.set(hb, 8);
  out.set(packed, 8 + hb.length);
  return out;
}

self.onmessage = async e => {
  if (e.data.type === 'encode') {
    // the batch denoiser's files are packed here, beside the denoise, not after it
    try {
      const rgba = new Uint16Array(e.data.rgba);
      const file = await encodeFedr(e.data.head, rgba);
      self.postMessage({ ok: true, file, rgba }, [file.buffer, rgba.buffer]);
    } catch (err) {
      self.postMessage({ ok: false, error: String(err && err.message || err) });
    }
    return;
  }
  const { buf, offset, n } = e.data;
  try {
    const packed = new Uint8Array(buf, offset);
    const shuf = new Uint8Array(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    if (shuf.length !== n * 2) throw new Error('this .fedr is damaged or incomplete');
    const data = new Uint16Array(n), u8 = new Uint8Array(data.buffer);
    for (let i = 0; i < n; i++) { u8[2 * i] = shuf[i]; u8[2 * i + 1] = shuf[n + i]; }
    self.postMessage({ ok: true, data }, [data.buffer]);
  } catch (err) {
    self.postMessage({ ok: false, error: String(err && err.message || err) });
  }
};
