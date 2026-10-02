// Orchestrates one recording session at a time: browser → (recording) → (AI) → saved recording.
// Manual mode: the user starts/pauses/resumes/stops. AI mode: recording starts with the agent and
// stops when it finishes. Both save the same artefacts.
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { BrowserSession, normalizeUrl, validateViewport, isIdentityProvider } from '../browser/browserController.js';
import { ScreencastRecorder } from '../recording/screencastRecorder.js';
import { ExplorationAgent } from '../agent/agent.js';
import { resolveBrain } from '../agent/brains/index.js';
import { findFfmpeg } from '../recording/ffmpeg.js';
import { RECORDING_DEFAULTS, AI_DEFAULTS } from '../config.js';
import { MP4_LIVE_FILENAME } from '../export/mp4.js';
import { makeRecordingId, createRecordingFolder, saveMetadata, updateMetadata, refreshVideoFacts, writeJson, VIDEO_FILENAME, EVENTS_FILENAME, ensureRecordingsDir, recordingDir } from '../storage/recordingStore.js';
import { processRecording } from '../analysis/pipeline.js';
import { SettleMonitor } from '../recording/settleMonitor.js';
import { ScreenCapturer } from '../recording/screenCapturer.js';
import { SCREEN_DEFAULTS } from '../config.js';
import { findChrome } from '../browser/chrome.js';
import { exportMp4, findMp4Encoder } from '../export/mp4.js';
import { exportScreensZip } from '../export/screensZip.js';
import { ANALYSIS_FILENAME } from '../storage/recordingStore.js';
import fs from 'node:fs';

export class SessionManager extends EventEmitter {
  constructor() {
    super();
    this.reset();
    this.logBuffer = [];
    this.processing = new Map(); // recordingId → progress
    this.exporting = new Map(); // `${id}:${kind}` → progress
  }

  reset() {
    this.phase = 'idle'; // idle | launching | ready | recording | paused | stopping | processing | completed | error
    this.mode = null;
    this.url = null;
    this.viewport = null;
    this.session = null;
    this.recorder = null;
    this.agent = null;
    this.recordingId = null;
    this.recordingMeta = null;
    this.error = null;
    this.aiStatus = null;
    this.previewTimer = null;
    this.lastPreviewSentAt = 0;
    this.previewSubscribed = false;
    this.aiOptions = null;
    this.observations = [];
    this.settled = [];
    this.monitor = null;
    this.capturer = null;
    this.browserKind = 'chromium';
    this.screenScale = SCREEN_DEFAULTS.scale;
    this.videoScale = 1;
    this.lastSavedId = null;
    this.flow = [];
    this.activity = [];
    this.activityKinds = [];
    this.activityTracked = false;
    this.lastActivityAt = 0;
    this.followSignIn = true;
    this.lastPreview = null;
    this.startedRecordingAt = 0;
    clearInterval(this._tabTimer); clearInterval(this._flushTimer);
    this._tabTimer = null; this._flushTimer = null;
  }

  log(message, level = 'info') {
    const entry = { t: Date.now(), level, message };
    this.logBuffer.push(entry);
    if (this.logBuffer.length > 400) this.logBuffer.shift();
    this.emit('log', entry);
  }

  state() {
    const rec = this.recorder;
    return {
      phase: this.phase,
      mode: this.mode,
      url: this.url,
      currentUrl: this.session?.currentUrl() || null,
      viewport: this.viewport,
      recordingId: this.recordingId,
      lastSavedId: this.lastSavedId,
      flow: this.flow.slice(-40),
      idleMs: this.recorder && this.recorder.state === 'recording' ? Date.now() - Math.max(this.lastActivityAt, this.startedRecordingAt) : 0,
      recordingAgeMs: this.recorder && ['recording', 'paused'].includes(this.recorder.state) ? Date.now() - this.startedRecordingAt : 0,
      videoScale: this.videoScale,
      recording: rec ? { state: rec.state, durationMs: rec.recordedMs, pauseCount: rec.pauseCount, framesWritten: rec.framesWritten } : null,
      ai: this.agent ? { ...this.agent.progress(), status: this.agent.status, screensList: this.agent.screens.slice(-50), lastSteps: this.agent.steps.slice(-8), limits: this.agent.limits } : (this.aiStatus || null),
      error: this.error,
      processing: Object.fromEntries(this.processing),
      browserOpen: Boolean(this.session && !this.session.closed),
    };
  }

