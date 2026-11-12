/*
 * app.js — UI for the VLC WASM PWA (an ES module; index.html loads it after
 * coi.js).
 *
 * Owns: engine boot (with a progress readout for the ~25 MB wasm download),
 * file intake (#dropzone / #file-input / URL prompt), the player controls,
 * playlist, track selectors, media-info table, the log panel, the install
 * prompt, online/offline pill and build-version pill. OS-level file handling
 * is feature-detected: launchQueue files ("Open with"), share-target files
 * (Android share sheet) and the native open-file picker.
 *
 * Every URL is RELATIVE — the site must work from any subpath and offline.
 */
import { createVLC } from './src/vlc.js';

const MAX_LOG_LINES = 200;
const fmtTime = (s) => {
  if (!Number.isFinite(s) || s < 0) return '0:00';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = Math.floor(s % 60);
  return `${h ? `${h}:${String(m).padStart(2, '0')}` : m}:${String(x).padStart(2, '0')}`;
};

// ------------------------------------------------------------ state ---
let vlc = null;
let player = null;
let booting = null; // the createVLC() promise, retried on failure
let playlist = [];       // [{ name, file }]
let playlistIndex = -1;
let seekDragging = false;
const logLines = [];
let pendingLaunchFiles = []; // files that arrived before the engine was ready

// --------------------------------------------------------------- dom ---
const $ = (id) => document.getElementById(id);
const dom = {};
for (const id of [
  'dropzone', 'file-input', 'folder-input', 'btn-open', 'btn-open-folder', 'btn-open-url',
  'status-line', 'progress-output',
  'player-section', 'media-name', 'video-canvas', 'player-overlay',
  'btn-play', 'btn-stop', 'btn-prev', 'btn-next',
  'seek-bar', 'time-elapsed', 'time-total', 'volume', 'btn-mute', 'btn-fullscreen',
  'audio-track', 'audio-track-label', 'subtitle-track', 'subtitle-track-label',
  'playlist-section', 'playlist', 'btn-clear-playlist',
  'info-panel', 'info-body', 'btn-info',
  'install-btn', 'net-status', 'build-version',
]) dom[id] = $(id);

// ----------------------------------------------------------- helpers ---
function setStatus(text, isError) {
  dom['status-line'].textContent = text === null || text === undefined ? '' : String(text);
  dom['status-line'].classList.toggle('error', !!isError);
}

function log(line) {
  logLines.push(line);
  if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
  dom['progress-output'].textContent = logLines.join('\n') + '\n';
  dom['progress-output'].scrollTop = dom['progress-output'].scrollHeight;
}

function updateNetStatus() {
  dom['net-status'].classList.toggle('online', navigator.onLine);
  dom['net-status'].classList.toggle('offline', !navigator.onLine);
  dom['net-status'].textContent = navigator.onLine ? 'online' : 'offline';
}

async function loadBuildInfo() {
  try {
    const r = await fetch('./build-info.json');
    if (!r.ok) return;
    const info = await r.json();
    dom['build-version'].textContent =
      `${info.version} · ${String(info.commit || '').slice(0, 8)} · ${info.builtAt || ''}`;
  } catch { /* offline/no info: keep "local" */ }
}

// --------------------------------------------------------- engine boot ---
async function bootEngine() {
  if (vlc) return vlc;
  booting ??= (async () => {
    setStatus('Starting the VLC engine (downloading ~25 MB of WebAssembly)…');
    log(`engine: crossOriginIsolated=${window.crossOriginIsolated}`);
    if (!window.crossOriginIsolated) {
      throw new Error(
        'This page is not cross-origin isolated, so the engine (SharedArrayBuffer) cannot run. ' +
        'Reload once so the service worker can add the required headers — or serve with COOP/COEP.');
    }
    const t0 = performance.now();
    vlc = await createVLC({ logLevel: 'warn' });
    vlc.on('log', ({ level, message }) => log(`[${level}] ${message}`));
    log(`engine ready in ${((performance.now() - t0) / 1000).toFixed(1)} s (vlc ${vlc.version.version}, startup ${vlc.startupMs.toFixed(0)} ms)`);
    setStatus('');
    // Files that arrived while booting (launchQueue, share target).
    if (pendingLaunchFiles.length) {
      const files = pendingLaunchFiles;
      pendingLaunchFiles = [];
      await openFiles(files);
    }
    return vlc;
  })().catch((err) => {
    booting = null; // allow a retry (e.g. after going back online)
    setStatus(`The VLC engine failed to start: ${err.message}`, true);
    log(`engine error: ${err?.message ?? err}`);
    throw err;
  });
  return booting;
}

