// Smoke test for the built VLC wasm engine, run in CI right after the build.
//
//   node wasm-smoke-test.mjs <libvlc.js> <libvlc.wasm>
//
// It boots the real engine under Node (its ENVIRONMENT includes node), starts
// the pthread pool, creates a libvlc instance through the bridge RPC queue,
// and asks it for its version. That exercises, end to end:
//   - the ES-module loader and its pthread workers (node worker_threads),
//   - SharedArrayBuffer + the atomics mailbox (crossOriginIsolated is faked
//     for Node below, as emscripten's node shell does),
//   - the control pthread in native/bridge.c, wv_submit/wvDone round trip,
//   - libvlc_new() and the static module table.
//
// Exits 0 on success, 1 on any failure, with a short diagnostic.

import { access, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

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
// file is an ES module (-sEXPORT_ES6=1). Its locateFile is pointed at the
// wasm binary we were given.
let factory;
try {
  factory = (await import(pathToFileURL(path.resolve(jsPath)))).default;
} catch (err) {
  fail(`could not import the engine loader ${jsPath}: ${err?.message ?? err}`);
}
if (typeof factory !== 'function') fail('the engine loader has no default export function');

const F = {
  SIZE: 0, REQ: 1, FN: 2, I: 3, D: 4, S: 5, RET_I: 6, RET_D: 7, RET_S: 8,
};

let M = null;
const pending = new Map(); // req -> done(ptr)
let L = null;
const layoutOf = (field) => L[field];

try {
  M = await factory({
    pthreadPoolSize: 4,
    print: () => {},
    printErr: (s) => console.error('[engine]', s),
    locateFile: (p) => (p.endsWith('.wasm') ? path.resolve(wasmPath) : p),
    wvDone(ptr) {
      ptr >>>= 0;
      const req = M.HEAP32[(ptr + layoutOf(F.REQ)) >>> 2];
      const p = pending.get(req);
      pending.delete(req);
      if (p) p(ptr);
    },
    wvEvent() { /* the smoke test reads no events */ },
  });
} catch (err) {
  fail(`the engine failed to boot: ${err?.message ?? err}`);
}

// The api table index for "version": read the exported name list.
const names = M.UTF8ToString(M._wv_api_names()).split(',').filter(Boolean);
const fnIndex = Object.fromEntries(names.map((n, k) => [n, k]));
if (fnIndex.version === undefined) fail('the bridge exports no "version" api');
L = Array.from({ length: 12 }, (_, k) => M._wv_call_layout(k));

// One bridge call: allocate the call block, fill it, submit, wait.
function call(name, { i = [], d = [], s = [] } = {}) {
  const size = L[F.SIZE];
  const ptr = M._malloc(size) >>> 0;
  if (!ptr) return Promise.reject(new Error('out of memory'));
  M.HEAPU8.fill(0, ptr, ptr + size);
  const req = (M._wv_smoke_req = (M._wv_smoke_req || 0) + 1);
  M.HEAP32[(ptr + L[F.REQ]) >>> 2] = req;
  M.HEAP32[(ptr + L[F.FN]) >>> 2] = fnIndex[name];
  i.forEach((v, k) => { M.HEAP32[(ptr + L[F.I] + 4 * k) >>> 2] = v | 0; });
  d.forEach((v, k) => { M.HEAPF64[(ptr + L[F.D] + 8 * k) >>> 3] = v; });
  const strs = [];
  for (const [k, v] of s.entries()) {
    if (v == null) continue;
    const sp = M.stringToNewUTF8(String(v)) >>> 0;
    if (!sp) {
      strs.forEach((q) => M._free(q));
      M._free(ptr);
      return Promise.reject(new Error('out of memory marshalling a string argument'));
    }
    strs.push(sp);
    M.HEAP32[(ptr + L[F.S] + 4 * k) >>> 2] = sp;
  }
  // NOTE: the s[] strings and the call block itself become C's property on
  // wv_submit (bridge.c's complete() frees them) — never free them here.
  return new Promise((resolve, reject) => {
    pending.set(req, (p) => {
      try {
        const ri = M.HEAP32[(p + L[F.RET_I]) >>> 2];
        const sp = M.HEAP32[(p + L[F.RET_S]) >>> 2] >>> 0;
        let value = null;
        if (sp) {
          value = M.UTF8ToString(sp);
          M._free(sp); // ret_s is malloc'd by C and explicitly ours to free
        }
        M._free(p);
        resolve({ i: ri, value });
      } catch (e) {
        reject(e);
      }
    });
    M._wv_submit(ptr);
  });
}

const TIMEOUT_MS = 60000;
const withTimeout = (promise, ms, what) =>
  Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms)),
  ]);

console.log('booting engine (pthread pool, module table, control thread)...');
const first = await withTimeout(call('version'), TIMEOUT_MS, 'bridge call version()');
const { value } = first;
if (!value) fail('version() returned nothing');

let version;
try {
  version = JSON.parse(value);
} catch (err) {
  fail(`version() returned invalid JSON: ${err?.message}\n${value.slice(0, 400)}`);
}
if (typeof version.version !== 'string' || !version.version.includes('VLC')) {
  fail(`unexpected version payload: ${JSON.stringify(version)}`);
}

console.log(`PASS: engine boots under Node`);
console.log(`  version:  ${version.version}`);
console.log(`  compiler: ${version.compiler ?? ''}`);
console.log(`  changeset: ${version.changeset ?? ''}`);

// A player round-trip proves the ring/video structs allocate and the module
// variables (vout=webframe, window=webwindow, amem-data) accept our modules.
const inst = await withTimeout(call('instance_new', { s: [['--no-video-title-show'].join('\n')] }), TIMEOUT_MS, 'instance_new()');
if (!inst.i) fail('libvlc_new() failed (see the engine log above)');

const player = await withTimeout(
  call('player_new', { i: [inst.i, 1, 48000, 2, 24000] }),
  TIMEOUT_MS,
  'player_new()',
);
if (!player.i) fail('player_new() failed');
const layoutPlayerRing = M._wv_call_layout(9);
const ringMagic = M.HEAP32[(player.i >>> 0) + layoutPlayerRing] >>> 0;
if (ringMagic !== 0x57564152) fail(`the player ring's magic is 0x${ringMagic.toString(16)}, expected WVAR`);

await withTimeout(call('player_release', { i: [player.i] }), TIMEOUT_MS, 'player_release()');
console.log('PASS: player lifecycle + shared ring verified');
console.log('wasm-smoke-test: all checks passed');
process.exit(0);