  publish() { this.emit('state', this.state()); }

  get busy() { return !['idle', 'completed', 'error'].includes(this.phase); }

  /** Opens Chromium at the URL. For AI mode also starts recording + exploration. */
  async launch({ url, viewport, mode, ai = {}, browser = 'chromium', screenScale, videoScale, autoStart = false, followSignIn = true }) {
    if (this.busy && this.session && !this.session.closed) throw new Error('A session is already open. Stop it before starting a new one.');
    const ff = findFfmpeg();
    if (!ff.available) throw new Error(ff.installHint);
    const normalized = normalizeUrl(url);
    const vp = validateViewport(viewport);
    if (!['manual', 'ai'].includes(mode)) throw new Error('Choose Manual or AI Agent mode.');
    this.reset();
    if (!['chromium', 'chrome'].includes(browser)) throw new Error('Unknown browser option.');
    if (browser === 'chrome' && !findChrome()) throw new Error('Google Chrome was not found. Install Chrome (or set CHROME_PATH), or choose the Chromium option.');
    this.browserKind = browser;
    this.followSignIn = followSignIn !== false;
    this.screenScale = [1, 2, 3].includes(Number(screenScale)) ? Number(screenScale) : SCREEN_DEFAULTS.scale;
    // My Chrome needs no emulation for this: the screencast delivers the tab's native pixels (2x on Retina), capped by maxWidth.
    this.videoScale = effectiveVideoScale(vp, [1, 2, 3].includes(Number(videoScale)) ? Number(videoScale) : RECORDING_DEFAULTS.videoScale);
    this.phase = 'launching'; this.mode = mode; this.url = normalized; this.viewport = vp; this.aiOptions = ai;
    this.aiStatus = mode === 'ai' ? { status: 'Launching' } : null;
    this.publish();
    this.log(`Launching ${browser === 'chrome' ? 'Google Chrome' : 'Chromium'} at ${vp.width}×${vp.height} (video ${vp.width * this.videoScale}×${vp.height * this.videoScale}) for ${normalized}`);
    try {
      this.session = new BrowserSession({ viewport: vp, browser: this.browserKind, popups: mode === 'manual' ? 'keep' : 'redirect', deviceScale: this.videoScale, followSignIn: this.followSignIn, log: (m) => this.log(m) });
      await this.session.launch();
      this.session.on('gone', (reason) => this._onBrowserGone(reason));
      this.session.on('navigated', (u) => {
        if (this.recorder && ['recording', 'paused'].includes(this.recorder.state)) {
          this.observations.push({ kind: 'navigation', url: u, recordedMs: this.recorder.recordedMs });
          if (this.recorder.state === 'recording' && this.mode === 'manual' && isIdentityProvider(u)) this.log('A sign-in page is being recorded. Passwords show as dots; press Pause if you would rather skip it.');
        }
        this.emit('navigated', u); this.publish();
      });
      this.session.on('activity', (type) => {
        this.activityTracked = true; // the detector demonstrably works in this session
        if (type === 'selftest') return;
        this.lastActivityAt = Date.now();
        // Real clicks, keys and scrolls (not bare mouse movement) tell us whether a page change was the user's doing.
        if (!this.recorder || this.recorder.state !== 'recording' || type === 'pointermove') return;
        const t = this.recorder.recordedMs; const last = this.activity[this.activity.length - 1];
        if (!last || t - last > 120 || type === 'keydown' || type === 'pointerdown') {
          this.activity.push(t); this.activityKinds.push(type === 'keydown' ? 'k' : type === 'wheel' ? 'w' : 'c');
          if (this.activity.length > 6000) { this.activity.shift(); this.activityKinds.shift(); }
        }
      });
      this.session.on('page-changed', ({ cdp }) => { this.recorder?.switchSource(cdp).catch((err) => this.log(`Could not follow the tab: ${err.message}`, 'error')); this.publish(); });
      // Live preview (screencast) runs from the moment the browser opens, before recording.
      this.recorder = this._makeRecorder();
      this.recorder.on('frame', (buf) => this._onPreviewFrame(buf));
      await this.recorder.startScreencast();
      try {
        await this.session.navigate(normalized);
      } catch (err) {
        if (mode !== 'manual') throw err;
        this.log(`Could not open ${normalized}: ${err.message}. Use the Chrome address bar to navigate, then press Start recording.`, 'error');
      }
      await this.session.selfTestActivity();
      this.log(`Browser ready at ${this.session.currentUrl()}`);
      this.phase = 'ready';
      this.publish();
      if (mode === 'ai') await this.startAi();
      else if (autoStart) await this.startRecording();
      return this.state();
    } catch (err) {
      this.error = String(err.message || err);
      this.phase = 'error';
      this.log(this.error, 'error');
      this.publish();
      await this._teardownBrowser();
      // A launch that failed before recording leaves an empty folder behind; remove it.
      if (this.recordingId && (!this.recorder || this.recorder.state === 'idle')) { try { const fsp = await import('node:fs/promises'); await fsp.rmdir(recordingDir(this.recordingId)); } catch { /* not empty or already gone */ } }
      throw err;
    }
  }

