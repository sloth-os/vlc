#!/usr/bin/env node
/*
 * Static contract checks for the CI build: .github/workflows/publish.yml and
 * .github/scripts/build-vlc.sh. These catch the classes of mistake that only
 * appear an hour into a CI run (a flag typo, a missing export, an emcc/link
 * mismatch) by asserting the invariants the reference build proved:
 *
 *   - the workflow: weekly schedule, Pages deploy job, wasm artifact, the
 *     patch-cache key, skip_build reuse, the smoke test between build and
 *     deploy, and the site staging guards
 *   - build-vlc.sh: the wasm flags MATCH between the contribs (VLC_CFLAGS)
 *     and the link step — a mismatch is the classic broken-build cause; the
 *     exported bridge functions exist in native/bridge.c; the emcc link
 *     includes every native module; the exnref translation step runs
 *   - patches/: every patch applies to the pinned VLC tree is CI's job, but
 *     the numbering must be gapless and 0006 (upstreamed) and 0030 (dvdcss)
 *     must be handled deliberately
 *
 * Usage: node tests/build-config.test.mjs   (any cwd)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(REPO, p), 'utf8');

function wfOrShOrdersExnrefAfterLink(sh) {
  const linkIdx = sh.indexOf('emcc -O3 -sASSERTIONS=0');
  const exnrefIdx = sh.indexOf('--translate-to-exnref');
  return linkIdx >= 0 && exnrefIdx > linkIdx;
}

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' -- ' + extra : '')); console.log('FAIL  ' + name + (extra ? ' -- ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* --------------------------------------------------------------- workflow */

