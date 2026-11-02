/* ============================================================
   fedrworker.js — unpack a compressed .fedr off the interface thread
   ------------------------------------------------------------
   Inflating and re-interleaving a 24-megapixel frame is ~100 M byte
   moves; done on the page it stalls painting for a noticeable moment,
   so readFedr() hands it here. One job per worker, then it closes.
   ============================================================ */
'use strict';

self.onmessage = async e => {
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