  _makeRecorder() {
    const ff = findFfmpeg();
    const enc = findMp4Encoder();
    this.recordingId = makeRecordingId(this.url, this.mode);
    const dir = createRecordingFolder(this.recordingId);
    const recorder = new ScreencastRecorder({
      cdp: this.session.cdp, width: this.viewport.width, height: this.viewport.height, scale: this.videoScale,
      outputPath: path.join(dir, VIDEO_FILENAME), ffmpegPath: ff.path,
      mp4Path: enc.available ? path.join(dir, MP4_LIVE_FILENAME) : null, mp4FfmpegPath: enc.available ? enc.path : null,
      fps: RECORDING_DEFAULTS.fps, jpegQuality: RECORDING_DEFAULTS.jpegQuality,
    });
    recorder.on('error', (err) => { this.log(`Recording error: ${err.message}`, 'error'); this.error = `Recording error: ${err.message}`; this.publish(); });
    recorder.on('state', () => this.publish());
    recorder.on('sink-error', (name, err) => this.log(`The ${name} encoder failed (${err.message}); the other recording continues.`, 'error'));
    return recorder;
  }

  _onPreviewFrame(buf) {
    this.lastPreview = buf;
    const now = Date.now();
    if (now - this.lastPreviewSentAt < 1000 / RECORDING_DEFAULTS.previewFps) return;
    this.lastPreviewSentAt = now;
    this.emit('preview', buf);
  }

  // ---- Manual recording controls ----

