// Cross-origin isolation for hosts that cannot set response headers
// (GitHub Pages). The wasm VLC engine needs SharedArrayBuffer, which needs
//   Cross-Origin-Opener-Policy: same-origin
//   Cross-Origin-Embedder-Policy: require-corp (or credentialless)
//
// The SERVICE WORKER half of this lives in sw.js: it re-serves every
// same-origin response with those headers. This file is the PAGE half: load it
// first with <script src="coi.js"></script> — it registers sw.js and, if the
// page was not controlled yet (first visit, or after a SW update), reloads
// once. Only one reload ever happens per session, so an isolation failure
// (e.g. an extension stripping headers) cannot loop.
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
    else reg.addEventListener('updatefound', function () {
      reg.installing && reg.installing.addEventListener('statechange', function (e) {
        if (e.target.state === 'activated') reload();
      });
    });
  }).catch(function (e) {
    console.warn('vlc-web: could not register the service worker', e);
  });
})();
