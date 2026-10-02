// Detects "settled" moments while recording: the page painted something and then stopped repainting.
// Each settled moment is a candidate clean screen. Works for manual browsing and AI runs alike,
// so a screen the user visits briefly is never lost just because it was short-lived.
import { EventEmitter } from 'node:events';

export class SettleMonitor extends EventEmitter {
  /**
   * @param {{recorder: import('./screencastRecorder.js').ScreencastRecorder, session: import('../browser/browserController.js').BrowserSession, quietMs?: number}} opts
   */
  constructor({ recorder, session, quietMs = 450, navigationMs = 900 }) {
    super();
    this.recorder = recorder;
    this.session = session;
    this.quietMs = quietMs;
    this.navigationMs = navigationMs;
    this.timer = null;
    this.navigationTimer = null;
    this.lastFrameMs = 0; // recorded-clock time of the latest screencast frame
    this.lastSettledFrameMs = -1;
    this.running = false;
    this.lastHash = null;
    this._onFrame = this._onFrame.bind(this);
    this._onNavigation = this._onNavigation.bind(this);
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.recorder.on('frame', this._onFrame);
    this.session.on('navigated', this._onNavigation);
    // The page may already be static when recording starts: take a first look shortly after.
    this._arm();
    this._armNavigation();
    this.lastFrameMs = this.recorder.recordedMs;
  }

  stop() {
    this.running = false;
    this.recorder.off('frame', this._onFrame);
    this.session.off('navigated', this._onNavigation);
    clearTimeout(this.timer);
    clearTimeout(this.navigationTimer);
    this.timer = null;
    this.navigationTimer = null;
  }

  _onFrame(buf) {
    if (!this.running || this.recorder.state !== 'recording') return;
    // Taking a screenshot makes the browser emit an identical frame; that is not page activity.
    const h = frameHash(buf);
    if (h === this.lastHash) return;
    this.lastHash = h;
    this.lastFrameMs = this.recorder.recordedMs;
    this._arm();
  }

  _arm() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this._settle(), this.quietMs);
  }

  _onNavigation() { this._armNavigation(); }

  // Sites with animations or live updates may never be visually quiet. A navigation still deserves a screen.
  _armNavigation() {
    clearTimeout(this.navigationTimer);
    this.navigationTimer = setTimeout(async () => {
      if (!this.running || this.recorder.state !== 'recording') return;
      // Don't grab a screenshot while the tab is still loading: it competes with the page for the renderer and the
      // tab keeps spinning. Wait for the load event (bounded) first.
      try { await this.session.page?.waitForLoadState('load', { timeout: 2500 }); } catch { /* slow page: capture anyway */ }
      if (!this.running || this.recorder.state !== 'recording') return;
      this.lastSettledFrameMs = this.lastFrameMs;
      this._emit().catch(() => {});
    }, this.navigationMs);
  }

  async _settle() {
    if (!this.running) return;
    if (this.recorder.state !== 'recording') { this._arm(); return; }
    if (this.lastFrameMs === this.lastSettledFrameMs) return; // nothing new since the last settle
    this.lastSettledFrameMs = this.lastFrameMs;
    await this._emit();
  }

  /** Forces a settle now (used right before stopping so the final screen is never lost). */
  async flush() {
    clearTimeout(this.timer);
    clearTimeout(this.navigationTimer);
    if (!this.running || this.lastFrameMs === this.lastSettledFrameMs) return;
    this.lastSettledFrameMs = this.lastFrameMs;
    await this._emit();
  }

  async _emit() {
    const event = { recordedMs: this.recorder.recordedMs, lastFrameMs: this.lastFrameMs, url: this.session.currentUrl(), title: '' };
    try { event.title = await Promise.race([this.session.title(), new Promise((r) => setTimeout(() => r(''), 500))]); } catch { /* title is optional */ }
    this.emit('settled', event);
  }
}

/** Cheap fingerprint of a JPEG frame: identical pages encode to identical bytes. */
function frameHash(buf) {
  if (!buf) return null;
  let h = buf.length | 0;
  for (let i = 0; i < buf.length; i += 61) h = (Math.imul(h, 31) + buf[i]) | 0;
  return h;
}