async function ensurePlayer() {
  await bootEngine();
  if (player) return player;
  player = await vlc.createPlayer({ canvas: dom['video-canvas'] });
  wirePlayerEvents(player);
  return player;
}

// ------------------------------------------------------------ playback ---
async function openFiles(files, { autoplay = true } = {}) {
  const list = [...files].filter((f) => f instanceof File || f instanceof Blob);
  if (!list.length) return;
  playlist = list.map((f) => ({ name: f.name || 'stream', file: f }));
  playlistIndex = 0;
  renderPlaylist();
  await playIndex(0, autoplay);
}

async function playIndex(index, autoplay = true) {
  if (index < 0 || index >= playlist.length) return;
  playlistIndex = index;
  renderPlaylist();
  const item = playlist[index];
  dom['player-section'].hidden = false;
  dom['media-name'].textContent = item.name;
  dom['player-overlay'].textContent = 'Opening…';
  setStatus(`Opening ${item.name}…`);
  try {
    await ensurePlayer();
    await player.open(item.file);
    if (autoplay) await player.play();
    setStatus('');
  } catch (err) {
    dom['player-overlay'].textContent = 'Could not play this file';
    setStatus(`VLC could not play ${item.name}: ${err.message}`, true);
    log(`play error: ${err?.message ?? err}`);
  }
}

async function playNext() {
  if (playlistIndex + 1 < playlist.length) await playIndex(playlistIndex + 1);
}

async function playPrev() {
  if (playlistIndex > 0) await playIndex(playlistIndex - 1);
}

function renderPlaylist() {
  const ol = dom['playlist'];
  ol.textContent = '';
  playlist.forEach((item, i) => {
    const li = document.createElement('li');
    li.textContent = `${i + 1}. ${item.name}`;
    if (i === playlistIndex) li.classList.add('playing');
    li.addEventListener('click', () => playIndex(i));
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'pl-remove';
    rm.setAttribute('aria-label', `Remove ${item.name} from the playlist`);
    rm.textContent = '✕';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      playlist.splice(i, 1);
      if (playlistIndex >= i && playlistIndex > 0) playlistIndex--;
      renderPlaylist();
      if (!playlist.length) dom['playlist-section'].hidden = true;
    });
    li.appendChild(rm);
    ol.appendChild(li);
  });
  dom['playlist-section'].hidden = playlist.length <= 1;
  dom['btn-prev'].disabled = playlistIndex <= 0;
  dom['btn-next'].disabled = playlistIndex + 1 >= playlist.length;
}

// ------------------------------------------------------- player events ---
function wirePlayerEvents(p) {
  const updateTime = () => {
    if (seekDragging) return;
    dom['time-elapsed'].textContent = fmtTime(p.currentTime);
    dom['time-total'].textContent = fmtTime(p.duration);
    if (p.duration > 0) dom['seek-bar'].value = String(p.currentTime / p.duration);
  };
  p.on('timeupdate', updateTime);
  p.on('durationchange', (d) => { dom['time-total'].textContent = fmtTime(d); });
  p.on('statechange', (state) => {
    dom['btn-play'].textContent = state === 'playing' ? '⏸' : '▶';
    dom['btn-play'].setAttribute('aria-label', state === 'playing' ? 'Pause' : 'Play');
    dom['player-overlay'].textContent =
      state === 'opening' || state === 'buffering' ? 'Opening…' : '';
    if (state === 'error') {
      dom['player-overlay'].textContent = 'Playback error';
    }
    updateTime();
  });
  p.on('buffering', (cache) => {
    dom['player-overlay'].textContent = cache < 1 ? `Buffering ${Math.round(cache * 100)}%` : '';
  });
  p.on('ended', () => playNext());
  p.on('tracks', (tracks) => { refreshTracks(tracks); renderInfo(tracks); });
  p.on('volumechange', ({ volume, muted }) => {
    dom['volume'].value = String(Math.min(1, volume));
    dom['btn-mute'].textContent = muted || volume === 0 ? '🔇' : '🔊';
  });
  p.on('chapters', () => {});
  p.on('error', (err) => {
    setStatus(`Playback error: ${err?.message ?? err}`, true);
    dom['player-overlay'].textContent = 'Playback error';
  });
}