  async startRecording() {
    if (!this.session || this.session.closed) throw new Error('Open a website first.');
    if (this.recorder.state !== 'idle') throw new Error('Recording already started.');
    const ff = findFfmpeg();
    if (!ff.available) throw new Error(ff.installHint);
    await this.recorder.start();
    this.startedRecordingAt = Date.now();
    this.flow = [];
    this.capturer = new ScreenCapturer({ cdp: () => this.session.cdp, dir: path.join(recordingDir(this.recordingId), 'captures'), width: this.viewport.width, height: this.viewport.height, scale: this.screenScale, quality: SCREEN_DEFAULTS.webpQuality });
    this.monitor = new SettleMonitor({ recorder: this.recorder, session: this.session });
    this.monitor.on('settled', (ev) => this._onSettled(ev));
    this.monitor.start();
    this.phase = 'recording';
    this.recordingMeta = {
      id: this.recordingId, name: this.recordingId, url: this.url, mode: this.mode, viewport: this.viewport, browser: this.browserKind, screenScale: this.screenScale, videoScale: this.videoScale,
      highRes: this.recorder.mp4Path ? { width: this.recorder.pixelWidth, height: this.recorder.pixelHeight, file: MP4_LIVE_FILENAME } : null,
      fps: RECORDING_DEFAULTS.fps, startedAt: new Date().toISOString(), status: 'recording', videoPath: path.join(recordingDir(this.recordingId), VIDEO_FILENAME), location: recordingDir(this.recordingId),
      ai: this.mode === 'ai' ? { backend: this.aiOptions?.backend || 'auto', limits: { ...AI_DEFAULTS, ...(this.aiOptions?.limits || {}) } } : null,
    };
    await saveMetadata(this.recordingId, this.recordingMeta);
    // Save progress regularly so an interrupted recording (crash, closed laptop, killed server) can be recovered.
    this._flushTimer = setInterval(() => this._flushProgress().catch(() => {}), 4000);
    this.log('Recording started');
    this.publish();
  }

  async _flushProgress() {
    if (!this.recordingId || !this.recorder || !['recording', 'paused'].includes(this.recorder.state)) return;
    await updateMetadata(this.recordingId, { durationMs: this.recorder.recordedMs, lastSavedAt: new Date().toISOString(), pauseCount: this.recorder.pauseCount });
    await this._writeEvents();
  }

  /** Keeps a readable list of the pages seen while recording, so the UI can show the flow as it happens. */
  _trackFlow(ev) {
    const key = (u) => { try { const x = new URL(u); x.hash = ''; return x.origin + x.pathname.replace(/\/+$/, '') + x.search; } catch { return u; } };
    const goodTitle = ev.title && !/^loading\b/i.test(ev.title) && !/^https?:\/\//i.test(ev.title);
    const last = this.flow[this.flow.length - 1];
    if (last && key(last.url) === key(ev.url)) { if (goodTitle) last.title = ev.title; return; }
    if (!ev.url || ev.url.startsWith('about:')) return;
    this.flow.push({ url: ev.url, title: goodTitle ? ev.title : '', recordedMs: ev.recordedMs });
    if (this.flow.length > 200) this.flow.shift();
  }

  _onSettled(ev) {
    this._trackFlow(ev);
    const entry = { ...ev, file: null };
    this.settled.push(entry);
    if (this.settled.length > 1500) this.settled.shift();
    this.capturer?.capture().then((c) => { if (c) { entry.file = c.file; entry.width = c.width; entry.height = c.height; entry.scale = c.scale; } });
  }

  pauseRecording() {
    if (!this.recorder?.pause()) throw new Error('Nothing to pause.');
    this.phase = 'paused';
    this.log('Recording paused — the page stays exactly where it is');
    this.publish();
  }

  resumeRecording() {
    if (!this.recorder?.resume()) throw new Error('Recording is not paused.');
    this.phase = 'recording';
    this.log('Recording resumed');
    this.publish();
  }

