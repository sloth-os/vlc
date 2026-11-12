# native/ — the C bridge between libvlc and the page

These files are **not part of VLC**: they are compiled out-of-tree against VLC's
headers and linked into the wasm binary as extra static modules. They come from
[lucasgelfond/libvlc-wasm](https://github.com/lucasgelfond/libvlc-wasm) (MIT),
lightly adapted for this site.

| File | What it is |
| --- | --- |
| `bridge.c` | The libvlc API as called from JavaScript: a control pthread runs an RPC queue (`wv_submit`), so libvlc is never called on the Emscripten runtime thread (which would deadlock — VLC's threads proxy filesystem reads to it). Also holds the per-player ring/video structs and all event emission. |
| `webaudio.c` | VLC audio output writing into a ring buffer in wasm memory, drained by an AudioWorklet. Reports timing back to VLC so audio stays the master clock. |
| `webframe.c` | VLC video output copying frames into triple-buffered wasm memory the page uploads with WebGL. Keeps the decoder's pixel layout and colour description. |
| `webwindow.c` | The vout "window" carrying the page's pointer input into VLC (DVD menu buttons). |
| `webcodecs.c` | VLC video decoder backed by the browser's WebCodecs `VideoDecoder` (hardware H.264/HEVC/VP9/AV1 when available). |
| `compat.c` | libc shims (`getrandom`, `sched_getaffinity`). |
| `json.h` | A minimal JSON writer for track lists / metadata. |
| `shared.h` | Memory layouts shared with `src/layout.js` — change one, change both. |

## Why out-of-tree?

VLC needs no patch for any of this: `bridge.c` reaches the player's variables
(`vout`, `window`, `amem-data`, …) through VLC's object-variable API, and the
modules register as static plugins in `vlc_static_modules[]` at link time. That
keeps our VLC clone at upstream master — the only patches applied to the tree
itself live in `../patches/` and exist to make the *build* and edge-case
playback work under emscripten.