// ------------------------------------------------------ track selectors ---
function refreshTracks(tracks) {
  const fill = (select, type, label, labelEl) => {
    const list = tracks.filter((t) => t.type === type);
    select.textContent = '';
    if (!list.length) {
      select.hidden = true;
      labelEl.hidden = true;
      return;
    }
    select.hidden = false;
    labelEl.hidden = false;
    const none = document.createElement('option');
    none.value = '';
    none.textContent = type === 'text' ? 'off' : '—';
    select.appendChild(none);
    for (const t of list) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name || t.language || t.id;
      if (t.selected) opt.selected = true;
      select.appendChild(opt);
    }
  };
  fill(dom['audio-track'], 'audio', 'audio', dom['audio-track-label']);
  fill(dom['subtitle-track'], 'text', 'text', dom['subtitle-track-label']);
}

async function renderInfo(tracks) {
  if (!tracks?.length) { dom['info-panel'].hidden = true; return; }
  const body = dom['info-body'];
  body.textContent = '';
  dom['info-panel'].hidden = false;
  for (const t of tracks) {
    const tr = document.createElement('tr');
    const cells = [
      t.type,
      `${t.codecName || t.codec || '?'}${t.selected ? ' ✓' : ''}`,
      t.language || '',
      t.type === 'video'
        ? `${t.width}×${t.height}${t.fps ? ` @ ${t.fps.toFixed(2)} fps` : ''}`
        : t.type === 'audio'
          ? `${t.channels} ch · ${(t.rate / 1000).toFixed(1)} kHz`
          : t.encoding || '',
    ];
    for (const [i, text] of cells.entries()) {
      const td = document.createElement('td');
      td.textContent = text;
      if (i === 0) td.className = `type-${t.type}`;
      tr.appendChild(td);
    }
    body.appendChild(tr);
  }
}

// ------------------------------------------------------------ controls ---
dom['btn-play'].addEventListener('click', async () => {
  try {
    if (!player) return;
    if (player.state === 'playing') await player.pause();
    else await player.play();
  } catch (err) { setStatus(err.message, true); }
});

dom['btn-stop'].addEventListener('click', async () => {
  if (!player) return;
  await player.stop().catch(() => {});
  dom['player-overlay'].textContent = 'Stopped';
});

dom['btn-next'].addEventListener('click', playNext);
dom['btn-prev'].addEventListener('click', playPrev);

dom['seek-bar'].addEventListener('input', () => {
  seekDragging = true;
  if (player?.duration > 0) {
    dom['time-elapsed'].textContent = fmtTime(+dom['seek-bar'].value * player.duration);
  }
});
dom['seek-bar'].addEventListener('change', async () => {
  seekDragging = false;
  try {
    if (player?.duration > 0) await player.seek(+dom['seek-bar'].value * player.duration);
  } catch { /* not seekable */ }
});

dom['volume'].addEventListener('input', () => { if (player) player.volume = +dom['volume'].value; });
dom['btn-mute'].addEventListener('click', () => { if (player) player.muted = !player.muted; });

dom['btn-fullscreen'].addEventListener('click', () => {
  const stage = dom['player-stage'];
  if (document.fullscreenElement) document.exitFullscreen();
  else stage.requestFullscreen?.().catch(() => {});
});

dom['audio-track'].addEventListener('change', async () => {
  const id = dom['audio-track'].value;
  try { await player?.[id ? 'selectTrack' : 'disableTrack'](id || 'audio'); } catch { /* gone */ }
});
dom['subtitle-track'].addEventListener('change', async () => {
  const id = dom['subtitle-track'].value;
  try { await player?.[id ? 'selectTrack' : 'disableTrack'](id || 'text'); } catch { /* gone */ }
});

dom['btn-info'].addEventListener('click', async () => {
  if (!player) return;
  const info = await player.info().catch(() => null);
  if (info?.tracks) renderInfo(info.tracks);
});

// ------------------------------------------------------------- intake ---
function intake(files) {
  if (!files?.length) return;
  // The engine boot is lazy: first file drops start it (and show progress).
  openFiles(files).catch(() => {});
}

dom['dropzone'].addEventListener('click', () => dom['file-input'].click());
dom['dropzone'].addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dom['file-input'].click(); }
});
dom['file-input'].addEventListener('change', () => {
  intake(dom['file-input'].files);
  dom['file-input'].value = '';
});

const zone = dom['dropzone'];
for (const type of ['dragenter', 'dragover']) {
  zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.add('dragover'); });
}
for (const type of ['dragleave', 'drop']) {
  zone.addEventListener(type, (e) => { e.preventDefault(); zone.classList.remove('dragover'); });
}
zone.addEventListener('drop', (e) => intake(e.dataTransfer?.files));

