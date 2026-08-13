#!/usr/bin/env python3
"""
rawprep — turn camera raw files into linear .fedr files that Safelight can open.

Browsers can't decode CR2/CR3/NEF/ARW/DNG/RAF, and they throw away the extra bits
in 16-bit TIFFs. This does the demosaic once, keeps the data linear and unclipped
at half-float precision, and hands the editor the full highlight headroom.

    pip install rawpy numpy pillow
    python rawprep.py ~/shoot/*.ARW --max-dim 4000
    # → ~/shoot/_RTS9019.fedr  → drag into safelight.html

Options
    --max-dim N   longest edge in pixels (0 = full resolution, default 0)
    --half        half-size demosaic: 4x faster, quarter the file
    --scale X     multiply linear values (default 1.0)
    --wb camera|auto|daylight     white balance used for the demosaic
    --preview     also write a quick .jpg next to the .fedr
    --out DIR     write somewhere other than beside the source

File size is width x height x 8 bytes. A 24MP frame is ~192 MB, so --max-dim 4000
is the comfortable working size unless you're printing big.
"""

import argparse, json, os, struct, sys
import numpy as np

RAW_EXT = {'.cr2', '.cr3', '.nef', '.arw', '.raf', '.rw2', '.orf', '.dng', '.pef',
           '.srw', '.raw', '.3fr', '.iiq', '.erf', '.mos', '.mrw'}
IMG_EXT = {'.tif', '.tiff', '.png', '.jpg', '.jpeg', '.webp'}


def read_raw(path, args):
    import rawpy
    wb = {'camera': dict(use_camera_wb=True),
          'auto': dict(use_auto_wb=True),
          'daylight': dict(user_wb=[1.0, 1.0, 1.0, 1.0])}[args.wb]
    with rawpy.imread(path) as raw:
        rgb = raw.postprocess(
            gamma=(1, 1),               # stay linear
            no_auto_bright=True,        # no hidden exposure changes
            output_bps=16,
            half_size=args.half,
            highlight_mode=rawpy.HighlightMode.Blend,
            output_color=rawpy.ColorSpace.sRGB,
            **wb)
    meta = {}
    try:
        from PIL import Image, ExifTags
        with Image.open(path) as im:
            ex = im.getexif()
            tags = {ExifTags.TAGS.get(k, k): v for k, v in ex.items()}
            meta = {'camera': str(tags.get('Model', '')).strip(),
                    'lens': str(tags.get('LensModel', '')).strip()}
    except Exception:
        pass
    return rgb.astype(np.float32) / 65535.0, meta


def read_img(path):
    from PIL import Image
    with Image.open(path) as im:
        arr = np.asarray(im.convert('RGB'))
    a = arr.astype(np.float32) / (65535.0 if arr.dtype == np.uint16 else 255.0)
    # undo the sRGB transfer so the editor gets linear light
    lin = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    return lin.astype(np.float32), {}


def resize(a, max_dim):
    if not max_dim:
        return a
    h, w = a.shape[:2]
    if max(h, w) <= max_dim:
        return a
    from PIL import Image
    k = max_dim / max(h, w)
    nw, nh = max(1, round(w * k)), max(1, round(h * k))
    out = np.empty((nh, nw, 3), np.float32)
    for c in range(3):
        out[:, :, c] = np.asarray(
            Image.fromarray(a[:, :, c]).resize((nw, nh), Image.LANCZOS))
    return np.clip(out, 0, None)


def write_fedr(path, rgb, meta):
    h, w = rgb.shape[:2]
    rgba = np.empty((h, w, 4), np.float16)
    rgba[:, :, :3] = rgb.astype(np.float16)
    rgba[:, :, 3] = np.float16(1.0)
    head = dict(meta)
    head.update(width=int(w), height=int(h), name=os.path.basename(path).rsplit('.', 1)[0],
                colorspace='srgb-linear', format='rgba16f', version=1)
    hb = json.dumps(head).encode('utf-8')
    hb += b' ' * ((4 - len(hb) % 4) % 4)          # keep the pixel data 4-byte aligned
    with open(path, 'wb') as f:
        f.write(b'FEDR')
        f.write(struct.pack('<I', len(hb)))
        f.write(hb)
        f.write(rgba.tobytes())
    return w, h


def preview(path, rgb):
    from PIL import Image
    a = np.clip(rgb, 0, 1)
    s = np.where(a <= 0.0031308, a * 12.92, 1.055 * a ** (1 / 2.4) - 0.055)
    Image.fromarray((s * 255).astype(np.uint8)).save(path, quality=88)


def main():
    ap = argparse.ArgumentParser(description='Convert camera raw to linear .fedr for Safelight')
    ap.add_argument('files', nargs='+')
    ap.add_argument('--max-dim', type=int, default=0)
    ap.add_argument('--half', action='store_true')
    ap.add_argument('--scale', type=float, default=1.0)
    ap.add_argument('--wb', choices=['camera', 'auto', 'daylight'], default='camera')
    ap.add_argument('--preview', action='store_true')
    ap.add_argument('--out', default=None)
    args = ap.parse_args()

    paths = []
    for f in args.files:
        if os.path.isdir(f):
            paths += [os.path.join(f, n) for n in sorted(os.listdir(f))]
        else:
            paths.append(f)

    done = 0
    for p in paths:
        ext = os.path.splitext(p)[1].lower()
        if ext not in RAW_EXT and ext not in IMG_EXT:
            continue
        try:
            rgb, meta = read_raw(p, args) if ext in RAW_EXT else read_img(p)
        except ImportError as e:
            sys.exit(f'Missing dependency: {e}. Run: pip install rawpy numpy pillow')
        except Exception as e:
            print(f'  skip {os.path.basename(p)} — {e}')
            continue
        rgb = resize(rgb, args.max_dim) * args.scale
        outdir = args.out or os.path.dirname(os.path.abspath(p))
        os.makedirs(outdir, exist_ok=True)
        stem = os.path.splitext(os.path.basename(p))[0]
        dst = os.path.join(outdir, stem + '.fedr')
        w, h = write_fedr(dst, rgb, meta)
        size = os.path.getsize(dst) / 1e6
        print(f'  {os.path.basename(p)} → {stem}.fedr  {w}×{h}  {size:.0f} MB')
        if args.preview:
            preview(os.path.join(outdir, stem + '.jpg'), rgb)
        done += 1

    print(f'\n{done} file(s) ready. Drag them onto safelight.html.' if done
          else 'Nothing to convert — point me at raw files.')


if __name__ == '__main__':
    main()
