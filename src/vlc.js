// vlc-web: the page-side client of the wasm VLC engine.
//
//   const vlc = await createVLC();
//   const player = await vlc.createPlayer({ canvas });
//   await player.open(file);
//
// The wasm instance lives in a dedicated Worker (src/worker.js); this module
// is imported by the page. Frames and audio never pass through postMessage —
// the page reads them straight out of shared wasm memory (Renderer, the
// AudioWorklet).
//
// Derived from lucasgelfond/libvlc-wasm's packages/core/src/index.js + player.js
// (MIT), reduced to what this site uses (no sout/transcode, no element.js).
import { Emitter } from './emitter.js';
import { Player } from './player.js';
import { EVENT, LOG_LEVELS, checkOptions } from './engine.js';

export { Player };
/** VLC's player states by number, as `stats().state` reports them. */
export { STATE_NAMES } from './engine.js';

const LEVEL_NAMES = ['debug', 'debug', 'info', 'warn', 'error'];

/**
 * @typedef {object} VLCOptions
 * @property {number} [threads] pthreads started up front (VLC and FFmpeg
 *   start threads per stream; a pre-started pool keeps playback start from
 *   waiting on worker boots). Default 20.
 * @property {'debug'|'info'|'warn'|'error'|'off'} [logLevel] default 'warn'
 * @property {number} [decoderThreads] FFmpeg threads per decoder (default min(cores, 4))
 * @property {string[]} [args] extra libvlc_new() arguments, e.g. ['--deinterlace=1']
 */

/**
 * Loads the engine. Requires a cross-origin isolated page (SharedArrayBuffer):
 * the site's service worker (sw.js, merged with coi.js) provides that on
 * GitHub Pages, which cannot send COOP/COEP headers itself.
 * @param {VLCOptions} [opts]
 * @returns {Promise<VLC>}
 */
export async function createVLC(opts = {}) {
  if (!globalThis.crossOriginIsolated) {
    throw new Error(
      'vlc-web needs a cross-origin isolated page for SharedArrayBuffer. Serve it with\n' +
      '  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n' +
      '(the bundled coi.js service worker does this on static hosts).',
    );
  }
  const vlc = new VLC(opts);
  await vlc._start();
  return vlc;
}

export class VLC extends Emitter {
  /** @internal */
  constructor(opts) {
    super();
    this.opts = opts;
    this._players = new Map();
    this._pending = new Map();
    this._seq = 0;
    this._nextPlayer = 1;
    this._urls = {
      // The worker and the AudioWorklet module are served next to this file;
      // relative URLs so the site works from any subpath.
      worklet: new URL('./audio-worklet.js', import.meta.url).href,
    };
  }

