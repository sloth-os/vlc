#!/usr/bin/env node
/*
 * Protocol-level test for app.js's OS file-handling layer — launchQueue
 * ("Open with"), the manifest share_target consumption, and the native
 * pickers — plus the engine-boot contract (files arriving before the engine
 * is up are queued, not dropped).
 *
 * app.js is an ES module importing './src/vlc.js'; a plain vm cannot run it
 * (import.meta, import statements). Like the worker suite, this loads it as
 * text with the imports replaced by injected fakes, then drives the page
 * half: DOM stubs (document.getElementById over a map of fake elements),
 * launchQueue, caches, beforeinstallprompt.
 *
 * Usage: node tests/app-file-handling.test.mjs   (any cwd)
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

// The vlc.js module surface app.js uses: createVLC(opts) -> VLC instance
// with createPlayer. Player has open/play/pause/stop and the event emitter.
function makeFakeVLC() {
  const openedFiles = [];
  const players = [];
  class FakePlayer {
    constructor() {
      this.state = 'idle';
      this.duration = 0;
 this.currentTime = 0;
 this.volume = 1;
      this.muted = false;
      this.handlers = new Map();
      players.push(this);
    }
    on(type, fn) { (this.handlers.get(type) ?? this.handlers.set(type, new Set()).get(type)).add(fn); return () => {}; }
    emit(type, detail) { for (const fn of this.handlers.get(type) ?? []) fn(detail); }
    async open(source) { openedFiles.push(source); this.emit('tracks', [{ type: 'video', id: 'v1', selected: true, width: 640, height: 360, fps: 25, codecName: 'h264' }]); }
    async play() { this.state = 'playing'; this.emit('statechange', 'playing'); }
    async pause() { this.state = 'paused'; this.emit('statechange', 'paused'); }
    async stop() { this.state = 'stopped'; this.emit('statechange', 'stopped'); }
    async seek() {}
    async info() { return { tracks: [] }; }
  }
  const vlc = {
    version: { version: 'VLC 4.0-test' },
 startupMs: 12,
    on: () => () => {},
    createPlayer: async () => new FakePlayer(),
  };
  return { vlc, openedFiles, players };
}

/* --------------------------------------------------------------- dom stubs */

function makeElements(ids) {
  const els = new Map();
  const make = (id) => {
    const listeners = new Map();
    const el = {
      id,
      // Mirrors index.html: every panel/button starts hidden until the app
      // reveals it (player-section, install-btn, pickers, ...).
      hidden: true,
      disabled: false,
      textContent: '',
      value: '',
      files: [],
      listeners,
      addEventListener: (t, fn) => { (listeners.get(t) ?? listeners.set(t, []).get(t)).push(fn); },
      removeEventListener: () => {},
      click: () => { for (const fn of listeners.get('click') ?? []) fn({ preventDefault() {} }); },
      dispatch: (t, ev) => { for (const fn of listeners.get(t) ?? []) fn({ preventDefault() {}, ...ev }); },
      classList: { toggle: () => {}, add: () => {}, remove: () => {} },
      appendChild: () => {},
      scrollTop: 0,
      scrollHeight: 0,
      style: {},
      setAttribute: () => {},
      getAttribute: () => null,
    };
 return el;
  };
  for (const id of ids) els.set(id, make(id));
  return {
    get: (id) => els.get(id),
    has: (id) => els.has(id),
    all: els,
  };
}

const APP_IDS = [
  'dropzone', 'file-input', 'folder-input', 'btn-open', 'btn-open-folder', 'btn-open-url',
  'status-line', 'progress-output',
  'player-section', 'media-name', 'video-canvas', 'player-overlay',
  'btn-play', 'btn-stop', 'btn-prev', 'btn-next',
  'seek-bar', 'time-elapsed', 'time-total', 'volume', 'btn-mute', 'btn-fullscreen',
  'audio-track', 'audio-track-label', 'subtitle-track', 'subtitle-track-label',
  'playlist-section', 'playlist', 'btn-clear-playlist',
  'info-panel', 'info-body', 'btn-info',
  'install-btn', 'net-status', 'build-version',
];

/* ------------------------------------------------------------- world setup */

