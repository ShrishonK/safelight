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
the GPU with full highlight headroom. First open of a big raw takes a few seconds; after
that every slider is live. JPEG, PNG and WebP open instantly.

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

**Getting through a shoot** — filmstrip on the left, arrow keys to move, `⌥⌘C` / `⌥⌘V` to copy
settings between frames, `⇧1`–`⇧9` to save a look and `1`–`9` to apply it. Presets survive
restarts. Export one photo with a save dialog, or the whole roll into a folder.

## Shortcuts

| | |
|---|---|
| `⌘O` | open photos |
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

Drag any slider's **label** to scrub it; hold shift for fine steps; double-click to reset.

## Notes on the picture

- Everything downstream of the curve happens in linear light at half-float precision, so
  pushing exposure on a night frame recovers real highlight detail rather than grey mush.
- Sharpening and noise reduction are resolution-dependent, as in Lightroom — judge them at
  1:1, not fit.
- Edits are never written to your originals. Export writes a new file; `File → Save settings
  sidecar` writes a small `.slcar` you can re-apply later.

## Layout

```
main/main.js       window, menus, dialogs, file associations
main/preload.js    the only bridge between the app and the OS
renderer/index.html  interface
renderer/app.js      the developer: WebGL2 pipeline, curves, masks, export
renderer/native.js   desktop layer: raw decoding, native dialogs, menus, preferences
renderer/vendor/     dcraw compiled to JavaScript
tools/rawprep.py     fallback converter if a camera the bundled decoder doesn't know shows up
build/               icon and macOS entitlements
```

`tools/rawprep.py` (needs `pip install rawpy numpy pillow`) writes `.fedr` files — the same
linear format the app uses internally — for any raw the built-in decoder chokes on:

```bash
python tools/rawprep.py ~/shoot/*.ARW --max-dim 4000
```

## Requirements

macOS 11+, Windows 10+, or a modern Linux. Any GPU from the last decade. About 400 MB of RAM
per open photo, more while exporting a large raw.