  /**
   * Stops recording and saves everything. closeBrowser=false keeps the browser open so the user can record again
   * (manual mode); a stop that closes the browser is only used when the session itself ends.
   */
  async stopRecording({ closeBrowser = true, reason = null, force = false } = {}) {
    if (!this.recorder || !['recording', 'paused'].includes(this.recorder.state)) {
      if (closeBrowser) { await this._teardownBrowser(); this.phase = 'idle'; this.publish(); }
      throw new Error('No active recording to stop.');
    }
    // A stop within a moment of starting is almost always a stray double-click.
    if (!force && !reason && this.mode === 'manual' && this.recorder.recordedMs < MIN_RECORDING_MS) {
      const err = new Error('The recording just started. Give it a moment, then press Stop.'); err.status = 409; throw err;
    }
    this.phase = 'stopping';
    clearInterval(this._flushTimer); this._flushTimer = null;
    this.publish();
    if (this.agent && !this.agent.finished) this.agent.stop(reason || 'Recording stopped');
    // Make sure the final screen is captured before the video ends.
    try { if (this.recorder.state === 'recording') { await this.monitor?.flush(); await this.capturer?.drain(); } } catch { /* best effort */ }
    this.monitor?.stop();
    const savedId = this.recordingId;
    const result = await this.recorder.stop();
    this.log(`Recording stopped after ${(result.durationMs / 1000).toFixed(1)}s (${result.framesWritten} frames${result.pauseCount ? `, ${result.pauseCount} pause${result.pauseCount > 1 ? 's' : ''}` : ''})`);
    if (result.ffmpegExit && result.ffmpegExit.code !== 0) this.log(`ffmpeg finished with code ${result.ffmpegExit.code}: ${result.ffmpegLog.slice(-300)}`, 'error');
    if (this.recorder.mp4Path && !result.mp4Path) this.log(`The high-resolution MP4 could not be finished${result.mp4Log ? `: ${result.mp4Log.slice(-200)}` : ''}. The WebM is intact; MP4 export will convert it.`, 'error');
    const finalUrl = this.session?.currentUrl() || null;
    await updateMetadata(savedId, {
      ...this.recordingMeta, status: 'completed', endedAt: new Date().toISOString(), durationMs: result.durationMs, pauseCount: result.pauseCount, pausedMs: result.pausedMs,
      framesWritten: result.framesWritten, finalUrl, aborted: result.aborted, highRes: result.mp4Path ? { width: result.pixelWidth, height: result.pixelHeight, file: MP4_LIVE_FILENAME } : null,
      ai: this.agent ? { ...(this.recordingMeta?.ai || {}), summary: this.agent.summary || null, brain: this.agent.brain.label } : this.recordingMeta?.ai || null,
    });
    await this._writeEvents();
    const meta = await refreshVideoFacts(savedId);
    if (meta?.video && (meta.video.width !== this.viewport.width || meta.video.height !== this.viewport.height)) {
      this.log(`Warning: video is ${meta.video.width}×${meta.video.height}, expected ${this.viewport.width}×${this.viewport.height}`, 'error');
    }
    this.lastSavedId = savedId;
    this.emit('recording-saved', meta);
    if (closeBrowser) {
      this.phase = 'completed';
      this.publish();
      // The files are saved; closing the browser must not hold up the caller.
      this._teardownBrowser().then(() => this.publish()).catch(() => this.publish());
    } else if (this.session && !this.session.closed) {
      // Keep the browser (and the page the user is on) so they can record again without reopening.
      this.agent = null; this.monitor = null; this.capturer = null; this.settled = []; this.observations = []; this.activity = []; this.activityKinds = []; this.recordingMeta = null;
      this.recorder.removeAllListeners();
      this.recorder = this._makeRecorder();
      this.recorder.on('frame', (buf) => this._onPreviewFrame(buf));
      this.recorder.startScreencast().catch(() => {});
      this.phase = 'ready';
      this.publish();
    } else {
      this.phase = 'completed';
      this.publish();
    }
    return meta;
  }

  async _writeEvents() {
    if (!this.recordingId) return;
    const events = {
      screens: this.agent?.screens || [],
      steps: this.agent?.steps || [],
      observations: this.observations,
      settled: this.settled,
      activity: this.activity,
      activityKinds: this.activityKinds,
      activityTracked: this.activityTracked,
      log: this.logBuffer.slice(-200),
    };
    await writeJson(path.join(recordingDir(this.recordingId), EVENTS_FILENAME), events);
  }

  // ---- AI controls ----

