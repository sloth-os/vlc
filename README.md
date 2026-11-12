# VLC WASM

[VLC 4](https://code.videolan.org/videolan/vlc)'s playback engine compiled to
WebAssembly, served as an offline-capable PWA on GitHub Pages. Play the media
formats browsers can't — MKV with any codec, FLAC/ALAC, WMV, RealMedia, DVD
images with menus, tracker music… **entirely in your browser**: no uploads, no
server-side processing, works offline after the first visit.

## How it works

- **Engine**: `wasm/libvlc.js` + `libvlc.wasm` (~25 MB) — VLC's `libvlc`,
  `libvlccore` and ~200 statically-linked plugins (FFmpeg, dav1d, libass, …),
  built for `wasm32-unknown-emscripten` with pthreads. The build recipe and the
  C bridge come from [lucasgelfond/libvlc-wasm](https://github.com/lucasgelfond/libvlc-wasm)
  (MIT — thank you!); the engine itself is GPL as VLC and its contribs are.
- **Threading**: the engine runs in a dedicated Web Worker; VLC's pthreads are
  Workers on a pre-started pool. That needs `SharedArrayBuffer`, so the page
  must be cross-origin isolated: on GitHub Pages (no custom headers) the
  service worker re-serves every response with COOP/COEP headers (`coi.js` +
  `sw.js`), costing one reload on the first visit.
- **Video**: the vout (`native/webframe.c`) copies each decoded frame into
  triple-buffered wasm memory; the page claims the newest buffer per animation
  frame and uploads it as WebGL2 textures (YUV→RGB in the shader, HDR matrices
  and full/limited range respected). When the browser offers WebCodecs,
  H.264/HEVC/VP9/AV1 decode on the platform's (usually hardware) decoders
  instead of FFmpeg-in-wasm.
- **Audio**: the aout (`native/webaudio.c`) writes into a ring buffer in wasm
  memory; an AudioWorklet drains it on the audio thread and reports the
  playhead back, so audio stays VLC's master clock and video syncs to it.
- **Files never leave your device**: dropped files are mounted with WORKERFS
  and read lazily (FileReaderSync) — a 4 GB file costs no memory up front.

## File handling

When installed, the PWA doubles as a system-level media handler. Everything
here is feature-detected; browsers without support keep the dropzone:

- **Open with** (desktop Chrome/Edge): `file_handlers` in
  `manifest.webmanifest` registers the app for ~130 media extensions;
  launched files arrive via `window.launchQueue`.
- **Share sheet** (Android Chrome): `share_target` receives shared files as a
  POST to `./__share`, which the service worker stashes in a dedicated cache;
  the app picks them up on the next load.
- **Native pickers** (Chromium): “Open file…” (`showOpenFilePicker`),
  “Open folder…” (`showDirectoryPicker` — a VIDEO_TS folder opens as a DVD
  with menus, clickable).
- Everywhere else (Firefox, Safari, …) these entry points stay hidden.

## How publishing works

`.github/workflows/publish.yml` runs **every Monday 04:00 UTC** (and on
demand):

1. Resolves the head of VLC master (or a commit you specify via
   `workflow_dispatch`) and checks it out
2. Restores the contribs cache keyed on that commit (FFmpeg & co. take about
   an hour cold, minutes warm)
3. Builds VLC's static libraries with emscripten (emsdk 6.0.0), applies the
   patches in `patches/` for the wasm-specific fixes, then links everything
   with our `native/` bridge modules into `wasm/libvlc.{js,wasm}`
4. Smoke-tests the engine under Node (boots it, creates a player, round-trips
   the bridge RPC)
5. Generates `sw-manifest.js` (asset list + cache version) and deploys to
   GitHub Pages

`workflow_dispatch` with `skip_build: true` redeploys the site using the wasm
from the most recent successful run (useful for shipping UI fixes without an
hour-long rebuild).

## Repository layout

| Path | Purpose |
| --- | --- |
| `index.html`, `app.js` | UI (no frameworks, no external resources) |
| `src/` | Page-side player client: worker protocol, engine RPC, WebGL renderer, AudioWorklet |
| `native/` | The C bridge: libvlc RPC + webaudio/webframe/webwindow/webcodecs VLC modules |
| `patches/` | VLC-tree patches the build applies (contrib fixes + wasm playback fixes) |
| `coi.js`, `sw.js`, `offline.html`, `manifest.webmanifest` | PWA / offline / cross-origin-isolation layer |
| `fonts/` | Noto Sans — VLC's freetype needs a font file for subtitles |
| `.github/workflows/publish.yml` | Weekly build & publish pipeline |
| `.github/scripts/build-vlc.sh` | The wasm build: contribs → static libs → emcc link |
| `.github/scripts/wasm-smoke-test.mjs` | Node boot test run in CI |
| `.github/scripts/generate-sw-manifest.mjs` | Writes the versioned precache manifest |
| `icons/` | PWA icons (a traffic cone, naturally) |
| `wasm/` | Build output — **gitignored**; CI generates it, drop local builds here for dev |
| `tests/` | Node test suites (`node tests/run-all.mjs`) |

## Local development

```sh
# put a wasm build in wasm/ (CI artifact, or build it — see below), then:
python3 -m http.server -d . 8080
# open http://localhost:8080 (needs TWO loads the first time: coi.js reloads
# once so the service worker can make the page cross-origin isolated)
```

The engine can be built locally the same way CI does it (no Docker needed):

```sh
git clone https://github.com/videolan/vlc.git ../vlc   # official mirror
# emsdk 6.0.0 on PATH + the apt packages from publish.yml, then:
VLC_SRC=../vlc .github/scripts/build-vlc.sh
```

## License / attribution

VLC is Copyright © the VideoLAN contributors, LGPL-2.1+ with GPL modules; the
compiled engine this site ships is GPL. The web wrapper, CI pipeline, bridge
adaptation and PWA assets in this repository are MIT where not derivative of
libvlc-wasm (which is MIT for its own code, GPL for the binary it builds).
This site is not affiliated with VideoLAN.
