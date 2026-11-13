#!/bin/sh
# Builds VLC's static libraries for wasm32-unknown-emscripten, then links them
# with our native/ bridge into wasm/libvlc.{js,wasm}. Runs on a plain
# ubuntu-24.04 GitHub runner (the emsdk is already on PATH).
#
# Derived from lucasgelfond/libvlc-wasm's build/build-vlc.sh + build/link.sh
# (MIT), restructured for this repo: no Docker, the VLC tree is a checkout of
# the clone this site tracks, and the output is the site's wasm/ directory.
#
# Environment:
#   VLC_SRC      path to the VLC git checkout (required)
#   WORK scratch dir for object files (default: $PWD/.build)
#   OUT_DIR      where libvlc.js/.wasm land (default: $PWD/wasm)
#   JOBS         parallel jobs (default: nproc)
#   PATCHES      patch directory (default: $PWD/patches)
#   VLC_COMMIT   commit to check out; default: whatever VLC_SRC has checked out
set -eu

VLC_SRC=$(cd "${VLC_SRC:?set VLC_SRC to the VLC checkout}" && pwd)
WORK=${WORK:-$(pwd)/.build}
OUT_DIR=${OUT_DIR:-$(pwd)/wasm}
PATCHES=${PATCHES:-$(pwd)/patches}
JOBS=${JOBS:-$(nproc)}
NATIVE=$(cd "$(dirname "$0")/../.." && pwd)/native
# Patches whose number appears here are skipped (superseded upstream, or
# optional).0030 is libdvdcss-for-emscripten: this site never distributes it.
SKIP_PATCHES="0030 "

# emsdk activation puts upstream/emscripten near the front of PATH, and that
# directory contains a `cmake/` *directory* (the CMake toolchain modules). A
# shell skips directories while searching PATH, but GNU make's direct-exec
# fast path does not — so a make recipe that runs plain `cmake` (VLC's
# extras/tools builds its ninja that way) dies with "cmake: Permission
# denied". Put the system directories first: nothing there shadows the
# uniquely-named emsdk tools (emcc, emsdk, ...).
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

export MAKEFLAGS="-j$JOBS"
export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*'

step() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

cd "$VLC_SRC"

if [ -n "${VLC_COMMIT:-}" ]; then
  step "checking out VLC $VLC_COMMIT"
  git fetch -q origin "$VLC_COMMIT" --depth 1 || git fetch -q origin main --depth 1 || true
  git checkout -q -f "$VLC_COMMIT"
fi
VLC_COMMIT=$(git rev-parse HEAD)
echo "VLC_COMMIT=$VLC_COMMIT"

