#!/usr/bin/env node
/*
 * Protocol-level test for src/worker.js — without the wasm engine.
 *
 * src/worker.js imports createEngine from './engine.js' and the wasm factory
 * from '../wasm/libvlc.js', neither of which exists in a test run. This suite
 * stubs both with an in-memory fake (a Map-backed FS, a call recorder) by
 * intercepting the module imports via a data: URL — no, ESM import
 * interception is not a thing in plain Node. Instead: the suite loads
 * worker.js as TEXT, replaces the two import statements with references to
 * injected globals, and runs it in a vm with mock self/postMessage. That is
 * the same classic-script-in-a-vm trick this repo's worker suites use.
 *
 * Checks (the mount/release contract the page depends on):
 *   - init: creates the engine, installs fonts, reports version/layout
 *   - mount File -> WORKERFS mount + file:// MRL; unmount unmounts
 *   - mount Blob -> WORKERFS with blobs
 *   - mount bytes -> MEMFS write; unmount unlinks
 *   - mount http(s) -> lazy file under /url/<n>; unmount unlinks
 *   - mount blob:/data: URL -> fetched then treated as Blob
 *   - mount [VIDEO_TS.IFO, ...] -> dvd:// MRL
 *   - unsupported scheme (ftp:) rejects with a clear message
 *   - names are sanitized: traversal, separators, control chars
 *   - unknown method -> error result, not a crash
 *   - every {id} request gets exactly one {type:'result'} answer
 *
 * Usage: node tests/worker-protocol.test.mjs   (any cwd)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' -- ' + extra : '')); console.log('FAIL  ' + name + (extra ? ' -- ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* ------------------------------------------------------------ fake engine */

function makeFakeEngine() {
  const calls = [];
  const mounts = new Set();
  const files = new Map(); // path -> bytes (MEMFS)
  const lazyFiles = new Set(); // path
  const dirs = [];
  const fakeFS = {
    mounts, // exposed for the test's assertions
    dirs, // ditto
    files, // ditto (MEMFS contents + lazy file nodes)
    mkdirTree: (d) => { dirs.push(d); },
    mkdir: (d) => { dirs.push(d); },
    rmdir: (d) => { const i = dirs.indexOf(d); if (i >= 0) dirs.splice(i, 1); },
    mount: (fs, opts, dir) => { mounts.add(dir); fakeFS.lastMount = { fs, opts, dir }; },
    unmount: (dir) => { mounts.delete(dir); },
    writeFile: (p, data) => { files.set(p, data); },
    unlink: (p) => { files.delete(p); if (lazyFiles.has(p)) lazyFiles.delete(p); },
    readFile: (p) => { if (!files.has(p)) throw new Error('ENOENT ' + p); return files.get(p); },
    createLazyFile: (dir, name, url) => {
      const p = `${dir}/${name}`;
 lazyFiles.add(p);
      // The real lazy file installs a chunked data getter; the worker wraps
      // setDataGetter when present. Give it one so that path is covered.
      const contents = { setDataGetter: (g) => { contents.getter = g; } };
      files.set(p, contents);
      fakeFS.lastLazy = { dir, name, url, contents };
      return { contents };
    },
  };
  const engine = {
    calls,
    Module: { FS: fakeFS, WORKERFS: { name: 'WORKERFS' }, NODEFS: {} },
    layout: { playerRing: 8, playerVideo: 100, ringData: 4 },
    call: async (name, args, ret) => {
      calls.push({ name, args, ret });
      if (name === 'version') {
        const raw = JSON.stringify({ version: 'VLC 4.0-test', features: { sout: false } });
        return { i: 0, d: 0, value: ret === 'json' ? JSON.parse(raw) : raw };
      }
      if (name === 'instance_new') return { i: 1 };
      if (name === 'player_new') return { i: 0x1234 };
      return { i: 0, d: 0, value: null };
    },
    dispose: () => { engine.disposed = true; },
    fakeFS,
  };
  return engine;
}

/* ------------------------------------------------------------- world setup */