  async _start() {
    const t0 = performance.now();
    // Classic worker: it importScripts()s the engine loader (an ES module
    // turned worker-compatible by the build) — see src/worker.js.
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'vlc' });
    this.worker.onmessage = (e) => this._onMessage(e.data);
    this.worker.onerror = (e) => this.emit('error', e);
    const threads = this.opts.threads ?? 20;
    const logLevel = LOG_LEVELS[this.opts.logLevel ?? 'warn'] ?? 3;
    const { version, layout, fonts: fontFiles, soundfont } = await this._rpc('init', {
      threads,
      fonts: [new URL('../fonts/NotoSans-Regular.ttf', import.meta.url).href],
      httpCache: this.opts.httpCache,
    });
    const { features, ...v } = version;
    this.version = v;
    /** What this build can do: `{ sout }` (transcoding — false here). */
    this.features = features ?? { sout: false };
    this._layout = layout;
    this._memory = await this._rpc('memory');
    this._instance = await this._rpc('instance', {
      args: checkOptions([
        '--no-video-title-show',
        // The player creates its audio output before our callbacks exist;
        // start it on the silent one so that first attempt does not log an error.
        '--aout=adummy',
        // FFmpeg frame threads each need a pthread from the pre-started pool.
        `--avcodec-threads=${this.opts.decoderThreads ?? Math.min(navigator.hardwareConcurrency || 4, 4)}`,
        ...(fontFiles.length ? [`--freetype-font=${fontFiles[0]}`, '--ssa-fontsdir=/fonts'] : []),
        ...(soundfont ? [`--soundfont=${soundfont}`] : []),
        ...(this.opts.args ?? []),
      ], 'args'),
      logLevel,
    });
    /** Milliseconds from createVLC() to ready (worker, wasm compile, pthreads, libvlc_new). */
    this.startupMs = performance.now() - t0;
  }

  /**
   * @param {{ canvas?: HTMLCanvasElement|OffscreenCanvas, fit?: 'contain'|'cover'|'fill',
   *           audio?: boolean, audioContext?: AudioContext, audioDestination?: AudioNode }} [opts]
   *   audio: false plays silently without creating an AudioContext.
   * @returns {Promise<Player>}
   */
  async createPlayer(opts = {}) {
    const id = this._nextPlayer++;
    const p = new Player(this, id, opts);
    this._players.set(id, p);
    try {
      return await p._init();
    } catch (e) {
      this._players.delete(id);
      throw e;
    }
  }

  /**
   * Reads a file's container, tracks and metadata without playing it —
   * like ffprobe, through VLC's own demuxers.
   * @param {File|Blob|ArrayBuffer|Uint8Array|string} source
   * @returns {Promise<{ duration?: number, meta: Record<string,string>, tracks: object[], status: number }>}
   */
  async probe(source, { timeout = 10000 } = {}) {
    const mrl = await this._mount(source);
    let timer;
    try {
      // The preparser has been seen to stall; give up rather than hang.
      const { i, value } = await Promise.race([
        this._call('parse', { i: [this._instance], s: [mrl] }, 'json'),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`probe timed out after ${timeout} ms`)), timeout); }),
      ]);
      if (i !== 0 && !value?.tracks?.length) throw new Error('VLC could not parse this source');
      return value;
    } finally {
      clearTimeout(timer);
      this._unmount(mrl);
    }
  }

  /** The equalizer presets and band frequencies VLC ships. */
  async equalizerPresets() {
    this._eq ??= this._call('equalizer_presets', {}, 'json').then((r) => r.value);
    return this._eq;
  }

  /** Changes how much of VLC's log reaches the 'log' event. */
  setLogLevel(level) {
    return this._call('set_log_level', { i: [this._instance, LOG_LEVELS[level] ?? 3] });
  }

  /** Stops every player and terminates the worker. */
  async destroy() {
    await Promise.allSettled([...this._players.values()].map((p) => p.destroy()));
    // Bounded: a wedged worker is terminated anyway.
    await Promise.race([this._rpc('dispose').catch(() => {}), new Promise((r) => setTimeout(r, 500))]);
    this.worker.terminate();
    this._destroyed = true;
    const err = new Error('VLC destroyed');
    for (const p of this._pending.values()) p.reject(err);
    this._pending.clear();
  }

  // --- internals ------------------------------------------------------------

  _rpc(method, args, transfer) {
    if (this._destroyed) return Promise.reject(new Error('VLC destroyed'));
    const id = ++this._seq;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args }, transfer ?? []);
    });
  }

  /** @internal */
  _call(name, { i, d, s } = {}, ret) {
    return this._rpc('call', { name, i, d, s, ret });
  }

  /** @internal */
  _mount(source, name) {
    if (typeof source === 'string' || source instanceof URL) {
      // Relative to the page, like <video src>; the worker would resolve it against itself.
      let url = String(source);
      try { url = new URL(url, globalThis.document?.baseURI ?? globalThis.location?.href).href; } catch { /* the worker says why */ }
      return this._rpc('mount', { source: url });
    }
    if (source instanceof Blob) return this._rpc('mount', { source });
    if (Array.isArray(source) && source.every((f) => f instanceof Blob)) return this._rpc('mount', { source });
    if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
      const bytes = source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
      const copy = bytes.slice();
      return this._rpc('mount', { source: { name: name ?? 'media', data: copy.buffer } }, [copy.buffer]);
    }
    return Promise.reject(new TypeError('source must be a File, Blob, File[] (opened together, first is played), ArrayBuffer, typed array or URL string'));
  }

  /** @internal */
  _unmount(mrl) { this._rpc('unmount', { mrl }).catch(() => {}); }

  /** @internal wasm memory grew: fetch the current SharedArrayBuffer */
  async _refreshMemory() {
    this._memory = await this._rpc('memory');
    for (const p of this._players.values()) {
      p.audioNode?.port.postMessage({ type: 'attach', memory: this._memory, ringPtr: p.ringPtr });
    }
  }

  _onMessage(msg) {
    if (msg.type === 'result') {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error));
      else p?.resolve(msg.result);
      return;
    }
    if (msg.type === 'event') {
      if (msg.event === EVENT.LOG) {
        this.emit('log', { level: LEVEL_NAMES[msg.a] ?? 'info', message: msg.str });
        return;
      }
      this._players.get(msg.player)?._onEvent(msg.event, msg.a, msg.b, msg.str);
    }
  }
}
