// Smoke test for the built VLC wasm engine, run in CI right after the build.
//
//   node wasm-smoke-test.mjs <libvlc.js> <libvlc.wasm>
//
// It boots the real engine under Node through the SAME production path the
// site uses (src/engine.js): the ES-module factory, its pthread workers
// (node worker_threads), the mailbox pump, and the bridge call queue. Then
// it asks the bridge for libvlc's version and drives one player through a
// full new -> release cycle, verifying the shared audio ring's magic. That
// exercises, end to end:
//   - the ES-module loader and its pthread workers (node worker_threads),
//   - SharedArrayBuffer + the atomics mailbox + engine.js's pump timer,
//   - the control pthread in native/bridge.c, wv_submit/wvDone round trip,
//   - libvlc_new() and the static module table.
//
// Exits 0 on success, 1 on any failure, with a short diagnostic.

import { access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createEngine } from '../../src/engine.js';

const REQUIRED_ARGS = 2;
const USAGE = 'usage: node wasm-smoke-test.mjs <libvlc.js> <libvlc.wasm>';

function fail(message) {
  console.error(`wasm-smoke-test: ${message}`);
  process.exit(1);
}

// Node >= 20 enables SAB by default; older Node needs --experimental-worker or
// the flag. Nothing to do but report clearly if it is unavailable.
if (typeof SharedArrayBuffer === 'undefined') {
  fail('SharedArrayBuffer is unavailable: run node with --experimental-wasm-threads / a Node >= 20');
}

const [jsPath, wasmPath] = process.argv.slice(2);
if (process.argv.length - 2 !== REQUIRED_ARGS) fail(USAGE);
for (const p of [jsPath, wasmPath]) {
  try { await access(p); } catch { fail(`cannot read ${p}\n${USAGE}`); }
}

// Emscripten's node ENVIRONMENT expects createLibVLCModule as the export; the
// file is an ES module (-sEXPORT_ES6=1). engine.js points its locateFile at
// the wasm binary we were given.
const factory = (await import(pathToFileURL(path.resolve(jsPath)))).default;
if (typeof factory !== 'function') fail('the engine loader has no default export function');

const TIMEOUT_MS = 60000;
const withTimeout = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms)),
  ]);

console.log('booting engine (pthread pool, module table, control thread)...');
const engine = await createEngine(factory, {
  threads: 4,
  locateFile: (p) => (p.endsWith('.wasm') ? path.resolve(wasmPath) : p),
  print: () => {},
  printErr: (s) => console.error('[engine]', s),
});

const first = await withTimeout(engine.call('version', {}, 'json'), TIMEOUT_MS, 'bridge call version()');
const version = first.value;
// libvlc_get_version() is "<version> <codename>" (e.g. "4.0.0-dev Otto
// Chriek") — it never contains "VLC". Require a sane semver-ish string with
// the compiler/changeset fields the site's UI also displays.
if (typeof version?.version !== 'string' || !/^\d+\.\d+/.test(version.version)) {
  fail(`unexpected version payload: ${JSON.stringify(version)}`);
}
console.log('PASS: engine boots under Node');
console.log(`  version:  ${version.version}`);
if (typeof version.compiler !== 'string' || !version.compiler) {
  fail(`version() reported no compiler: ${JSON.stringify(version)}`);
}
if (typeof version.changeset !== 'string' || !version.changeset) {
  fail(`version() reported no changeset: ${JSON.stringify(version)}`);
}

// A player round-trip proves the ring/video structs allocate and the module
// variables (vout=webframe, window=webwindow, amem-data) accept our modules.
const inst = await withTimeout(
  engine.call('instance_new', { s: ['--no-video-title-show'] }),
  TIMEOUT_MS,
  'instance_new()',
);
if (!inst.i) fail('libvlc_new() failed (see the engine log above)');

const player = await withTimeout(
  engine.call('player_new', { i: [inst.i, 1, 48000, 2, 24000] }),
  TIMEOUT_MS,
  'player_new()',
);
if (!player.i) fail('player_new() failed');
const M = engine.Module;
const ringPtr = (player.i >>> 0) + engine.layout.playerRing;
const ringMagic = M.HEAP32[ringPtr >>> 2] >>> 0;
if (ringMagic !== 0x57564152) fail(`the player ring's magic is 0x${ringMagic.toString(16)}, expected WVAR`);

await withTimeout(engine.call('player_release', { i: [player.i] }), TIMEOUT_MS, 'player_release()');
engine.dispose();
console.log('PASS: player lifecycle + shared ring verified');
console.log('wasm-smoke-test: all checks passed');
process.exit(0);
