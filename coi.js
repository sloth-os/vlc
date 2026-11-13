// Cross-origin isolation for hosts that cannot set response headers
// (GitHub Pages). The wasm VLC engine needs SharedArrayBuffer, which needs
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp
//
// The SERVICE WORKER half of this lives in sw.js: it re-serves every
// same-origin response with those headers. This file is the PAGE half: load it
// first with <script src="coi.js"></script> — it registers sw.js and, if the
// page was not controlled yet (first visit, or after a SW update), reloads
// once. Only one reload ever happens per session, so an isolation failure
// (e.g. an extension stripping headers) cannot loop.
//
// A worker whose install FAILED (redundant state) is also recovered from: a
// stale-but-working worker of ours is still on disk from an earlier visit,
// so the browser falls back to it and controls the page — the same one
// marked reload then picks it up.
//
// Derived from lucasgelfond/libvlc-wasm's coi-serviceworker.js (MIT), which is
// itself derived from gzuidhof/coi-serviceworker.
/* eslint-disable no-restricted-globals */
(function () {
  'use strict';
  if (typeof window === 'undefined') return; // not a page (worker/node)
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return; // http:, file:, old browser
  if (window.crossOriginIsolated) {
    try { sessionStorage.removeItem('vlc-web-coi-reloaded'); } catch { /* storage blocked */ }
    return;
  }
  var KEY = 'vlc-web-coi-reloaded';
  navigator.serviceWorker.register('./sw.js').then(function (reg) {
    var reload = function () {
      // Only once: if isolation still fails, do not loop.
      var already;
      try { already = sessionStorage.getItem(KEY); } catch { already = null; }
      if (already) {
        console.warn('vlc-web: page is still not cross-origin isolated; the player will not start.');
        return;
      }
      try { sessionStorage.setItem(KEY, '1'); } catch { /* storage blocked */ }
      location.reload();
    };
    if (reg.active && !navigator.serviceWorker.controller) reload();
    else {
      var onState = function (e) {
        // 'activated' — the normal path. 'redundant' — the install failed
        // (a bad network moment): the browser keeps the previous worker in
        // control, which still serves the COI headers this page needs, so a
        // single reload gets it.
        if (e.target.state === 'activated' || e.target.state === 'redundant') reload();
      };
      var track = function (worker) {
        worker && worker.addEventListener('statechange', onState);
      };
      reg.addEventListener('updatefound', function () { track(reg.installing); });
      // An install may already be in flight when register() resolves (e.g.
      // the browser began a retry install during this page's load, after a
      // previous attempt failed): its updatefound has already fired, so
      // track that worker directly instead of waiting for the next one.
      track(reg.installing);
    }
  }).catch(function (e) {
    console.warn('vlc-web: could not register the service worker', e);
  });
})();
