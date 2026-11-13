#!/usr/bin/env node
/*
 * Mock-harness test for coi.js — the page half of cross-origin isolation.
 *
 * Runs coi.js in a vm with stubbed window/navigator/sessionStorage and checks:
 *   - does nothing in a worker/Node context (no window)
 *   - does nothing on non-secure origins (http:) or old browsers (no SW API)
 *   - reloads exactly once when the SW takes control of an uncontrolled page
 *   - never reloads twice in one session (isolation still failing: no loop)
 *   - does not reload when the page is already cross-origin isolated
 *   - clears the reload marker when already isolated
 *   - registers './sw.js' relative to the page, never an absolute path
 *   - a registration rejection is a warning, not an unhandled rejection
 *
 * Usage: node tests/coi-test.mjs   (any cwd)
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = fs.readFileSync(path.join(REPO, 'coi.js'), 'utf8');

let pass = 0;
let fail = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS  ' + name); }
  else { fail++; failures.push(name + (extra ? ' -- ' + extra : '')); console.log('FAIL  ' + name + (extra ? ' -- ' + extra : '')); }
}
function section(t) { console.log('\n== ' + t + ' =='); }

function createWorld({
  hasWindow = true, secure = true, hasServiceWorker = true, isolated = false,
  storageWorks = true, registerError = null,
  // activeOnly: reg.active exists but navigator.serviceWorker.controller does
  // not — the first-visit case (the worker ran before this page loaded).
  activeAndControlled = false, activeOnly = false,
  // installingInFlight: reg.installing is already set when register() resolves
  // (a retry install that began during page load, its updatefound long gone).
  installingInFlight = false,
} = {}) {
  const world = {
    reloads: 0,
    registrations: [],
    warnings: [],
    storage: new Map(),
    log: [],
  };
  if (!hasWindow) {
    return { world, load: () => vm.runInContext(SOURCE, vm.createContext({ console, location: { href: 'https://x.io/app/' } }), { filename: 'coi.js' }) };
  }
  // A minimal serviceWorker registration object.
  const makeRegistration = () => {
    const reg = {
      active: (activeAndControlled || activeOnly) ? {} : null,
      listeners: {},
      addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
    };
    world.fireUpdateFound = (finalState = 'activated') => {
      const installing = {
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
        state: 'installing',
      };
      reg.installing = installing;
      (reg.listeners.updatefound ?? []).forEach((fn) => fn());
      // then it settles into the given state:
      installing.state = finalState;
      (installing.listeners.statechange ?? []).forEach((fn) => fn({ target: installing }));
    };
    if (installingInFlight) {
      const inFlight = {
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
        state: 'installing',
      };
      reg.installing = inFlight;
      world.fireInstallingState = (finalState) => {
        inFlight.state = finalState;
        (inFlight.listeners.statechange ?? []).forEach((fn) => fn({ target: inFlight }));
      };
    }
    return reg;
  };
  const sandbox = {
    console: {
      log: (...a) => world.log.push(a.join(' ')),
      warn: (...a) => world.warnings.push(a.join(' ')),
    },
    window: undefined, // set below
    isSecureContext: secure,
    crossOriginIsolated: isolated,
    location: { href: 'https://user.github.io/vlc-web/', reload: () => { world.reloads++; } },
 };
  if (hasServiceWorker) {
    sandbox.navigator = {
      serviceWorker: {
        controller: activeAndControlled ? {} : null,
        register: (url) => {
          world.registrations.push(url);
          if (registerError) return Promise.reject(registerError);
          return Promise.resolve(makeRegistration());
        },
      },
    };
  } else {
    sandbox.navigator = {};
  }
  sandbox.window = sandbox; // window === globalThis in the page
  sandbox.sessionStorage = {
    getItem: (k) => (world.storage.has(k) ? world.storage.get(k) : null),
    setItem: (k, v) => { if (!storageWorks) throw new Error('blocked'); world.storage.set(k, v); },
    removeItem: (k) => { world.storage.delete(k); },
  };
  sandbox.addEventListener = () => {};
  const ctx = vm.createContext(sandbox);
  return { world, load: () => vm.runInContext(SOURCE, ctx, { filename: 'coi.js' }), sandbox };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

section('static contract');
check('coi.js: registers ./sw.js with a RELATIVE url',
  /register\('\.\/sw\.js'\)/.test(SOURCE) && !/register\(['"]\/sw/.test(SOURCE), '');
check('coi.js: checks window.isSecureContext before registering',
  /window\.isSecureContext/.test(SOURCE), '');
check('coi.js: checks serviceWorker availability before registering',
  /'serviceWorker' in navigator/.test(SOURCE), '');
check('coi.js: bails when already crossOriginIsolated', /window\.crossOriginIsolated/.test(SOURCE), '');
check('coi.js: guards sessionStorage access (storage can be blocked)',
  /try\s*{[\s\S]*sessionStorage[\s\S]*}\s*catch/.test(SOURCE), '');

section('context guards');
{
  const { load } = createWorld({ hasWindow: false });
  let threw = null;
  try { load(); } catch (e) { threw = e; }
  check('no window (worker/node): runs without touching anything', threw === null, threw?.message);
}
{
  const w = createWorld({ secure: false });
  w.load();
  await flush();
  check('http: (non-secure): does not register the service worker', w.world.registrations.length === 0,
    JSON.stringify(w.world.registrations));
  check('http: (non-secure): no reload', w.world.reloads === 0, String(w.world.reloads));
}
{
  const w = createWorld({ hasServiceWorker: false });
  w.load();
  await flush();
  check('no serviceWorker API: no crash, no reload', w.world.reloads === 0, String(w.world.reloads));
}

section('already isolated');
{
  const w = createWorld({ isolated: true });
  w.world.storage.set('vlc-web-coi-reloaded', '1');
  w.load();
  await flush();
  check('isolated page: does not register (nothing to do)', w.world.registrations.length === 0,
    JSON.stringify(w.world.registrations));
  check('isolated page: clears the reload marker', !w.world.storage.has('vlc-web-coi-reloaded'), '');
  check('isolated page: no reload', w.world.reloads === 0, String(w.world.reloads));
}

section('first visit: register + reload once when the SW takes control');
{
  const w = createWorld({ activeOnly: true });
  w.load();
  await flush();
  check('uncontrolled page: registers ./sw.js', w.world.registrations[0] === './sw.js',
    JSON.stringify(w.world.registrations));
  check('uncontrolled page with an active worker: reloads once', w.world.reloads === 1,
    String(w.world.reloads));
  check('the reload is marked in sessionStorage', w.world.storage.get('vlc-web-coi-reloaded') === '1', '');
}

section('no reload loop');
{
  // The SW activated via updatefound but isolation STILL fails (e.g. an
  // extension strips headers): the marker stops the second reload.
  const w = createWorld({ activeAndControlled: false });
  w.world.storage.set('vlc-web-coi-reloaded', '1');
  w.load();
  await flush();
  check('marked session: never reloads again', w.world.reloads === 0, String(w.world.reloads));
}
{
  // updatefound -> statechange -> activated path also reloads, once.
  const w = createWorld({});
  w.load();
  await flush();
  check('fresh registration (no active worker yet): no immediate reload', w.world.reloads === 0,
    String(w.world.reloads));
  w.world.fireUpdateFound?.();
  await flush();
  check('updatefound -> activated: reloads once', w.world.reloads === 1, String(w.world.reloads));
}

section('install-failure recovery (redundant worker)');
{
  // A retry install that FAILS: the worker goes 'redundant', the previous
  // worker keeps controlling the page. coi.js must still reload once — the
  // stale worker serves the COI headers, so the reload gets isolation.
  const w = createWorld({});
  w.load();
  await flush();
  check('redundant preconditions: no reload yet', w.world.reloads === 0, String(w.world.reloads));
  w.world.fireUpdateFound?.('redundant');
  await flush();
  check('redundant install: reloads once (stale worker recovers the page)',
    w.world.reloads === 1, String(w.world.reloads));
  w.world.fireUpdateFound?.('redundant');
  await flush();
  check('redundant install: the marker still prevents a second reload',
    w.world.reloads === 1, String(w.world.reloads));
}
{
  // Same failure but the session is already marked: warn only, never loop.
  const w = createWorld({});
  w.world.storage.set('vlc-web-coi-reloaded', '1');
  w.load();
  await flush();
  w.world.fireUpdateFound?.('redundant');
  await flush();
  check('redundant install on a marked session: no second reload, a warning instead',
    w.world.reloads === 0 && w.world.warnings.some((m) => /not cross-origin isolated/.test(m)),
    JSON.stringify({ reloads: w.world.reloads, warnings: w.world.warnings }));
}

section('install already in flight when register() resolves');
{
  // The browser began a retry install DURING page load (after an earlier
  // failed attempt): updatefound has already fired by the time register()
  // resolves, so only reg.installing can be tracked. Missing that worker
  // would dead-end the session (no reload, no isolation).
  const w = createWorld({ installingInFlight: true });
  w.load();
  await flush();
  check('in-flight install: no reload before the worker settles', w.world.reloads === 0,
    String(w.world.reloads));
  w.world.fireInstallingState?.('activated');
  await flush();
  check('in-flight install: its activation still reloads once',
    w.world.reloads === 1, String(w.world.reloads));
}
{
  // The in-flight install FAILS instead: redundant must fire the same reload.
  const w = createWorld({ installingInFlight: true });
  w.load();
  await flush();
  w.world.fireInstallingState?.('redundant');
  await flush();
  check('in-flight install failing: redundant still reloads once',
    w.world.reloads === 1, String(w.world.reloads));
}

section('storage blocked / registration failure');
{
  const w = createWorld({ activeOnly: true, storageWorks: false });
  w.load();
  await flush();
  check('sessionStorage blocked: still reloads (the loop guard degrades to no-op)', w.world.reloads === 1,
    String(w.world.reloads));
}
{
  const w = createWorld({ registerError: new TypeError('unsupported') });
  let unhandled = null;
  process.on('unhandledRejection', (e) => { unhandled = e; });
  w.load();
  await flush();
  await flush();
  check('registration failure: warned, not unhandled', unhandled === null && w.world.warnings.length > 0,
    JSON.stringify(w.world.warnings));
  check('registration failure: no reload', w.world.reloads === 0, String(w.world.reloads));
}

console.log('\n' + '-'.repeat(70));
console.log('coi-test: ' + pass + ' passed, ' + fail + ' failed');
if (fail > 0) {
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
console.log('ALL COI TESTS PASSED');
process.exit(0);
