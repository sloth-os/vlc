# patches/ — VLC tree patches applied at build time

33 fixes from [lucasgelfond/libvlc-wasm](https://github.com/lucasgelfond/libvlc-wasm)
(MIT), rebased onto the VLC master this repo tracks. They cover two things:

1. **making the contribs build under emscripten** (wasm exceptions + SIMD flags
   threaded through, x264 ported, dvdread without dvdcss, …), and
2. **playback correctness the wasm build exposed** (vout EOF hang, demuxer
   probing for streams without timestamps, Siren audio, huge pictures, …).

`build-vlc.sh` applies them all, in filename order, before building; re-running
is idempotent (an already-applied patch is detected and skipped). When one is
superseded upstream, delete it here — e.g. `0006` (A-B loop float ticks) landed
in VLC as `0fddbac847` and is intentionally absent, and `0030` (dvdcss for
emscripten) was rebased for the 1.6.0 tarball rename. `0030` is also skipped by
default at build time (see `build-vlc.sh`): this site distributes no libdvdcss.