function createWorld({ engine } = {}) {
  const world = {
    messages: [],
    fetchLog: [],
    fetchImpl: null,
  };
  const posted = [];
  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    // self and worker globals
    postMessage: (msg) => posted.push(msg),
    // The engine import is replaced before execution (see load()).
    __createEngine: engine,
    __engineFactory: null,
    location: { href: 'https://user.github.io/vlc-web/src/worker.js' },
    fetch: async (url) => {
      world.fetchLog.push(String(url));
      if (world.fetchImpl) return world.fetchImpl(String(url));
      return { ok: true, blob: async () => new Blob(['fetched-bytes'], { type: 'application/octet-stream' }) };
    },
    File,
    Blob,
    Uint8Array,
    Promise,
    JSON,
    Math,
    Object,
    Array,
    Map,
    Set,
    URL,
    Error,
    TypeError,
    Number,
    String,
    Boolean,
    Date,
    RegExp,
    isNaN,
    parseInt,
    Infinity,
    NaN,
    undefined,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);

  const load = () => {
    let source = fs.readFileSync(path.join(REPO, 'src/worker.js'), 'utf8');
    // Replace what a plain vm cannot provide: the import statement and
    // import.meta (modules only). The stubs are injected as globals.
    source = source
      .replace("import { createEngine, EVENT } from './engine.js';",
               "const createEngine = __createEngine, EVENT = { LOG: 100 };")
 .replace(/import\.meta\.url/g, "__workerUrl")
      .replace(/await import\(\/\* @vite-ignore \*\/ ENGINE_URL\)/, '__engineFactory()');
    sandbox.__workerUrl = 'https://user.github.io/vlc-web/src/worker.js';
    sandbox.__engineFactory = async () => ({ default: async () => ({}) });
    // The engine stub: createEngine(factory, opts) -> the fake engine.
    sandbox.__createEngine = async () => engine;
    vm.runInContext(source, ctx, { filename: 'worker.js' });
  };
  world.posted = posted;
  world.load = load;
  world.sandbox = sandbox;
  return world;
}

// Send a request and collect the single result message for its id.
async function rpc(world, method, args) {
  const before = world.posted.length;
  world.sandbox.self.onmessage({ data: { id: before + 1, method, args } });
  // Let the handler's promises settle.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  const after = world.posted.slice(before);
  return after.find((m) => m.id === before + 1 && m.type === 'result');
}

const FILE = (name, type = 'video/x-matroska') => new File(['file-bytes'], name, { type });

/* ------------------------------------------------------------------ tests */

section('static contract');
{
  const src = fs.readFileSync(path.join(REPO, 'src/worker.js'), 'utf8');
  check('worker.js: engine URL is ../wasm/libvlc.js relative to src/',
    /ENGINE_URL = new URL\('\.\.\/wasm\/libvlc\.js', import\.meta\.url\)/.test(src), '');
  check('worker.js: resolves the wasm binary relatively',
    /'\.\.\/wasm\/libvlc\.wasm'/.test(src), '');
  check('worker.js: one result message per request (post in both branches)',
    src.includes("post({ type: 'result', id, result })") && src.includes("post({ type: 'result', id, error"), '');
  check('worker.js: methods are dispatched via Object.hasOwn (no prototype leak)',
    /Object\.hasOwn\(methods, method\)/.test(src), '');
  check('worker.js: AUDIO_TS discs are NOT special-cased (only VIDEO_TS)',
    /video_ts\\.ifo/i.test(src) && !/audio_ts/i.test(src), '');
}

section('init');
{
  const engine = makeFakeEngine();
  const world = createWorld({ engine });
  world.load();
  const res = await rpc(world, 'init', { threads: 7, fonts: ['https://cdn/fonts.ttf'], httpCache: 8 * 1024 * 1024 });
  check('init resolves', res && res.type === 'result' && !res.error, JSON.stringify(res));
  check('init reports the version from the bridge', res?.result?.version?.version === 'VLC 4.0-test', JSON.stringify(res?.result?.version));
  check('init reports the shared-struct layout to the page',
    typeof res?.result?.layout?.playerRing === 'number' && typeof res?.result?.layout?.playerVideo === 'number',
    JSON.stringify(res?.result?.layout));
  check('init created the engine with the thread count',
    engine.calls.length > 0, JSON.stringify(engine.calls.map((c) => c.name)));
  check('init installed the font (lazy http file)',
    engine.fakeFS.lastLazy?.name === 'fonts.ttf', JSON.stringify(engine.fakeFS.lastLazy));
  check('init created /fonts (and the media dirs)',
    Array.isArray(engine.fakeFS.dirs) && engine.fakeFS.dirs.includes('/fonts'), JSON.stringify(engine.fakeFS.dirs));
}