  async startAi() {
    if (!this.session || this.session.closed) throw new Error('Open a website first.');
    const opts = this.aiOptions || {};
    this.aiStatus = { status: 'AI Ready' };
    this.publish();
    let brains;
    try {
      brains = await resolveBrain({ backend: opts.backend || AI_DEFAULTS.backend, model: opts.model });
    } catch (err) {
      this.log(`${err.message} Falling back to the built-in planner.`, 'error');
      brains = await resolveBrain({ backend: 'heuristic' });
    }
    this.log(`AI brain: ${brains.brain.label}`);
    if (this.recorder.state === 'idle') await this.startRecording();
    this.agent = new ExplorationAgent({ session: this.session, recorder: this.recorder, brains, limits: opts.limits || {}, log: (m) => this.log(m) });
    this.agent.on('status', (s) => { this.emit('ai', { type: 'status', ...s }); this.publish(); });
    this.agent.on('screen', (s) => { this.emit('ai', { type: 'screen', screen: s }); this.publish(); });
    this.agent.on('action', (a) => { this.emit('ai', { type: 'action', ...a }); this.publish(); });
    this.agent.on('step', () => this.publish());
    this.agent.on('observation', (o) => { this.observations.push({ ...o, recordedMs: this.recorder.recordedMs }); if (this.observations.length > 2000) this.observations.shift(); });
    this.agent.run().then(async (summary) => {
      this.log(`AI finished: ${summary.endReason}`);
      if (this.recorder && ['recording', 'paused'].includes(this.recorder.state)) {
        try {
          const meta = await this.stopRecording({ closeBrowser: true, reason: summary.endReason });
          this.emit('ai', { type: 'done', summary, recordingId: meta?.id });
          if (this.aiOptions?.autoProcess !== false) this.process(meta.id).catch((err) => this.log(`Processing failed: ${err.message}`, 'error'));
        } catch (err) {
          this.log(`Could not finalise the recording: ${err.message}`, 'error');
        }
      }
    }).catch((err) => { this.log(`AI crashed: ${err.message}`, 'error'); this.error = err.message; this.publish(); });
    this.publish();
  }

  pauseAi() { if (!this.agent?.pause()) throw new Error('AI is not running.'); this.publish(); }
  resumeAi() { if (!this.agent?.resume()) throw new Error('AI is not paused.'); this.publish(); }
  stopAi() { if (!this.agent?.stop('Stopped by user')) throw new Error('AI is not running.'); this.publish(); }

  // ---- Browser ----

  async closeSession() {
    if (this.recorder && ['recording', 'paused'].includes(this.recorder.state)) return this.stopRecording({ closeBrowser: true, reason: 'Session closed' });
    await this._teardownBrowser();
    if (this.recorder && this.recorder.state === 'idle') {
      // Browser opened but never recorded: remove the empty folder.
      try { const fs = await import('node:fs/promises'); await fs.rm(recordingDir(this.recordingId), { recursive: true, force: true }); } catch { /* noop */ }
    }
    this.phase = 'idle';
    this.publish();
    return this.state();
  }

  async _teardownBrowser() {
    clearInterval(this._tabTimer); this._tabTimer = null;
    try { await this.recorder?.stopScreencast(); } catch { /* noop */ }
    try { await this.session?.close(); } catch { /* noop */ }
  }

  /** Called when the server stops: save any recording in progress and close the browser completely before exiting. */
  async shutdown() {
    try {
      if (this.recorder && ['recording', 'paused'].includes(this.recorder.state)) await this.stopRecording({ closeBrowser: true, reason: 'Recorder server stopped' });
    } catch { /* best effort */ }
    await this._teardownBrowser();
  }

  async _onBrowserGone(reason) {
    this.log(`${reason}.`, 'error');
    if (this.agent && !this.agent.finished) this.agent.stop(reason);
    if (this.recorder && ['recording', 'paused'].includes(this.recorder.state)) {
      this.log('Saving what was recorded so far…');
      try { await this.stopRecording({ closeBrowser: true, reason }); } catch (err) { this.log(`Could not save: ${err.message}`, 'error'); }
      this.error = `${reason} — the recording up to that point was saved.`;
    } else {
      this.phase = 'idle';
      this.error = reason;
    }
    await this._teardownBrowser();
    this.publish();
  }