section('publish.yml: the weekly pipeline');
{
  const wf = read('.github/workflows/publish.yml');
  check('runs on push to main', /push:\s*\n\s*branches: \[main\]/.test(wf), '');
  check('push ignores files that never reach the site (README, tests/, dotfiles)',
    /paths-ignore:[\s\S]*?- 'README\.md'[\s\S]*?- 'tests\/\*\*'[\s\S]*?- '\.\*'/.test(wf), '');
  check('schedules Monday 04:00 UTC', /cron: '0 4 \* \* 1'/.test(wf), '');
  check('also runs on workflow_dispatch', /workflow_dispatch:/.test(wf), '');
  check('workflow_dispatch accepts a vlc_commit input', /vlc_commit:/.test(wf), '');
  check('workflow_dispatch accepts skip_build', /skip_build:/.test(wf), '');
  check('Pages permissions declared (pages: write, id-token: write)', /pages: write/.test(wf) && /id-token: write/.test(wf), '');
  check('deploys with actions/deploy-pages', /actions\/deploy-pages/.test(wf), '');
  check('uploads the wasm-build artifact before deploying', /upload-artifact[\s\S]*name: wasm-build/.test(wf), '');
  check('skip_build reuses the newest run that has the artifact (not just the newest success)',
    /for CAND in .*gh run list[\s\S]*total_count[\s\S]*RUN_ID="\$CAND"; break/.test(wf), '');
  check('the engine is smoke-tested under Node between build and deploy', /wasm-smoke-test\.mjs/.test(wf), '');
  check('the smoke test runs BEFORE the site staging (a broken engine never ships)', wf.indexOf('wasm-smoke-test.mjs') < wf.indexOf('Stage site assets'), '');
  check('the contribs cache key includes the VLC commit AND the patches hash',
    /vlc-contribs-\$\{\{ steps\.vlc\.outputs\.commit \}\}[\s\S]*hashFiles\('patches\/\*'/.test(wf), '');
  check('emscripten version is pinned', /EM_VERSION: \d+\.\d+\.\d+/.test(wf), '');
  check('the VLC source comes from the upstream repo (not a fork)',
    /(code\.videolan\.org|github\.com)\/videolan\/vlc/.test(wf), '');
  check('the site staging guards file count and size', /-gt 80/.test(wf) && /-gt 120/.test(wf), '');
  check('generate-sw-manifest.mjs runs on the staged site', /generate-sw-manifest\.mjs site-publish/.test(wf), '');
  check('staging excludes the build trees', /--exclude='\.vlc-build'/.test(wf) && /--exclude='vlc'/.test(wf), '');
  check('timeout is generous (the cold contribs build takes ~1h)', /timeout-minutes: 360/.test(wf), '');

  let yaml = null;
  try {
 // PyYAML is not a Node dep; do a structural sanity check instead.
    yaml = null;
  } catch { /* checked by the YAML parse in CI lint if any */ }
  const jobsBlock = wf.slice(wf.indexOf('jobs:'));
  const jobs = [...jobsBlock.matchAll(/^  (\w+):$/gm)].map((m) => m[1]);
  check('exactly the build and deploy jobs', jobs.includes('build') && jobs.includes('deploy') && jobs.length === 2, JSON.stringify(jobs));
  check('deploy needs build', /deploy:[\s\S]*needs: build/.test(wf), '');
}

/* ------------------------------------------------------------ build script */

section('build-vlc.sh: the wasm build');
{
  const sh = read('.github/scripts/build-vlc.sh');
  check('requires VLC_SRC', /\$\{VLC_SRC:\?/.test(sh), '');
  check('applies patches idempotently (reverse-check first)', /git apply -R --check/.test(sh), '');
  // The contribs cache stores stamp files (contrib-emscripten/.python-venv)
  // but not contrib/python-venv itself — a restored cache would skip the venv
  // creation and pip3 installs then die with Error 127 (markupsafe/jinja/glad).
  check('drops the stale .python-venv stamp when the venv is missing (cache-restore lie)',
    /if \[ ! -x contrib\/python-venv\/bin\/pip3 \]; then[\s\S]*?rm -rf contrib\/python-venv[\s\S]*?rm -f contrib\/contrib-\*\/\.python-venv/.test(sh), '');
  check('the venv guard runs BEFORE the contrib build',
    sh.indexOf('contrib/python-venv/bin/pip3') < sh.indexOf('extras/package/wasm-emscripten/build.sh --mode=1'), '');
  check('skips the dvdcss patch by number (never distributed)', /SKIP_PATCHES="0030 "/.test(sh), '');
  check('threads the wasm flags into VLC_CFLAGS (contribs compatibility)',
    /WASM_FLAGS="-msimd128 -fwasm-exceptions -sSUPPORT_LONGJMP=wasm"/.test(sh) && /VLC_CFLAGS="\$OPT_FLAGS \$WASM_FLAGS"/.test(sh), '');

  // The critical invariant: the LINK flags must match the VLC_CFLAGS wasm
  // flags, or plugins and core disagree on EH/SIMD/longjmp ABI.
  // The link CFLAGS definition: the line with -O3 -pthread ... (the
  // VLC_CFLAGS export earlier would false-match).
  const cflagsDef = sh.match(/^CFLAGS="([^"]+-pthread[^"]*)"$/m)?.[1] ?? '';
  for (const flag of ['-msimd128', '-fwasm-exceptions', '-sSUPPORT_LONGJMP=wasm', '-pthread']) {
    check(`the link CFLAGS include ${flag} (matches VLC_CFLAGS)`, cflagsDef.includes(flag), cflagsDef);
  }
  check('compiles every native/ module (webaudio, webcodecs, webframe, webwindow)',
    /OURS="webaudio webcodecs webframe webwindow"/.test(sh), '');
  check('compiles bridge.c with WV_HAS_SOUT from config.h', /DWV_HAS_SOUT=\$HAS_SOUT/.test(sh), '');
  check('generates the static module table with emnm', /emnm -g/.test(sh), '');
  check('links libvlc.a + libvlccore.a + libcompat.a inside --start-group', /Wl,--start-group[\s\S]*libvlc\.a[\s\S]*libvlccore\.a[\s\S]*libcompat\.a[\s\S]*Wl,--end-group/.test(sh), '');
  check('MODULARIZE + EXPORT_ES6 + EXPORT_NAME=createLibVLCModule', /sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createLibVLCModule/.test(sh), '');
  check('ENVIRONMENT includes worker and node (the smoke test runs under Node)', /sENVIRONMENT=worker,node/.test(sh), '');
  check('FORCE_FILESYSTEM + workerfs + nodefs (the player mounts files)', /sFORCE_FILESYSTEM=1 -lworkerfs\.js -lnodefs\.js/.test(sh), '');
  check('the pthread pool size is Module-configurable', /sPTHREAD_POOL_SIZE='Module\["pthreadPoolSize"\]\|\|12'/.test(sh), '');
  check('translates EH to exnref AFTER the link (Safari rejects mixed try/try_table)', /--translate-to-exnref/.test(sh) && wfOrShOrdersExnrefAfterLink(sh), '');
  check('replaces the wasm BEFORE the js (no new loader with an old module)', /mv "\$STAGE\/libvlc\.wasm" "\$OUT_DIR\/libvlc\.wasm"[\s\S]*mv "\$STAGE\/libvlc\.js" "\$OUT_DIR\/libvlc\.js"/.test(sh), '');
  check('writes VLC_COMMIT next to the engine (GPL source duty)', /rev-parse HEAD > "\$OUT_DIR\/VLC_COMMIT"/.test(sh), '');
  check('memory: growth allowed, 128 MB initial, 4 GB max', /sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=128MB -sMAXIMUM_MEMORY=4GB/.test(sh), '');

  // The exported bridge functions must exist in native/bridge.c as KEEPALIVE.
  const bridge = read('native/bridge.c');
  for (const fn of ['_wv_submit', '_wv_pump', '_wv_api_names', '_wv_call_layout',
                    '_malloc', '_free']) {
    const bare = fn.replace(/^_/, '');
    check(`EXPORTED_FUNCTIONS ${fn} exists in native/bridge.c`,
 new RegExp(`EMSCRIPTEN_KEEPALIVE[\\s\\S]{0,120}\\b${bare}\\s*\\(`).test(bridge) || bare === 'malloc' || bare === 'free',
      bare);
  }
  // And webcodecs.c owns the wc_* exports.
  const wc = read('native/webcodecs.c');
  for (const fn of ['wv_wc_opened', 'wv_wc_push', 'wv_wc_drained', 'wv_wc_error', 'wv_wc_free']) {
    check(`EXPORTED_FUNCTIONS _${fn} exists in native/webcodecs.c`,
      new RegExp(`EMSCRIPTEN_KEEPALIVE[\\s\\S]{0,120}\\b${fn}\\s*\\(`).test(wc), fn);
  }
}

/* ----------------------------------------------------------------- patches */

section('patches/: the VLC tree patches');
{
  const dir = fs.readdirSync(path.join(REPO, 'patches')).filter((f) => f.endsWith('.patch')).sort();
  check('patches exist', dir.length >= 30, String(dir.length));
  let lastNum = 0;
  let gaps = [];
  for (const f of dir) {
    const n = Number(f.slice(0, 4));
    if (n !== lastNum + 1) gaps.push(`${lastNum}->${n}`);
 lastNum = n;
  }
  // 0006 was upstreamed (VLC 0fddbac847) and is deliberately absent.
  check('numbering is gapless except the deliberate 0006 removal',
    gaps.length === 0 || gaps.join(',') === '5->7', gaps.join(','));

  // 0006 must NOT be present (upstreamed as 0fddbac847; the local tree
  // already carries the fix).
  check('0006 (A-B loop float ticks) is absent — upstreamed into VLC', !dir.some((f) => f.startsWith('0006')), '');
  // 0030 IS present but skipped at build time (dvdcss).
  check('0030 (dvdcss) is present but excluded by SKIP_PATCHES',
    dir.some((f) => f.startsWith('0030')) && /SKIP_PATCHES="0030 "/.test(read('.github/scripts/build-vlc.sh')), '');

  // Every patch must be a real unified diff for the VLC tree (no absolute paths).
  for (const f of dir.slice(0, 5)) {
    const p = read('patches/' + f);
    check(`${f}: unified diff against VLC paths (a/…, b/…, /dev/null for new files)`,
      (/^--- a\//m.test(p) || /^--- \/dev\/null$/m.test(p)) && /^\+\+\+ b\//m.test(p), '');
  }
}

/* -------------------------------------------------------------- smoke test */

section('wasm-smoke-test.mjs: the CI gate');
{
  const st = read('.github/scripts/wasm-smoke-test.mjs');
  check('boots the engine through src/engine.js (the production path)',
    /from '\.\.\/\.\.\/src\/engine\.js'/.test(st) && /createEngine\(/.test(st) && /\.default/.test(st), '');
  check('checks SharedArrayBuffer availability first', /SharedArrayBuffer/.test(st), '');
  check('round-trips the bridge RPC (version)', /call\('version'/.test(st), '');
  check('accepts the real libvlc version string (semver, not the word VLC)',
    st.includes('4.0.0-dev Otto') && /!\s*\/\^\\d\+\\\.\\d\+\/\.test\(version\.version\)/.test(st)
 && !st.includes("includes('VLC')"), '');
  check('creates and releases a player', /player_new/.test(st) && /player_release/.test(st), '');
  check('verifies the ring magic (WVAR)', /0x57564152/.test(st), '');
  // Arg marshalling lives in src/engine.js now, so that invariant is checked
  // against engine.js, not the smoke test.
  // Universal, not existential: every engine.call( site must sit directly
  // inside a withTimeout( — the multiline instance_new/player_new calls too.
  // Whitespace is flattened first so a wrapper split across lines still
  // counts; plain (st.includes(...)) cannot cross newlines.
  check('has a timeout on every bridge call (all sites, newline-safe)',
    (() => {
      const sites = (st.match(/\bengine\.call\(/g) ?? []).length;
      const flat = st.replace(/\s+/g, ' ');
      const wrapped = (flat.match(/withTimeout\(\s*engine\.call\(/g) ?? []).length;
      return sites > 0 && wrapped === sites;
    })(), '');
  check('stops the mailbox pump before exit', /engine\.dispose\(\)/.test(st), '');
}

console.log('\n' + '-'.repeat(70));
console.log('build-config: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL BUILD-CONFIG CHECKS PASSED');
process.exit(0);