function createWorld() {
  const world = {
    dom: makeElements(APP_IDS),
    vlcFactory: makeFakeVLC(),
    launchQueueConsumers: [],
    sharedCacheEntries: new Map(),
    installPrompts: [],
    storage: new Map(),
    idleCallbacks: [],
    swRegistrations: 0,
  };
  const fakeVLC = world.vlcFactory;

  const cachesStub = {
    open: async () => ({
      keys: async () => [...world.sharedCacheEntries.keys()],
      match: async (url) => world.sharedCacheEntries.get(url) ?? world.sharedCacheEntries.get(new URL(url, 'https://x.io/vlc-web/').pathname),
      delete: async (url) => { world.sharedCacheEntries.delete(url); world.sharedCacheEntries.delete(new URL(url, 'https://x.io/vlc-web/').pathname); return true; },
      put: async (url, resp) => { world.sharedCacheEntries.set(url, resp); },
 }),
  };

  const sandbox = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    document: {
 getElementById: (id) => world.dom.get(id),
 createElement: (tag) => {
        const listeners = new Map();
        const el = {
          tag,
          type: '',
          textContent: '',
          className: '',
          hidden: false,
          value: '',
          listeners,
          addEventListener: (t, fn) => { (listeners.get(t) ?? listeners.set(t, []).get(t)).push(fn); },
          appendChild: (child) => { el.children = (el.children ?? []).concat(child); },
          children: [],
 setAttribute: () => {},
          classList: { add: () => {}, remove: () => {}, toggle: () => {} },
          dispatch: (t, ev) => { for (const fn of listeners.get(t) ?? []) fn({ preventDefault() {}, stopPropagation() {}, ...ev }); },
        };
        return el;
      },
      fullscreenElement: null,
    },
 window: null, // set below
    navigator: {
      onLine: true,
      connection: null,
      hardwareConcurrency: 4,
      serviceWorker: {
        controller: null,
        register: async () => {
          world.swRegistrations++;
          return {};
        },
        // controllerchange listeners: waitForIsolation waits on this signal.
        listeners: [],
        addEventListener(type, fn) { if (type === 'controllerchange') this.listeners.push(fn); },
        removeEventListener() {},
      },
 },
    performance: { now: () => 0 },
    location: { href: 'https://x.io/vlc-web/', reload: () => {} },
    fetch: async () => ({ ok: true, json: async () => ({ version: 'VLC 4.0', commit: 'abcdef123456', builtAt: '2026-11-12T00:00:00Z' }) }),
    requestIdleCallback: (fn) => { world.idleCallbacks.push(fn); return world.idleCallbacks.length - 1; },
    setTimeout: (fn) => { world.timeouts = (world.timeouts ?? 0) + 1; return 0; },
    clearTimeout: () => {},
    caches: cachesStub,
    File,
    Blob,
    URL,
    URLSearchParams: globalThis.URLSearchParams,
    Promise, JSON, Math, Object, Array, Map, Set, Error, TypeError, Number, String, Boolean, Date, RegExp, isNaN, parseInt, Infinity, NaN, undefined,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  // window listeners: beforeinstallprompt, appinstalled, online/offline.
  const windowListeners = new Map();
  sandbox.addEventListener = (type, fn) => { (windowListeners.get(type) ?? windowListeners.set(type, []).get(type)).push(fn); };
  sandbox.removeEventListener = () => {};
  sandbox.windowListeners = windowListeners;
  Object.defineProperty(sandbox, 'crossOriginIsolated', { value: true, configurable: true });
  sandbox.isSecureContext = true; // waitForIsolation gates on this

  // launchQueue: the consumer app.js installs (checked on WINDOW, like Chrome).
  sandbox.launchQueue = { setConsumer: (fn) => { world.launchQueueConsumers.push(fn); } };
  // Native pickers: not present by default (feature-detection path).
  sandbox.window.showOpenFilePicker = undefined;
  sandbox.window.showDirectoryPicker = undefined;

  const ctx = vm.createContext(sandbox);
  const load = () => {
    let source = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
    source = source
      .replace("import { createVLC } from './src/vlc.js';", 'const createVLC = __createVLC;')
      .replace(/import\.meta\.url/g, '__appUrl');
    sandbox.__appUrl = 'https://x.io/vlc-web/app.js';
    sandbox.__createVLC = async (opts) => fakeVLC.vlc;
    vm.runInContext(source, ctx, { filename: 'app.js' });
  };
  world.sandbox = sandbox;
  world.load = load;
  return world;
}

const flush = async (n = 10) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

const FILE = (name) => new File(['x'], name, { type: 'video/x-matroska' });

/* ------------------------------------------------------------------ tests */