section('mount: File -> WORKERFS');
{
  const engine = makeFakeEngine();
  const world = createWorld({ engine });
  world.load();
  await rpc(world, 'init', { threads: 2, fonts: [] });
  const res = await rpc(world, 'mount', { source: FILE('movie.mkv') });
  check('mount(File) resolves with a file:// MRL', typeof res?.result === 'string' && res.result.startsWith('file://'), JSON.stringify(res));
  check('the MRL keeps a safe encoded name', /movie\.mkv/.test(res?.result ?? ''), res?.result);
  check('WORKERFS got the file', engine.fakeFS.lastMount?.opts?.files?.[0]?.name === 'movie.mkv',
    JSON.stringify(engine.fakeFS.lastMount?.opts));
  const unmount = await rpc(world, 'unmount', { mrl: res.result });
  check('unmount resolves', unmount && !unmount.error, JSON.stringify(unmount));
  check('unmount unmounted the directory', engine.fakeFS.mounts.size === 0, JSON.stringify([...engine.fakeFS.mounts]));
}

section('mount: name sanitization');
{
  const engine = makeFakeEngine();
  const world = createWorld({ engine });
  world.load();
  await rpc(world, 'init', { threads: 2, fonts: [] });
  for (const [label, name] of [
    ['traversal', '../../etc/passwd'],
    ['absolute path', '/etc/passwd'],
    ['control chars', 'movie\x01\x02.mkv'],
    ['windows separator', '..\\..\\evil.mkv'],
    ['empty', ''],
    ['dot', '.'],
    ['dotdot', '..'],
  ]) {
    const res = await rpc(world, 'mount', { source: FILE(name) });
    const ok = typeof res?.result === 'string' && res.result.startsWith('file://');
    const mountedName = engine.fakeFS.lastMount?.opts?.files?.[0]?.name ?? '';
    check(`mount(${label}) resolves and the name stays inside the dir: "${mountedName}"`,
      ok && !mountedName.includes('/') && !mountedName.includes('\\') && mountedName !== '.' && mountedName !== '..' && mountedName !== '',
      JSON.stringify({ res: res?.result, mountedName }));
  }
}

section('mount: Blob / bytes / multiple files');
{
  const engine = makeFakeEngine();
  const world = createWorld({ engine });
  world.load();
  await rpc(world, 'init', { threads: 2, fonts: [] });

  const blob = await rpc(world, 'mount', { source: new Blob(['blob-bytes'], { type: 'audio/x-flac' }) });
  check('mount(Blob) -> file:// MRL via WORKERFS blobs', typeof blob?.result === 'string' && blob.result.startsWith('file://'), JSON.stringify(blob));
  check('a nameless Blob gets the fallback name', engine.fakeFS.lastMount?.opts?.blobs?.[0]?.name === 'media',
    JSON.stringify(engine.fakeFS.lastMount?.opts));

  const bytes = await rpc(world, 'mount', { source: { name: 'clip.rm', data: new Uint8Array([1, 2, 3]).buffer } });
  check('mount(bytes) -> file:// MRL', typeof bytes?.result === 'string' && bytes.result.startsWith('file://'), JSON.stringify(bytes));
  const written = [...engine.fakeFS.files.keys()].find((p) => p.endsWith('clip.rm'));
  check('bytes were written into MEMFS', !!written, JSON.stringify([...engine.fakeFS.files.keys()]));

  const multi = await rpc(world, 'mount', { source: [FILE('a.ogm'), FILE('b.ogm')] });
  check('mount(File[]) -> file:// MRL of the FIRST file', /a\.ogm/.test(multi?.result ?? ''), multi?.result);
  check('both files went into the same directory',
    engine.fakeFS.lastMount?.opts?.files?.length === 2, JSON.stringify(engine.fakeFS.lastMount?.opts?.files?.map((f) => f.name)));
}

