/* ============================================================
   denoisecore.js — the tiled network pass, shared by the page and
   the denoise worker
   ------------------------------------------------------------
   The batch denoiser runs the network wherever the GPU is: WebGPU
   reliably reaches the graphics card from the page, but on some
   machines not from a worker, where ONNX Runtime silently falls back
   to the CPU — 10-20x slower. So the same tile loop lives here and
   either side can call it. Per tile it only copies one tile in and
   blends one tile out (a few ms); the GPU does the rest, so running
   it on the page leaves the interface free.

   Needs toHalf() and half2f() from whoever loads it.
   ============================================================ */
'use strict';

const DNC = (() => {
  let h2fLUT = null;
  const H2F = () => {
    if (h2fLUT) return h2fLUT;
    h2fLUT = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) h2fLUT[i] = half2f(i);
    return h2fLUT;
  };

  function modelIsHalf(sess) { try { return sess.inputMetadata[0].type === 'float16'; } catch { return false; } }
  function modelFixedSize(sess) {
    try {
      const s = sess.inputMetadata && sess.inputMetadata[0] && sess.inputMetadata[0].shape;
      if (!s || s.length !== 4) return null;
      return (typeof s[2] === 'number' && s[2] > 0 && s[2] === s[3]) ? s[2] : null;
    } catch { return null; }
  }
  /* cosine ramp across the overlap, so tile seams vanish */
  function feather(T, ov) {
    const w = new Float32Array(T);
    for (let i = 0; i < T; i++) {
      let v = 1;
      if (i < ov) v *= 0.5 - 0.5 * Math.cos(Math.PI * (i + 0.5) / ov);
      if (i >= T - ov) v *= 0.5 - 0.5 * Math.cos(Math.PI * (T - 0.5 - i) / ov);
      w[i] = Math.max(v, 1e-4);
    }
    return w;
  }

  /* a run that never answers (a lost GPU device does exactly that) is turned into an error */
  function withTimeout(p, ms) {
    if (!ms) return p;
    let t;
    return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('the GPU stopped responding'), { stalled: true })), ms); })])
      .finally(() => clearTimeout(t));
  }

  /* ctx: { ort, session, backend, overlap, tile, progress(f), checkpoint(),
            F32/U16: typed-array constructors of the runtime's own frame (optional),
            timeoutMs(tileIndex, tileTimes): longest a tile may take (optional) }
     src: Float32Array, gamma-encoded RGB 0..1 interleaved, W*H*3 */
  async function runTiles(ctx, src, W, H, tile) {
    const { ort, session: sess } = ctx;
    const inName = sess.inputNames[0], outName = sess.outputNames[0];
    const half = modelIsHalf(sess), h2f = half ? H2F() : null;
    const OV = ctx.overlap;
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
    const total = xs.length * ys.length, plane = T * T, fw = feather(T, OV);
    const F32 = ctx.F32 || Float32Array, U16 = ctx.U16 || Uint16Array;
    const inF = new F32(3 * plane), inH = half ? new U16(3 * plane) : null;
    const times = ctx.tileTimes || (ctx.tileTimes = []);
    let done = 0;

    for (const y0 of ys) {
      for (const x0 of xs) {
        await ctx.checkpoint();
        for (let y = 0; y < T; y++) {
          const sy = Math.min(H - 1, Math.max(0, y0 + y));
          const row = sy * W;
          for (let x = 0; x < T; x++) {
            const sx = Math.min(W - 1, Math.max(0, x0 + x));
            const s = (row + sx) * 3, d = y * T + x;
            inF[d] = src[s]; inF[plane + d] = src[s + 1]; inF[2 * plane + d] = src[s + 2];
          }
        }
        let input;
        if (half) { for (let i = 0; i < inF.length; i++) inH[i] = toHalf(inF[i]); input = new ort.Tensor('float16', inH, [1, 3, T, T]); }
        else input = new ort.Tensor('float32', inF, [1, 3, T, T]);
        let res;
        const t0 = performance.now();
        try { res = await withTimeout(sess.run({ [inName]: input }), ctx.timeoutMs ? ctx.timeoutMs(done, times) : 0); }
        catch (e) { if (done === 0 && !e.stalled) e.firstTile = true; throw e; }
        times.push(performance.now() - t0);
        if (times.length > 200) times.shift();
        const tensor = res[outName];
        if (tensor.dims.length === 4 && tensor.dims[1] === 1) {
          throw new Error('that model outputs a single-channel mask, not a photo — it is a segmentation model, not a denoiser');
        }
        let o = tensor.data;
        if (half) { const f = new Float32Array(o.length); for (let i = 0; i < o.length; i++) f[i] = h2f[o[i]]; o = f; }
        const x1 = Math.max(0, -x0), x2 = Math.min(T, W - x0);
        for (let y = 0; y < T; y++) {
          const gy = y0 + y;
          if (gy < 0 || gy >= H) continue;
          const wy = fw[y], grow = gy * W + x0;
          for (let x = x1; x < x2; x++) {
            const w = wy * fw[x], si = y * T + x, gi = grow + x, di = gi * 3;
            acc[di] += o[si] * w; acc[di + 1] += o[plane + si] * w; acc[di + 2] += o[2 * plane + si] * w;
            wsum[gi] += w;
          }
        }
        if (tensor.dispose) tensor.dispose();
        done++;
        ctx.progress(done / total);
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

  /* a big tile can exhaust GPU memory on a small card; that shows on the first
     tile, so halve it and start over rather than give up */
  async function runModel(ctx, src, W, H) {
    const fixed = modelFixedSize(ctx.session);
    let tile = ctx.tile || (ctx.backend === 'webgpu' ? 768 : 512);
    for (;;) {
      try { return await runTiles(ctx, src, W, H, fixed || tile); }
      catch (e) {
        if (e.firstTile && !fixed && tile > 256 && String(e.message) !== 'cancelled') { tile /= 2; ctx.tile = tile; continue; }
        throw e;
      }
    }
  }

  return { runModel, modelIsHalf, modelFixedSize };
})();
