# Safelight

A raw and photo developer that runs as a real desktop app on macOS, Windows and Linux.
GPU processing, live tone curves, five kinds of mask, camera raw decoded in place.

---

## Getting an installer

I can't hand you a signed `.dmg` from a Linux sandbox — a Mac app has to be built on a Mac,
and an unsigned installer from a stranger is exactly the thing you shouldn't double-click.
So here are the two honest paths. Both end with a normal install wizard.

### Path A — build it yourself (5 minutes, one time)

Install [Node.js 20+](https://nodejs.org) (the .pkg installer from that page), then in Terminal:

```bash
cd safelight-desktop
npm install
npm run dist:mac      # or: dist:win  /  dist:linux  /  dist  for everything buildable here
```

You get `dist/Safelight-1.0.0-arm64.dmg` (plus an Intel one). Open it, drag Safelight to
Applications, done. On Windows the same steps produce `dist/Safelight Setup 1.0.0.exe` —
a normal NSIS wizard with a "choose install location" step, Start-menu and desktop shortcuts.

**First launch on macOS.** The app isn't signed with an Apple Developer certificate ($99/year),
so Gatekeeper will complain the first time. Either right-click the app → **Open** → **Open**,
or run this once:

```bash
xattr -dr com.apple.quarantine /Applications/Safelight.app
```

If you ever want to hand this to someone else, get a Developer ID certificate and set
`CSC_LINK` / `CSC_KEY_PASSWORD` before `npm run dist:mac`; electron-builder signs and
notarizes from there.

### Path B — let GitHub build all three (no toolchain on your machine)

Push this folder to a GitHub repo and tag it:

```bash
git init && git add . && git commit -m "Safelight"
git tag v1.0.0 && git push origin main --tags
```

`.github/workflows/build.yml` runs on real macOS, Windows and Ubuntu machines and attaches
the `.dmg`, `.exe`, `.AppImage` and `.deb` to the run. Download and install like any other app.
This is also how you'd ship it to anyone else.

### While you're deciding

`npm start` runs the app immediately from source — same app, no installer.

---

## What it does

**Develops camera raw in place.** CR2, CR3, NEF, ARW, RAF, RW2, ORF, DNG and friends are
demosaiced inside the app (dcraw, bundled) into linear 16-bit float and handed straight to
the GPU with full highlight headroom. Clicking a raw shows the camera's embedded JPEG
immediately, a half-size linear develop a couple of seconds later, and the full-resolution
demosaic finishes in the background — sliders work the whole time. The neighbouring frames
are developed ahead of you, so stepping through a shoot rarely waits. JPEG, PNG and WebP
open instantly.

**The panel, top to bottom**

- **Scope** — live RGB histogram with clipping readout.
- **Crop & rotate** — crop tool with aspect presets, straighten, 90° rotation, flips.
- **Basic** — temperature, tint, exposure, contrast, highlights, shadows, whites, blacks,
  texture, clarity, dehaze, vibrance, saturation.
- **Tone curve** — RGB plus per-channel R/G/B, click to add points, monotone spline so it
  never overshoots, histogram behind the grid, updates as you drag.
- **Color mixer** — hue, saturation and luminance for eight colour bands.
- **Color grading** — separate hue/saturation for shadows, midtones, highlights, plus balance.
- **Detail** — sharpening with radius and a detail threshold that protects stars, luminance
  and colour noise reduction.
- **Effects** — vignette with feather and roundness, grain with size.
- **Masks** — linear gradient, radial, brush, luminance range, colour range. Up to six per
  photo, each invertible, each with its own exposure, contrast, highlights, shadows,
  saturation, temperature, tint and texture.

**Red eye** — press `E` (or **Fix red eye** in the Red eye panel) and click each red pupil. The
circle finds the pupil, centres itself on it and sizes itself to fit; drag while placing to size
it by hand, drag a circle to move it, Alt-click to remove it. Only strongly red pixels change, so
the catchlight, iris and eyelid are left alone, and **Pupil darkness** sets how deep the fixed
pupil goes. Like a crop, red-eye fixes stay with their photo: copy/paste and presets skip them.

**Cull** — the **Edit | Cull** toggle in the header swaps the editor for a viewer: panels out of
the way, the photo filling the window with arrows either side, and a ribbon along the bottom
showing the seven frames before and after it. Arrow keys (or the side arrows, or a click in the
ribbon) walk the shoot, and `K` flags what is worth editing — a flagged frame carries a
translucent green bar across the bottom of its preview. A dropdown narrows the shoot to one kind
of file (raw only, say, when a card holds raw and JPEG of every frame). **Move to new workspace…**
moves — not copies — the flagged photos into a new folder (a "Selects" folder beside them unless
you pick elsewhere) and opens it in its own tab, back in Edit. Nothing is overwritten, a name
already in use gets a number, moving across drives copies before it deletes, `.xmp` / `.slcar`
sidecars and your edits go with each photo, and **Move back** undoes the last move while the app
is open. Flags belong to the folder and survive a restart. While culling, the full-resolution
decode waits until you zoom in, so stepping through stays quick.

**Workspaces** — each tab above the panels is a folder. `+` opens another; tabs, and the photo you
were on in each, come back after a restart. Both modes can sort a folder by name or by file type.

**Neural denoise** — runs on the GPU through WebGPU where it can, otherwise on several CPU
threads; the Device setting in its dialog forces one or the other, and the finished message says
which ran. An fp16 export of a model runs about twice as fast on a GPU.

**Every raw in a folder decoded ahead of you** — opening a folder starts a background pass that
decodes its raws one after another, from the photo you're on outwards, and keeps each result on disk
(a compressed linear `.fedr` in the app's data folder). After that a raw opens at full resolution in a
second or two instead of waiting 20–30 s for the demosaic, and the batch denoiser reads from the same
cache. A small "Decoding 12/83" note above the filmstrip shows the pass while it runs. Raws you open
yourself are cached by their own decode. The cache is keyed by path, size and date, so an edited or
replaced file is decoded afresh; it trims itself, least recently opened first, to at most 25 GB and
never more than a quarter of the drive's free space. File → Clear decoded raw cache empties it.

**Denoise a whole folder in the background** — **Denoise all** (above the filmstrip, in the Cull bar,
or `Ctrl+Shift+D`) runs the neural denoiser over every raw in the workspace while you keep working.
Each raw is replaced in the folder by a denoised linear raw — a `.fedr` with the same name — and the
original raw moves into an **Originals** folder beside it, never deleted. Edits carry over: the
denoised file sits at the raw's own exposure, so a look you made on the raw fits it unchanged, and a
photo you are editing when its turn comes just gets cleaner pixels under your sliders. A small pill
in the corner of the photo shows which frame is running, how far along it is and roughly how long is
left, with pause and stop; queued frames carry a **DN** badge in the filmstrip. Stopping keeps
whatever is already finished. Pressing the button again later picks up the raws still left. Before a
frame goes through the network it is lifted to the exposure you edit it at (or to a typical
mid-grey if it is unedited), so the model sees the noise as you will; highlights that lift would clip
keep their original pixels. On a machine with two GPUs WebGPU picks the high-performance one.

**Getting through a shoot** — filmstrip on the left, arrow keys to move, `⌥⌘C` / `⌥⌘V` to copy
settings between frames, `⇧1`–`⇧9` to save a look and `1`–`9` to apply it. Presets survive
restarts. Export one photo with a save dialog, or the whole roll into a folder.

## Shortcuts

| | |
|---|---|
| `⌘O` | open photos |
| `⇧⌘K` | Edit / Cull |
| `E` | red-eye tool on / off |
| `K` | flag this photo (in Cull) |
| `\` (hold) | show the original |
| `⌘B` | toggle original |
| `Z` | fit / 100% |
| `C` | crop tool |
| `G` `M` `B` | add linear, radial, brush mask |
| `L` `K` | add luminance, colour mask |
| `O` | mask overlay on/off |
| `[` `]` | brush size |
| `⌘Z` / `⇧⌘Z` | undo / redo |
| `←` `→` | previous / next photo |
| `⌘E` / `⇧⌘E` | export photo / all photos |
| `⇧⌘D` | denoise every raw in the folder (background) |

Drag any slider's **label** to scrub it; hold shift for fine steps; double-click to reset.

## Notes on the picture

- Everything downstream of the curve happens in linear light at half-float precision, so
  pushing exposure on a night frame recovers real highlight detail rather than grey mush.
- Sharpening and noise reduction are resolution-dependent, as in Lightroom — judge them at
  1:1, not fit.
- Edits are never written to your originals. Each edited photo gets a small record (settings,
  brush paint, a developed thumbnail) in the app's data folder, so leaving a photo, closing the
  folder or quitting never loses a look — it's only baked into pixels when you export.
  `File → Save settings sidecar` writes a portable `.slcar` you can re-apply elsewhere.

## Layout

```
main/main.js         window, menus, dialogs, file associations, edit records, thumbnail cache
main/preview.js      pulls the embedded JPEG out of a raw without decoding it
main/preload.js      the only bridge between the app and the OS
renderer/index.html  interface
renderer/app.js      the developer: WebGL2 pipeline, curves, masks, export
renderer/native.js   desktop layer: native dialogs, menus, preferences, export
renderer/loader.js   photos in memory: preview → half → full, worker pool, memory budget, edits
renderer/rawworker.js  raw decoding off the interface thread
renderer/folder.js   folder browser, filmstrip, thumbnails
renderer/cull.js     Cull mode: flags, file-type filter, moving the keepers to a new workspace
renderer/rawcache.js      decoding a folder's raws in the background, and the on-disk cache of decodes
renderer/batchdenoise.js  Denoise all: the background queue, the status pill, swapping raws for .fedr
renderer/denoisecore.js   the tiled network pass, shared by the page (GPU) and the denoise worker
renderer/denoiseworker.js the neural denoiser in a worker, so a long batch never blocks the interface
renderer/fedrworker.js    unpacks compressed .fedr files off the interface thread
renderer/vendor/     dcraw compiled to JavaScript (patched; see the note at the top of dcraw.js)
tools/rawprep.py     fallback converter if a camera the bundled decoder doesn't know shows up
build/               icon and macOS entitlements
```

`.fedr` files written by the batch denoiser are compressed (header `"version": 2,
"compression": "deflate-shuffle"`) — about half the size of an uncompressed one — and carry the raw's
capture data. Safelight 1.8 and earlier can't open these.

`tools/rawprep.py` (needs `pip install rawpy numpy pillow`) writes `.fedr` files — the same
linear format the app uses internally — for any raw the built-in decoder chokes on:

```bash
python tools/rawprep.py ~/shoot/*.ARW --max-dim 4000
```

## Requirements

macOS 11+, Windows 10+, or a modern Linux. Any GPU from the last decade. Safelight sizes its
photo cache to the machine (about 512 MB of textures on an 8 GB computer, less on smaller ones)
and decodes raws in background workers that return their memory as soon as they finish.
