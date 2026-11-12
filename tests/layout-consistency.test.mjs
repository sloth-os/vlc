#!/usr/bin/env node
/*
 * Layout consistency: the Int32 indices in native/shared.h (read by C) must
 * match src/layout.js and src/audio-worklet.js (read by JavaScript). The C
 * side has _Static_asserts that fail the BUILD if its own structs move; this
 * test fails the TEST run when the JS mirrors drift from the C source of
 * truth (parsed here with a regex, no compiler needed).
 *
 * It also verifies the RPC call-block layout offsets exported through
 * wv_call_layout() against bridge.c's table, and the EVENT enum against
 * src/engine.js.
 *
 * Usage: node tests/layout-consistency.test.mjs   (any cwd)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' -- ' + extra : '')); console.log('FAIL  ' + name + (extra ? ' -- ' + extra : '')); }
}

// ---- parse the C header ------------------------------------------------
// Fields are annotated `/* N index */` in shared.h.
const sharedH = read('native/shared.h');
const cRing = {};
for (const m of sharedH.matchAll(/(_Atomic\s+)?(?:uint32_t|int32_t|float\s*\*|uint8_t\s*\*\s*\*\s*\[\w+\]|uint32_t\s*\[\d\])\s+(\w+)(\[\d\])?;?\s*\/\*\s*(\d+)/g)) {
  cRing[m[2]] = Number(m[4]);
}
// Simpler and more robust: walk declaration lines with index comments.
function cIndices(text) {
  const out = {};
  for (const line of text.split('\n')) {
    // e.g. " uint32_t pitch[3];            /*  7..9 */"
    //      "    _Atomic uint32_t write;       /*  1 frames written, wraps */"
    //      "    uint8_t *planes[WV_VIDEO_BUFFERS][3]; /* 13..21 */"
    const m = line.match(/(?:^|[\s*])(\w+)(?:\[[^\]]*\])*\s*;\s*\/\*\s*(\d+)/);
    if (m && !/^(struct|const|typedef|static|_Atomic|uint\d+_t|int\d*_t|float|uint8_t)$/.test(m[1])) {
      out[m[1]] = Number(m[2]);
    }
  }
  return out;
}
const ringBlock = sharedH.slice(sharedH.indexOf('typedef struct wv_ring'), sharedH.indexOf('} wv_ring_t;'));
const videoBlock = sharedH.slice(sharedH.indexOf('typedef struct wv_video'), sharedH.indexOf('} wv_video_t;'));
const cRingIdx = cIndices(ringBlock);
const cVideoIdx = cIndices(videoBlock);

console.log('== ring layout: native/shared.h vs src/layout.js ==');
const layoutJs = read('src/layout.js');
// Evaluate the frozen literals in a scratch vm so JS syntax (not JSON) works.
function evalLiteral(source, varName) {
  const body = source.match(new RegExp(`export const ${varName} = Object\\.freeze\\((\\{[\\s\\S]*?\\})\\);`));
  if (!body) return null;
  return vm.runInNewContext('(' + body[1] + ')');
}
const jsRing = evalLiteral(layoutJs, 'RING');
const jsVideo = evalLiteral(layoutJs, 'VIDEO');
check('layout.js parses', !!jsRing && !!jsVideo, '');

check('ring: the parser found the C indices', Object.keys(cRingIdx).length >= 15,
  JSON.stringify(cRingIdx));
check('video: the parser found the C indices (11 scalar + 3 array names)', Object.keys(cVideoIdx).length >= 14,
  JSON.stringify(cVideoIdx));

// C names are lower_snake_case; JS names UPPER_SNAKE (DATA_PTR maps to data).
const cNameOf = (jsName) => (jsName === 'DATA_PTR' ? 'data' : jsName.toLowerCase());
for (const [name, idx] of Object.entries(jsRing)) {
  const cIdx = cRingIdx[cNameOf(name)];
  check(`ring.${name}: js=${idx} c=${cIdx ?? '?'}`,
    cIdx === idx, `js ${name}=${idx}, c=${cIdx}`);
}
for (const [name, idx] of Object.entries(jsVideo)) {
  if (name === 'SIZE') continue; // JS-only word count, not a C field
  if (/^CROP_/.test(name)) continue; // shared C declaration line; checked as a block below
  // PITCH/LINES/PLANES are the first of a run (pitch[3], lines[3], planes[3][3]).
  const cIdx = cVideoIdx[cNameOf(name)];
  check(`video.${name}: js=${idx} c=${cIdx ?? '?'}`,
    cIdx === idx, `js ${name}=${idx}, c=${cIdx}`);
}
// crop_x..crop_h share one declaration line; assert them directly.
check('video.crop block: 26..29 in C',
  /uint32_t crop_x, crop_y, crop_w, crop_h;/.test(sharedH) &&
  jsVideo.CROP_X === 26 && jsVideo.CROP_Y === 27 && jsVideo.CROP_W === 28 && jsVideo.CROP_H === 29,
  `${jsVideo.CROP_X},${jsVideo.CROP_Y},${jsVideo.CROP_W},${jsVideo.CROP_H}`);
check('ring size: 18 words (the AudioWorklet header view)', jsRing.DATA_PTR === 17, String(jsRing.DATA_PTR));
check('video size: 30 words (the renderer header view)', jsVideo.CROP_H === 29 && jsVideo.SIZE === 30, `${jsVideo.CROP_H}/${jsVideo.SIZE}`);
check('VIDEO_BUFFERS: 3 in both', /#define WV_VIDEO_BUFFERS 3/.test(sharedH) && /VIDEO_BUFFERS = 3/.test(layoutJs), '');

console.log('\n== audio-worklet.js ring indices ==');
const worklet = read('src/audio-worklet.js');
const workletR = worklet.match(/const R = \{([^}]*)\};/)[1];
const workletIdx = {};
for (const m of workletR.matchAll(/(\w+):\s*(\d+)/g)) workletIdx[m[1]] = Number(m[2]);
for (const [name, idx] of Object.entries(workletIdx)) {
  const cIdx = cRingIdx[cNameOf(name)];
  check(`audio-worklet R.${name}: js=${idx} shared.h=${cIdx ?? '?'}`,
    cIdx === idx, `R.${name}=${idx}, shared.h=${cIdx}`);
}

console.log('\n== EVENT enum: native/bridge.c vs src/engine.js ==');
const bridgeC = read('native/bridge.c');
const evDecl = bridgeC.match(/enum \{([\s\S]*?)\};/)[1];
const cEvents = {};
for (const m of evDecl.matchAll(/EV_(\w+)\s*=\s*(\d+)/g)) cEvents[m[1]] = Number(m[2]);
// EV_LOG = 100 is separate
const engineJs = read('src/engine.js');
const evJs = {};
for (const m of engineJs.matchAll(/(\w+):\s*(\d+),?/g)) {
  if (/^(STATE|BUFFERING|POSITION|LENGTH|TRACKS|TRACK_SELECTED|RATE|CAPS|VOUT|STOPPING|META|CHAPTER|TITLES|VOLUME|MUTE|PARSED|MEDIA_CHANGED|RECORDING|PROGRAMS|FRAME_STEP|PERF|LOG)$/.test(m[1])) evJs[m[1]] = Number(m[2]);
}
for (const [name, idx] of Object.entries(cEvents)) {
  check(`EVENT.${name}: engine.js=${evJs[name] ?? '?'} bridge.c=${idx}`,
    evJs[name] === idx, `${name}: js=${evJs[name]}, c=${idx}`);
}
check('EVENT.LOG is 100 in both', cEvents.LOG === 100 && evJs.LOG === 100, `${cEvents.LOG}/${evJs.LOG}`);

console.log('\n== wv_call_layout() table vs the F offsets ==');
// bridge.c's offsets[] order must match engine.js/smoke-test F indices.
const offsetsDecl = bridgeC.match(/static const int offsets\[\] = \{([\s\S]*?)\};/)[1];
const offsets = [...offsetsDecl.matchAll(/offsetof\(\w+,\s*(\w+)\)|sizeof\(\w+\)/g)]
  .map((m) => m[1] || 'SIZE');
const F_ORDER = ['SIZE', 'req', 'fn', 'i', 'd', 's', 'ret_i', 'ret_d', 'ret_s', 'ring', 'video', 'data'];
check('wv_call_layout exports 12 entries', offsets.length === 12, String(offsets));
for (const [k, want] of F_ORDER.entries()) {
  check(`wv_call_layout(${k}) is ${want}`, offsets[k] === want, `${k}: ${offsets[k]}`);
}

console.log('\n== renderer.js layouts vs shared.h enum wv_layout ==');
const rendererJs = read('src/renderer.js');
const layoutsTable = rendererJs.match(/const LAYOUTS = \{([\s\S]*?)\n\};/)[1];
const jsLayouts = [];
for (const m of layoutsTable.matchAll(/(\d+):\s*\{[^}]*\}/g)) jsLayouts.push(Number(m[1]));
check('renderer.js covers exactly layouts 0..6', jsLayouts.join(',') === '0,1,2,3,4,5,6', jsLayouts.join(','));
const cLayouts = sharedH.match(/enum wv_layout\s*\{([\s\S]*?)\};/)[1]
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split(',').map((s) => s.trim()).filter((s) => s && s !== 'WV_LAYOUT_COUNT');
check('shared.h enum wv_layout has 7 entries', cLayouts.length === 7, cLayouts.join(','));

console.log('\n' + '-'.repeat(70));
console.log('layout-consistency: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL LAYOUT CHECKS PASSED');
process.exit(0);