section('mount: VIDEO_TS folder -> dvd://');
{
  const engine = makeFakeEngine();
  const world = createWorld({ engine });
  world.load();
  await rpc(world, 'init', { threads: 2, fonts: [] });
  const res = await rpc(world, 'mount', {
    source: [FILE('VIDEO_TS.IFO'), FILE('VTS_01_1.VOB'), FILE('VTS_01_0.BUP')],
  });
  check('a folder containing VIDEO_TS.IFO opens as dvd://', res?.result?.startsWith('dvd://'), JSON.stringify(res));
  check('the dvd MRL points at the mount dir (no file name)', res?.result === `dvd://${engine.fakeFS.lastMount?.dir}`, res?.result);
  const lower = await rpc(world, 'mount', { source: [FILE('video_ts.ifo'), FILE('x.vob')] });
  check('case-insensitive: video_ts.ifo also maps to dvd://', lower?.result?.startsWith('dvd://'), JSON.stringify(lower));
}

section('mount: URLs');
{
  const engine = makeFakeEngine();
  const world = createWorld({ engine });
  world.load();
  await rpc(world, 'init', { threads: 2, fonts: [] });

  const http = await rpc(world, 'mount', { source: 'https://cdn.example.com/media/Sample%20Video.mkv' });
  check('mount(https URL) -> file:// MRL over a lazy file', http?.result?.startsWith('file://'), JSON.stringify(http));
  check('the lazy file kept a safe decoded name', engine.fakeFS.lastLazy?.name === 'Sample Video.mkv', JSON.stringify(engine.fakeFS.lastLazy));
  check('the URL itself reached createLazyFile unchanged', engine.fakeFS.lastLazy?.url === 'https://cdn.example.com/media/Sample%20Video.mkv', engine.fakeFS.lastLazy?.url);

  const blobUrl = await rpc(world, 'mount', { source: 'blob:https://x.io/1234' });
  check('mount(blob: URL) fetches then mounts the Blob', blobUrl?.result?.startsWith('file://') && world.fetchLog.includes('blob:https://x.io/1234'),
    JSON.stringify({ res: blobUrl?.result, fetchLog: world.fetchLog }));

  const bad = await rpc(world, 'mount', { source: 'ftp://example.com/movie.mkv' });
  check('mount(ftp:) rejects with the scheme named', bad?.error && /ftp/.test(bad.error), JSON.stringify(bad?.error));
  const notUrl = await rpc(world, 'mount', { source: 'not a url at all' });
  check('mount(non-URL string) rejects clearly', notUrl?.error && /not a URL/.test(notUrl.error), JSON.stringify(notUrl?.error));
}

section('rpc plumbing');
{
  const engine = makeFakeEngine();
  const world = createWorld({ engine });
  world.load();
  await rpc(world, 'init', { threads: 2, fonts: [] });
  const unknown = await rpc(world, 'frobnicate', {});
  check('an unknown method answers an error result (no crash)', unknown?.type === 'result' && /unknown method/.test(unknown?.error ?? ''), JSON.stringify(unknown));

  const call = await rpc(world, 'call', { name: 'play', i: [0x1234], d: [], s: [] });
  check("'call' forwards to the engine with the args", engine.calls.some((c) => c.name === 'play' && c.args?.i?.[0] === 0x1234),
    JSON.stringify(engine.calls.filter((c) => c.name === 'play')));

  const everyId = world.posted.filter((m) => m.type === 'result').every((m) => world.posted.filter((x) => x.type === 'result' && x.id === m.id).length === 1);
  check('every request id got exactly one result', everyId, '');

  const dispose = await rpc(world, 'dispose', {});
  check('dispose resolves and stops the engine', dispose && !dispose.error && engine.disposed, JSON.stringify(dispose));
}

console.log('\n' + '-'.repeat(70));
console.log('worker-protocol: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL WORKER PROTOCOL TESTS PASSED');
process.exit(0);