  async input(ev) {
    if (!this.session || this.session.closed) throw new Error('Browser is not open');
    if (ev.type === 'focus') return this.session.bringToFront();
    return this.session.input(ev);
  }

  // ---- Export ----

  /** Builds the downloadable file for a recording. kind: 'video' (MP4) or 'screens' (ZIP of WebP). Progress goes out as 'export' events. */
  async export(id, kind) {
    if (!['video', 'screens'].includes(kind)) throw new Error('Export either "video" or "screens".');
    const dir = recordingDir(id);
    if (!fs.existsSync(dir)) throw new Error('Recording not found.');
    const key = `${id}:${kind}`;
    if (this.exporting.get(key)?.stage === 'working') throw new Error('This export is already running.');
    const progress = { id, kind, stage: 'working', percent: 0, message: kind === 'video' ? 'Encoding MP4…' : 'Preparing screens…' };
    this.exporting.set(key, progress);
    const send = (patch = {}) => { Object.assign(progress, patch); this.emit('export', { ...progress }); };
    send();
    try {
      let result;
      if (kind === 'video') {
        if (!findMp4Encoder().available) throw new Error(findMp4Encoder().installHint);
        result = await exportMp4({ recordingDir: dir, onProgress: (p) => send({ percent: p.percent, message: `Encoding MP4… ${p.percent}%` }) });
      } else {
        if (!fs.existsSync(path.join(dir, ANALYSIS_FILENAME))) {
          send({ message: 'Extracting clean screens first…' });
          await this.process(id);
        }
        result = await exportScreensZip({ recordingDir: dir });
      }
      send({ stage: 'done', percent: 100, message: kind === 'video' ? 'MP4 ready' : `${result.count} screens ready`, sizeBytes: result.sizeBytes, downloadUrl: `/api/recordings/${encodeURIComponent(id)}/download/${kind}` });
      return result;
    } catch (err) {
      send({ stage: 'error', message: err.message });
      throw err;
    }
  }

  // ---- Processing ----

  async process(id, options = {}) {
    const ff = findFfmpeg();
    if (!ff.available) throw new Error(ff.installHint);
    if (this.processing.has(id) && this.processing.get(id).stage !== 'done' && this.processing.get(id).stage !== 'error') throw new Error('This recording is already being processed.');
    const dir = recordingDir(id);
    const progress = { stage: 'start', message: 'Starting…', startedAt: Date.now() };
    this.processing.set(id, progress);
    this.emit('processing', { id, ...progress });
    try {
      const analysis = await processRecording({ recordingDir: dir, ffmpegPath: ff.path, intervalSeconds: options.intervalSeconds, keepAllFrames: options.keepAllFrames !== false, onProgress: (p) => { if (p.stage === 'done') return; Object.assign(progress, p); this.emit('processing', { id, ...progress }); } });
      await updateMetadata(id, { processedAt: analysis.processedAt, screensFound: analysis.screens.length, framesExtracted: analysis.frameCount });
      Object.assign(progress, { stage: 'done', message: `${analysis.screens.length} clean screens from ${analysis.frameCount} frames`, stats: analysis.stats });
      this.emit('processing', { id, ...progress });
      this.emit('recording-updated', id);
      return analysis;
    } catch (err) {
      Object.assign(progress, { stage: 'error', message: err.message });
      this.emit('processing', { id, ...progress });
      throw err;
    }
  }
}

ensureRecordingsDir();

export const MIN_RECORDING_MS = 1500;

/** Largest density up to `requested` whose frame stays within the real-time encoding budget. */
export function effectiveVideoScale(viewport, requested) {
  let scale = requested;
  while (scale > 1 && viewport.width * viewport.height * scale * scale > RECORDING_DEFAULTS.maxVideoPixels) scale--;
  return scale;
}