# ---------------------------------------------------------------- patches ---
# Idempotent: an already-applied patch is skipped; a patch whose older version
# is applied gets its files reset (and earlier patches' hunks for those files
# re-applied) first. Re-applying unconditionally would bump mtimes and trigger
# full contrib rebuilds.
step "applying patches"
for p in "$PATCHES"/*.patch; do
  [ -e "$p" ] || continue
  num=$(basename "$p" | cut -c1-4)
  case "$SKIP_PATCHES" in *" $num "*) echo "  $(basename "$p") (skipped)"; continue ;; esac
  if git apply -R --check "$p" 2>/dev/null; then
    echo "  $(basename "$p") (already applied)"
  elif git apply --check "$p" 2>/dev/null; then
    echo "  $(basename "$p")"
    git apply --whitespace=nowarn "$p"
  else
    echo "  $(basename "$p") (an older version is applied: resetting its files)"
    files=$(git apply --numstat "$p" | cut -f3)
    for f in $files; do
      git checkout -q HEAD -- "$f" 2>/dev/null || rm -f "$VLC_SRC/$f"
    done
    for q in "$PATCHES"/*.patch; do
      [ "$q" = "$p" ] && break
      for f in $files; do
        git apply --whitespace=nowarn --include="$f" "$q" 2>/dev/null || true
      done
    done
    git apply --whitespace=nowarn "$p"
  fi
done

# ------------------------------------------------------------- contribs+vlc ---
# The upstream script is the source of truth for contrib/configure flags; we
# only feed it overrides. It is restored from git first so every edit below
# starts from upstream's text whatever an earlier build left behind.
UP=extras/package/wasm-emscripten/build.sh
git checkout -q -- "$UP"

# Upstream configures --enable-debug (-Og + assertions on every hot path).
sed -i 's/--enable-debug/--disable-debug/' "$UP"
OPT_FLAGS=-O3
# Must match the contribs (patches/0002) and the link step below. Given to
# VLC's configure only: exported globally they would also reach the native
# host tools (extras/tools, built with gcc), which reject them.
WASM_FLAGS="-msimd128 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
export VLC_CFLAGS="$OPT_FLAGS $WASM_FLAGS" VLC_LDFLAGS="$WASM_FLAGS"
sed -i 's|    emconfigure "$VLC_SRCPATH"/configure|    CFLAGS="$VLC_CFLAGS" CXXFLAGS="$VLC_CFLAGS" LDFLAGS="$VLC_LDFLAGS" emconfigure "$VLC_SRCPATH"/configure|' "$UP"
# soxr's CMake mistakes -msimd128 for x86 SIMD; VLC has other resamplers.
sed -i 's/--disable-goom \\/--disable-goom --disable-soxr \\/' "$UP"
# No libdvdcss (legal: we distribute none); unencrypted disc images still play.
sed -i 's/--disable-disc /--disable-dvdcss /' "$UP"
# C64 SID music (libsidplay2, GPL).
sed -i 's/ --disable-sidplay2//' "$UP"
# libFLAC, Theora and spatialaudio build for emscripten and native VLC has them.
sed -i 's/ --disable-flac//; s/ --disable-theora//; s/ --disable-spatialaudio//' "$UP"

step "running extras/package/wasm-emscripten/build.sh (mode 1)"
sh extras/package/wasm-emscripten/build.sh --mode=1

# ------------------------------------------------------------------- link ---
step "linking libvlc.wasm"
B="$VLC_SRC/build-emscripten"
C="$VLC_SRC/contrib/wasm32-unknown-emscripten"
OBJ="$WORK/link"
STAGE="$OBJ/stage"
mkdir -p "$OBJ" "$OUT_DIR" "$STAGE"

CFLAGS="-O3 -pthread -msimd128 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm -std=gnu17 -Wall -Wno-unused-parameter"
OURS="webaudio webcodecs webframe webwindow"
for m in $OURS; do
  emcc $CFLAGS -DHAVE_CONFIG_H -I"$B" -I"$VLC_SRC/include" \
    -DMODULE_NAME=$m -DMODULE_STRING="\"$m\"" -c "$NATIVE/$m.c" -o "$OBJ/$m.o"
done
HAS_SOUT=$(grep -q '^#define ENABLE_SOUT 1' "$B/config.h" && echo 1 || echo 0)
emcc $CFLAGS -DWV_HAS_SOUT=$HAS_SOUT -DHAVE_CONFIG_H -I"$B" -I"$VLC_SRC/include" \
  -c "$NATIVE/bridge.c" -o "$OBJ/bridge.o"
emcc $CFLAGS -c "$NATIVE/compat.c" -o "$OBJ/compat.o"

# Static module table: every plugin archive's vlc_entry__* symbol.
step "generating the static module table"
PLUGINS=""
PROTOS=""
LIST=""
EXCLUDE='gles2 egl_display_generic glinterop_sw glsampler_builtin glfilter_draw
glfilter_mock gladjust glblend opengl_filter placebo placebo_gles2 pl_scale vgl
opencv_example opencv_wrapper demux_mock hxxxhelper_testdec blendbench fingerprinter sam3
emscripten_inhibit'
# emscripten_inhibit calls navigator.wakeLock on the runtime thread (a Worker
# with none); the page takes the wake lock itself instead.
for a in "$B"/modules/.libs/lib*_plugin.a; do
  name=$(basename "$a" | sed 's/^lib//; s/_plugin\.a$//')
  case " $(echo $EXCLUDE) " in *" $name "*) continue ;; esac
  entry=$(emnm -g "$a" 2>/dev/null | awk '$2=="T" && $3 ~ /^vlc_entry__/ && $3 !~ /^vlc_entry__(api_version|copyright|license)/ {print $3; exit}')
  [ -n "$entry" ] || { echo "  no entry in $name, skipped"; continue; }
  PLUGINS="$PLUGINS $a"
  PROTOS="${PROTOS}VLC_ENTRY_FUNC($entry);\n"
  LIST="${LIST}    $entry,\n"
done
for ours in $OURS; do
  PROTOS="${PROTOS}VLC_ENTRY_FUNC(vlc_entry__$ours);\n"
  LIST="${LIST}    vlc_entry__$ours,\n"
done
printf '// Generated by the build\n#include <stddef.h>\n#include <vlc_plugin.h>\n%b\nconst vlc_plugin_cb vlc_static_modules[] = {\n%b    NULL\n};\n' \
  "$PROTOS" "$LIST" > "$OBJ/vlc-modules.c"
emcc $CFLAGS -I"$VLC_SRC/include" -I"$B" -c "$OBJ/vlc-modules.c" -o "$OBJ/vlc-modules.o"
echo "  $(grep -c 'VLC_ENTRY_FUNC(' "$OBJ/vlc-modules.c") modules"

# Helper archives the plugins share (avcodec_common, vlc_http, ...).
HELPERS=$(find "$B/modules" -path '*/.libs/*' -name '*.a' ! -name '*_plugin.a')
CONTRIB=$(ls "$C"/lib/*.a | grep -v -e opencv -e glslang -e SPIRV -e HLSL -e OGLCompiler \
  -e OSDependent -e MachineIndependent -e GenericCodeGen -e ggml -e placebo)

step "emcc link"
emcc -O3 -sASSERTIONS=0 -pthread -msimd128 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm \
  "$OBJ/bridge.o" "$OBJ/compat.o" $(for m in $OURS; do printf '%s ' "$OBJ/$m.o"; done) "$OBJ/vlc-modules.o" \
  -Wl,--start-group $PLUGINS $HELPERS \
  "$B/lib/.libs/libvlc.a" "$B/src/.libs/libvlccore.a" "$B/compat/.libs/libcompat.a" \
  $CONTRIB -Wl,--end-group \
  -lm -lstdc++ \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLibVLCModule \
  -sENVIRONMENT=worker,node \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=128MB -sMAXIMUM_MEMORY=4GB \
  -sSTACK_SIZE=1MB -sDEFAULT_PTHREAD_STACK_SIZE=1MB \
  -sPTHREAD_POOL_SIZE='Module["pthreadPoolSize"]||12' -sPTHREAD_POOL_SIZE_STRICT=0 \
  -sFORCE_FILESYSTEM=1 -lworkerfs.js -lnodefs.js \
  -sEXPORTED_FUNCTIONS=_malloc,_free,_wv_submit,_wv_pump,_wv_api_names,_wv_call_layout,_wv_wc_opened,_wv_wc_push,_wv_wc_drained,_wv_wc_error,_wv_wc_free \
  -sEXPORTED_RUNTIME_METHODS=FS,WORKERFS,NODEFS,UTF8ToString,stringToNewUTF8,HEAPU8,HEAP32,HEAPF64,wasmMemory \
  -o "$STAGE/libvlc.js"

# Everything was compiled with the legacy wasm EH encoding (try/catch); link
# flags only convert what emcc compiles at link time, which would leave a
# module mixing try and try_table — Safari rejects those. Translate the
# finished module as a whole instead.
# wasm-opt is NOT on the PATH emsdk activation sets up (its "releases" tool
# activates only upstream/emscripten); it lives in emsdk's bin/ next to emcc.
WASM_OPT=$(dirname "$(command -v emcc)")/../bin/wasm-opt
if [ ! -x "$WASM_OPT" ] && command -v wasm-opt >/dev/null 2>&1; then
  WASM_OPT=$(command -v wasm-opt)
fi
step "translating exception handling to exnref (try_table)"
if [ ! -x "$WASM_OPT" ]; then
  echo "error: wasm-opt not found (looked in $(dirname "$(command -v emcc)")/../bin and PATH)" >&2
  exit 1
fi
"$WASM_OPT" "$STAGE/libvlc.wasm" --translate-to-exnref \
  --enable-threads --enable-bulk-memory --enable-bulk-memory-opt --enable-exception-handling \
  --enable-simd --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals \
  --enable-reference-types --enable-multivalue \
  -o "$STAGE/libvlc.wasm.tmp"
mv "$STAGE/libvlc.wasm.tmp" "$STAGE/libvlc.wasm"

# Replace what is served, wasm first: a page loading mid-update must not get a
# new loader with an old module (that fails with 'Import #0 "env": module is
# not an object').
mkdir -p "$OUT_DIR"
mv "$STAGE/libvlc.wasm" "$OUT_DIR/libvlc.wasm"
mv "$STAGE/libvlc.js" "$OUT_DIR/libvlc.js"
git -C "$VLC_SRC" rev-parse HEAD > "$OUT_DIR/VLC_COMMIT"

step "done"
ls -la "$OUT_DIR"
