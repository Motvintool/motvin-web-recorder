// Viewport-only video recorder.
//
// Chromium's screencast (CDP Page.startScreencast) streams JPEG frames of the page viewport only:
// no tabs, address bar, window frame, desktop or OS cursor. Each frame is fed at a constant frame rate to
// one or more ffmpeg "sinks" that encode it:
//   - recording.webm      VP8 at exactly the viewport size (Playwright-native format, used for analysis)
//   - recording.live.mp4  H.264 at the full capture resolution (e.g. 2x), encoded live from the original
//                         frames so there is no second lossy generation. Fragmented, so it survives a crash.
// Because we own the frame clock, pause/resume is real: while paused no frames are written and the recorded
// clock stops, so the output is one continuous video with the paused time removed.
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PREVIEW_FPS = 12;

class Sink {
  constructor(name, bin, args, outputPath) {
    this.name = name; this.outputPath = outputPath; this.stderr = ''; this.exit = null; this.failed = false;
    this.proc = spawn(bin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    this.proc.stderr.on('data', (d) => { this.stderr += d.toString(); if (this.stderr.length > 20000) this.stderr = this.stderr.slice(-20000); });
    this.proc.stdin.on('error', () => { this.failed = true; });
    this.proc.on('error', () => { this.failed = true; });
    this.proc.on('exit', (code, signal) => { this.exit = { code, signal }; });
  }
  get writable() { return !this.failed && this.proc.stdin.writable; }
  get backlog() { return this.proc.stdin.writableLength; }
  write(buf) { if (this.writable) this.proc.stdin.write(buf); }
  finish() {
    return new Promise((resolve) => {
      if (this.exit) return resolve(this.exit);
      const kill = setTimeout(() => { try { this.proc.kill('SIGKILL'); } catch { /* noop */ } }, 45000);
      this.proc.once('exit', () => { clearTimeout(kill); resolve(this.exit); });
      try { this.proc.stdin.end(); } catch { /* noop */ }
    });
  }
}

export class ScreencastRecorder extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('playwright').CDPSession} opts.cdp
   * @param {number} opts.width   viewport width in CSS pixels (the WebM is exactly this size)
   * @param {number} opts.height
   * @param {number} [opts.scale] capture density for the high-resolution MP4 (1, 2, 3)
   * @param {string} opts.outputPath   WebM path
   * @param {string} opts.ffmpegPath   ffmpeg that can write VP8/WebM
   * @param {string} [opts.mp4Path]    live H.264 MP4 path (needs mp4FfmpegPath)
   * @param {string} [opts.mp4FfmpegPath] ffmpeg with libx264
   * @param {number} [opts.fps]
   * @param {number} [opts.jpegQuality]
   */
  constructor(opts) {
    super();
    this.cdp = opts.cdp;
    this.width = opts.width;
    this.height = opts.height;
    this.scale = opts.scale || 1;
    this.pixelWidth = Math.round(this.width * this.scale);
    this.pixelHeight = Math.round(this.height * this.scale);
    this.outputPath = opts.outputPath;
    this.ffmpegPath = opts.ffmpegPath;
    this.mp4Path = opts.mp4Path || null;
    this.mp4FfmpegPath = opts.mp4FfmpegPath || null;
    this.fps = opts.fps || 30;
    this.jpegQuality = opts.jpegQuality || 92;
    this.state = 'idle'; // idle | recording | paused | stopping | stopped | error
    this.lastFrame = null;
    this.lastFrameAt = 0;
    this.framesWritten = 0;
    this.startedAt = 0;
    this.pauseStartedAt = 0;
    this.totalPausedMs = 0;
    this.pauseCount = 0;
    this.sinks = [];
    this.timer = null;
    this.screencastActive = false;
    this.exitPromise = null;
    this.lastAckAt = 0;
    this.sourceSwitch = Promise.resolve();
    this._onFrame = this._onFrame.bind(this);
  }

  /** Milliseconds of recorded (non-paused) time. */
  get recordedMs() {
    if (this.state === 'idle') return 0;
    const now = this.state === 'paused' ? this.pauseStartedAt : (this.endedAt || Date.now());
    return Math.max(0, now - this.startedAt - this.totalPausedMs);
  }

  isVisuallyStill(quietMs = 500) {
    return this.lastFrameAt > 0 && Date.now() - this.lastFrameAt >= quietMs;
  }

  async start() {
    if (this.state !== 'idle') throw new Error('Recorder already started');
    fs.mkdirSync(path.dirname(this.outputPath), { recursive: true });
    this._spawnSinks();
    await this.startScreencast();
    this.startedAt = Date.now();
    this.state = 'recording';
    this.timer = setInterval(() => this._tick(), Math.max(8, Math.floor(1000 / this.fps / 2)));
    this.emit('state', this.state);
  }

  /** Starts (or restarts) the CDP screencast. Used for live preview even before recording. */
  async startScreencast() {
    if (this.screencastActive) return;
    this.cdp.on('Page.screencastFrame', this._onFrame);
    // A freshly opened browser tab is sometimes not ready the instant it appears ("Not attached to an active page").
    let lastErr;
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: this.jpegQuality, maxWidth: this.pixelWidth, maxHeight: this.pixelHeight, everyNthFrame: 1 });
        this.screencastActive = true;
        return;
      } catch (err) {
        lastErr = err;
        if (!/Not attached to an active page|Target closed|session closed/i.test(String(err.message))) break;
        await new Promise((r) => setTimeout(r, 300 + attempt * 150));
      }
    }
    this.cdp.off('Page.screencastFrame', this._onFrame);
    throw lastErr;
  }

  async stopScreencast() {
    if (!this.screencastActive) return;
    this.screencastActive = false;
    this.cdp.off('Page.screencastFrame', this._onFrame);
    try { await this.cdp.send('Page.stopScreencast'); } catch { /* page may be gone */ }
  }

  /** Moves the recording to another tab: same video, new source page. */
  switchSource(newCdp) {
    this.sourceSwitch = this.sourceSwitch.catch(() => {}).then(async () => {
      const old = this.cdp;
      if (old === newCdp) return;
      if (this.screencastActive) {
        this.screencastActive = false;
        old.off('Page.screencastFrame', this._onFrame);
        try { await old.send('Page.stopScreencast'); } catch { /* old page may be gone */ }
      }
      this.cdp = newCdp;
      await this.startScreencast();
      this.emit('source-changed');
    });
    return this.sourceSwitch;
  }

  pause() {
    if (this.state !== 'recording') return false;
    this._tick();
    this.state = 'paused';
    this.pauseStartedAt = Date.now();
    this.pauseCount++;
    this.emit('state', this.state);
    return true;
  }

  resume() {
    if (this.state !== 'paused') return false;
    this.totalPausedMs += Date.now() - this.pauseStartedAt;
    this.pauseStartedAt = 0;
    this.state = 'recording';
    this.emit('state', this.state);
    return true;
  }

  /** Stops recording, finalises the files and resolves with facts about them. */
  async stop() {
    if (this.state === 'stopped' || this.state === 'stopping') return this.exitPromise;
    if (this.state === 'paused') this.resume();
    this.state = 'stopping';
    clearInterval(this.timer);
    this.timer = null;
    this.endedAt = Date.now();
    this._writeOwedFrames(true);
    await this.stopScreencast();
    this.exitPromise = this._finish().then((result) => {
      this.state = 'stopped';
      this.emit('state', this.state);
      return result;
    });
    return this.exitPromise;
  }

  async abort(reason) {
    if (this.state === 'stopped' || this.state === 'stopping') return this.exitPromise;
    this.abortReason = reason;
    return this.stop();
  }

  // --- internals ---

  _onFrame(event) {
    const buf = Buffer.from(event.data, 'base64');
    this.lastFrame = buf;
    this.lastFrameAt = Date.now();
    this._ack(this.cdp, event.sessionId);
    this.emit('frame', buf, event.metadata);
    if (this.state === 'recording') this._writeOwedFrames(false);
  }

  // Chrome sends the next screencast frame only after the previous one is acknowledged. Acknowledging at once makes it
  // JPEG-encode and ship a frame on every display refresh (90-120/s on a ProMotion screen) while we only need `fps`.
  // That work happens in the page's own browser and is what makes pages stutter, so pace the acknowledgements.
  // Not recording (live preview only) needs far fewer frames still.
  _ack(cdp, sessionId) {
    const rate = this.state === 'recording' ? this.fps : PREVIEW_FPS;
    const gap = 1000 / rate - 8; // the display's next refresh lands the frame on the exact 1/fps grid
    const now = Date.now();
    const at = Math.max(now, this.lastAckAt + gap);
    this.lastAckAt = at;
    const send = () => cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (at - now < 2) send(); else setTimeout(send, at - now);
  }

  _tick() {
    if (this.state !== 'recording') return;
    this._writeOwedFrames(false);
  }

  _writeOwedFrames(final) {
    if (!this.lastFrame) return;
    const live = this.sinks.filter((s) => s.writable);
    if (!live.length) return;
    const owed = Math.floor((this.recordedMs / 1000) * this.fps) - this.framesWritten;
    if (owed <= 0) return;
    // After a stall (e.g. the OS suspended the process) don't flood ffmpeg with thousands of frames.
    const count = Math.min(owed, final ? owed : this.fps * 3);
    // Backpressure: if any encoder is far behind, wait and catch up later rather than ballooning memory.
    if (!final && live.some((s) => s.backlog > 96 * 1024 * 1024)) return;
    for (let i = 0; i < count; i++) for (const s of live) s.write(this.lastFrame);
    this.framesWritten += count;
  }

  _spawnSinks() {
    const { width, height, pixelWidth: pw, pixelHeight: ph } = this;
    const input = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(this.fps), '-c:v', 'mjpeg', '-i', 'pipe:0', '-an'];
    // 1) WebM at exactly the viewport size (downscaled from the capture density when it is higher).
    const down = this.scale === 1 ? '' : `scale=${width}:${height}:flags=lanczos,`;
    const webmArgs = [...input,
      '-vf', `${down}pad=${width}:${height}:0:0:white,crop=${width}:${height}:0:0`,
      '-c:v', 'libvpx', '-qmin', '0', '-qmax', '32', '-crf', '4', '-deadline', 'realtime', '-speed', '8',
      '-b:v', '8M', '-threads', '2', '-pix_fmt', 'yuv420p', '-r', String(this.fps), '-f', 'webm', this.outputPath];
    this.sinks.push(new Sink('webm', this.ffmpegPath, webmArgs, this.outputPath));
    // 2) High-resolution H.264, straight from the original frames. BT.601 conversion with explicit tags was the
    //    most colour-accurate variant when measured in Chrome. Even dimensions are required by H.264.
    if (this.mp4Path && this.mp4FfmpegPath) {
      const evenW = Math.ceil(pw / 2) * 2; const evenH = Math.ceil(ph / 2) * 2;
      const mp4Args = [...input,
        '-vf', `scale=${pw}:${ph}:flags=lanczos,pad=${evenW}:${evenH}:0:0:white,scale=in_range=pc:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt601,format=yuv420p`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-profile:v', 'high', '-g', String(this.fps * 2), '-pix_fmt', 'yuv420p',
        '-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', '-color_range', 'tv',
        '-r', String(this.fps), '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', this.mp4Path];
      this.sinks.push(new Sink('mp4', this.mp4FfmpegPath, mp4Args, this.mp4Path));
    }
    this.sinks[0].proc.on('error', (err) => { this.state = 'error'; this.emit('error', new Error(`ffmpeg failed to start: ${err.message}`)); });
    for (const s of this.sinks.slice(1)) s.proc.on('error', (err) => this.emit('sink-error', s.name, err));
  }

  async _finish() {
    const exits = await Promise.all(this.sinks.map((s) => s.finish()));
    const webm = this.sinks[0]; const mp4 = this.sinks.find((s) => s.name === 'mp4');
    return {
      path: this.outputPath,
      mp4Path: mp4 && mp4.exit && mp4.exit.code === 0 && fs.existsSync(mp4.outputPath) ? mp4.outputPath : null,
      mp4Log: mp4 ? mp4.stderr.trim() : null,
      durationMs: this.recordedMs,
      framesWritten: this.framesWritten,
      fps: this.fps,
      width: this.width,
      height: this.height,
      pixelWidth: this.pixelWidth,
      pixelHeight: this.pixelHeight,
      pauseCount: this.pauseCount,
      pausedMs: this.totalPausedMs,
      ffmpegExit: exits[0],
      ffmpegLog: webm.stderr.trim(),
      aborted: this.abortReason || null,
    };
  }
}