// Native pickers, where the browser has them (Chromium).
if (typeof window.showOpenFilePicker === 'function') {
  dom['btn-open'].hidden = false;
  dom['btn-open'].addEventListener('click', async () => {
    try {
      const handles = await window.showOpenFilePicker({ multiple: true });
      const files = await Promise.all(handles.map((h) => h.getFile()));
      intake(files);
    } catch (err) {
      if (err?.name !== 'AbortError') setStatus(`Open failed: ${err.message}`, true);
    }
  });
}
if (typeof window.showDirectoryPicker === 'function') {
  dom['btn-open-folder'].hidden = false;
  dom['btn-open-folder'].addEventListener('click', async () => {
    try {
      const dir = await window.showDirectoryPicker();
      const files = [];
      // A DVD folder (VIDEO_TS) opens as one item; else every file becomes
      // a playlist entry in directory order.
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file') {
          const f = await handle.getFile();
          // keep the directory in the name for relative lookups (sub/idx, cue/bin)
          f.rel = `${dir.name}/${name}`;
          files.push(f);
        }
      }
      const videoTs = files.filter((f) => /^video_ts\.ifo$/i.test(f.name));
      if (videoTs.length) {
        await ensurePlayer();
        dom['player-section'].hidden = false;
        dom['media-name'].textContent = dir.name;
        await player.open(files); // the worker detects VIDEO_TS and opens dvd://
        await player.play();
      } else {
        intake(files);
      }
    } catch (err) {
      if (err?.name !== 'AbortError') setStatus(`Open failed: ${err.message}`, true);
    }
  });
}

dom['btn-open-url'].addEventListener('click', async () => {
  const url = window.prompt('Open a media URL (http(s), needs CORS + range requests):');
  if (!url) return;
  try {
    await ensurePlayer();
    playlist = [{ name: url, file: url }];
    playlistIndex = 0;
    renderPlaylist();
    dom['player-section'].hidden = false;
    dom['media-name'].textContent = url;
    await player.open(url);
    await player.play();
  } catch (err) {
    setStatus(`Could not open the URL: ${err.message}`, true);
  }
});

dom['btn-clear-playlist'].addEventListener('click', () => {
  playlist = [];
  playlistIndex = -1;
  renderPlaylist();
  dom['playlist-section'].hidden = true;
});

// --------------------------------------------------- OS file handling ---
// "Open with" (desktop Chrome/Edge): file_handlers in the manifest registers
// this app for the media extensions; launched files arrive here.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(async (params) => {
    if (!params.files?.length) return;
    const files = await Promise.all(params.files.map((h) => h.getFile()));
    if (vlc) await openFiles(files);
    else pendingLaunchFiles = files;
  });
}

// Share sheet (Android Chrome): the service worker stashed the shared files
// in a fixed-name cache; consume them on load.
async function consumeSharedFiles() {
  try {
    if (!('caches' in window)) return;
    const cache = await caches.open('vlc-web-shared');
    const keys = await cache.keys();
    if (!keys.length) return;
    const countResp = await cache.match('./__shared/count');
    if (!countResp) return;
    const count = Number(await countResp.text());
    const files = [];
    for (let i = 0; i < count; i++) {
      const resp = await cache.match(`./__shared/${i}`);
      if (!resp) continue;
      const name = decodeURIComponent(resp.headers.get('X-File-Name') || `shared-${i}`);
      const blob = await resp.blob();
      files.push(new File([blob], name, { type: blob.type }));
    }
    await Promise.all(keys.map((k) => cache.delete(k)));
    if (files.length) {
      log(`share target: received ${files.length} file(s)`);
      if (vlc) await openFiles(files);
      else pendingLaunchFiles = files;
    }
  } catch (err) {
    log(`share target: ${err?.message ?? err}`);
  }
}

// ------------------------------------------------------------ install ---
let deferredInstallPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredInstallPrompt = e;
  dom['install-btn'].hidden = false;
});
dom['install-btn'].addEventListener('click', async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  if (outcome === 'accepted') dom['install-btn'].hidden = true;
  deferredInstallPrompt = null;
});

window.addEventListener('appinstalled', () => { dom['install-btn'].hidden = true; });

// ------------------------------------------------------------ startup ---
window.addEventListener('online', updateNetStatus);
window.addEventListener('offline', updateNetStatus);
updateNetStatus();
loadBuildInfo();
consumeSharedFiles();

// Preload the engine as soon as the network is idle, so the first file drop
// plays immediately. Skipped on saveData/2g and when the SW has not cached
// the wasm yet AND we are offline (pointless).
const conn = navigator.connection;
const slow = conn && (conn.saveData || /2g/.test(conn.effectiveType || ''));
if (!slow && (navigator.onLine || window.caches)) {
  const warm = () => bootEngine().catch(() => {});
  if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 });
  else setTimeout(warm, 2000);
}