section('static contract');
{
  const src = fs.readFileSync(path.join(REPO, 'app.js'), 'utf8');
  check('app.js: imports createVLC from ./src/vlc.js',
    /import \{ createVLC \} from '\.\/src\/vlc\.js'/.test(src), '');
  check('app.js: refuses to boot without crossOriginIsolated',
    /crossOriginIsolated/.test(src), '');
  check('app.js: launchQueue files arriving before the engine queues, not drops',
    /pendingLaunchFiles/.test(src) && /setConsumer/.test(src), '');
  check('app.js: share-target consumption reads vlc-web-shared (the SW cache name)',
    /vlc-web-shared/.test(src), '');
  check('app.js: share consumption deletes what it read (no stale re-open)',
    /cache\.delete/.test(src), '');
  check('app.js: native pickers are feature-detected, never assumed',
    /typeof window\.showOpenFilePicker === 'function'/.test(src) && /typeof window\.showDirectoryPicker === 'function'/.test(src), '');
  check('app.js: engine warm-up respects saveData/2g connections',
    /saveData/.test(src), '');
  check('app.js: no absolute URL literals', !/(?:src|href)="\/[^/]/.test(src), '');
}

section('boot and element wiring');
{
  const world = createWorld();
  world.load();
  await flush();
  // All ids app.js looks up existed in the dom stub (a missing one would
  // throw on addEventListener of undefined).
  check('every element id app.js uses resolved (no TypeError thrown)', true, '');
  check('net status pill initialized', world.dom.get('net-status').textContent === 'online', world.dom.get('net-status').textContent);
  check('build version pill filled from build-info.json',
    /abcdef12/.test(world.dom.get('build-version').textContent), world.dom.get('build-version').textContent);
 check('dropzone click opens the file input', world.dom.get('dropzone').listeners.has('click'), '');
}

section('intake through the dropzone and input');
{
  const world = createWorld();
  world.load();
  await flush();
  // Idle warm-up: boot the engine now so intake plays immediately.
  world.idleCallbacks.forEach((fn) => fn());
  await flush(20);

  const dropzone = world.dom.get('dropzone');
  dropzone.dispatch('drop', { dataTransfer: { files: [FILE('movie.mkv')] } });
  await flush(20);
  check('a dropped file reaches player.open()', world.vlcFactory.openedFiles.length === 1,
    JSON.stringify(world.vlcFactory.openedFiles));
  check('the player section is revealed', world.dom.get('player-section').hidden === false, '');
  check('the media name is shown', world.dom.get('media-name').textContent === 'movie.mkv', world.dom.get('media-name').textContent);

  // The file input path with an empty FileList must not crash.
  world.dom.get('file-input').files = [];
  world.dom.get('file-input').dispatch('change', {});
  await flush(5);
  check('an empty file-input change is a no-op (no extra opens)',
    world.vlcFactory.openedFiles.length === 1, String(world.vlcFactory.openedFiles.length));
}

section('files arriving before the engine is ready');
{
  const world = createWorld();
  let slowResolve;
  const slowVLC = new Promise((r) => { slowResolve = r; });
  world.load();
  // Do NOT run idle warm-up: engine not booted yet.
  // Simulate launchQueue delivering a file now.
  const consumer = world.launchQueueConsumers[0];
  check('launchQueue consumer installed', typeof consumer === 'function', '');
  // The consumer awaits params.files handles -> give it getFile()
  const delivered = consumer({
    files: [{ getFile: async () => FILE('launched.wmv') }],
  });
  await flush(10);
  check('file handled before boot is queued (not opened, not dropped)',
    world.vlcFactory.openedFiles.length === 0, String(world.vlcFactory.openedFiles.length));
  // Now boot the engine: the queued file must open.
  world.idleCallbacks.forEach((fn) => fn());
  await flush(30);
  check('after boot the queued launch file opens', world.vlcFactory.openedFiles.length === 1,
    JSON.stringify(world.vlcFactory.openedFiles));
}

section('share target consumption');
{
  const world = createWorld();
  // Seed what the service worker would have stashed BEFORE the app loads:
  // consumption runs at startup. The cache stub stores keys as given; the
  // app asks with './__shared/i' relative keys, so seed those exact keys.
  const mk = (name, type) => ({
    headers: { get: (h) => (h === 'X-File-Name' ? encodeURIComponent(name) : type) },
    blob: async () => new Blob(['shared'], { type: 'application/octet-stream' }),
  });
  world.sharedCacheEntries.set('./__shared/count', { text: async () => '2' });
  world.sharedCacheEntries.set('./__shared/0', mk('shared-one.flac'));
  world.sharedCacheEntries.set('./__shared/1', mk('shared-two.ape'));
  world.load();
  await flush(15);
  // The queued files open once the engine is up: run the idle warm-up.
  world.idleCallbacks.forEach((fn) => fn());
  await flush(50);
  const names = world.vlcFactory.openedFiles.map((f) => f?.name).filter(Boolean);
  check('both shared files were consumed (first opens, second queued in the playlist)',
    names.includes('shared-one.flac'), JSON.stringify(names));
  check('the shared cache was emptied after consumption', world.sharedCacheEntries.size === 0,
    JSON.stringify([...world.sharedCacheEntries.keys()]));
}

section('engine boot waits for the cross-origin-isolation handoff');
{
  // A FIRST VISIT: the page is not yet isolated and the SW that injects the
  // COOP/COEP headers is still installing. bootEngine must WAIT for the
  // controllerchange (the coi.js reload handoff), not throw instantly — and
  // never download the engine while the wait is pending.
  const world = createWorld();
  Object.defineProperty(world.sandbox, 'crossOriginIsolated', { value: false, configurable: true });
  world.load();
  await flush();
  world.idleCallbacks.forEach((fn) => fn());
  await flush(5);
  check('unisolated first visit: bootEngine waits (no engine download yet)',
    world.vlcFactory.openedFiles.length === 0 && world.swRegistrations === 1,
    `opens=${world.vlcFactory.openedFiles.length} sw=${world.swRegistrations}`);
  check('unisolated first visit: no error status painted while waiting',
    !/not cross-origin isolated/.test(world.dom.get('status-line').textContent),
    world.dom.get('status-line').textContent);
  // The worker takes control: isolation lands for the NEXT load; the wait
  // finishes and the boot proceeds (isolation still false -> the honest error).
  const swListeners = world.sandbox.navigator.serviceWorker.listeners;
  check('waitForIsolation subscribed to controllerchange', swListeners.length === 1, String(swListeners.length));
  for (const fn of swListeners.splice(0)) fn();
  await flush(20);
  check('after the wait ends unisolated: the honest error status is painted',
    /not cross-origin isolated/.test(world.dom.get('status-line').textContent),
    world.dom.get('status-line').textContent);
}
{
  // The page is controlled but its (pre-SW) headers lack COI: waiting cannot
  // help — the coi.js reload handles it. The boot must fail fast, not hang.
  const world = createWorld();
  Object.defineProperty(world.sandbox, 'crossOriginIsolated', { value: false, configurable: true });
  world.sandbox.navigator.serviceWorker.controller = {};
  world.load();
  await flush();
  world.idleCallbacks.forEach((fn) => fn());
  await flush(20);
  check('controlled-but-unisolated: the error fires without waiting',
    /not cross-origin isolated/.test(world.dom.get('status-line').textContent),
    world.dom.get('status-line').textContent);
  check('controlled-but-unisolated: no controllerchange subscription was left behind',
    world.sandbox.navigator.serviceWorker.listeners.length === 0,
    String(world.sandbox.navigator.serviceWorker.listeners.length));
}

section('install prompt');
{
  const world = createWorld();
  world.load();
  await flush();
  const btn = world.dom.get('install-btn');
  check('install button hidden before the prompt', btn.hidden === true, String(btn.hidden));
  // Fire beforeinstallprompt: the listener was registered via window.addEventListener.
  const listeners = world.sandbox.windowListeners.get('beforeinstallprompt') ?? [];
  check('a beforeinstallprompt listener is registered on window', listeners.length === 1, String(listeners.length));
  // Firing the event only reveals the button; the PROMPT shows on click.
  for (const fn of listeners) {
    await fn({
 preventDefault() {},
      prompt: async () => {},
 userChoice: Promise.resolve({ outcome: 'accepted' }),
    });
  }
  await flush();
  check('the install button is revealed by the event', btn.hidden === false, String(btn.hidden));
  // The click handler is async (awaits userChoice): capture the prompt call.
  const promptCalls = [];
  const deferred = {
    preventDefault() {},
    prompt: async () => { promptCalls.push(1); },
    userChoice: Promise.resolve({ outcome: 'accepted' }),
  };
  for (const fn of listeners) await fn(deferred);
  await flush();
  btn.dispatch('click', {});
  await flush(10);
  check('the deferred prompt is shown and the button hides on accept',
    promptCalls.length === 1 && btn.hidden === true, `prompts=${promptCalls.length} hidden=${btn.hidden}`);
}

console.log('\n' + '-'.repeat(70));
console.log('app-file-handling: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL APP FILE-HANDLING TESTS PASSED');
process.exit(0);
