// Chromium control via Playwright. One headed browser, one context (cookies, localStorage,
// auth state live here), one page that everything else attaches to.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { VIEWPORT_LIMITS, CHROME_PROFILE_DIR } from '../config.js';
import { findChrome } from './chrome.js';

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

export class BrowserLaunchError extends Error { constructor(msg, cause) { super(msg); this.name = 'BrowserLaunchError'; this.cause = cause; } }
export class NavigationError extends Error { constructor(msg, cause) { super(msg); this.name = 'NavigationError'; this.cause = cause; } }

const IDP_HOSTS = /(^|\.)(accounts\.google\.com|login\.microsoftonline\.com|login\.live\.com|appleid\.apple\.com|facebook\.com|github\.com|auth0\.com|okta\.com|login\.salesforce\.com)$/i;
export const isIdentityProvider = (url) => { try { return IDP_HOSTS.test(new URL(url).hostname); } catch { return false; } };

/** A recorder Chrome left behind by an interrupted run still owns the profile; it is ours, so close it. */
async function killOrphanChrome() {
  if (process.platform === 'win32') return;
  try {
    const out = execFileSync('pgrep', ['-f', `--user-data-dir=${CHROME_PROFILE_DIR}`], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const pids = out.split(/\s+/).map(Number).filter((n) => n && n !== process.pid);
    for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch { /* gone */ } }
    if (pids.length) await new Promise((r) => setTimeout(r, 1500));
  } catch { /* none running */ }
}

function freePort() {
  return new Promise((resolve, reject) => { const srv = net.createServer(); srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); srv.on('error', reject); });
}

export function normalizeUrl(input) {
  let text = String(input || '').trim();
  if (!text) throw new NavigationError('Enter a website URL to begin.');
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(text)) text = `https://${text}`;
  let url;
  try { url = new URL(text); } catch { throw new NavigationError(`"${input}" is not a valid URL.`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new NavigationError('Only http:// and https:// URLs can be recorded.');
  if (!url.hostname.includes('.') && !['localhost'].includes(url.hostname) && !/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) {
    throw new NavigationError(`"${url.hostname}" does not look like a reachable host name.`);
  }
  return url.toString();
}

export function validateViewport(v) {
  const width = Math.round(Number(v?.width));
  const height = Math.round(Number(v?.height));
  if (!Number.isFinite(width) || !Number.isFinite(height)) throw new Error('Viewport width and height must be numbers.');
  if (width < VIEWPORT_LIMITS.min || height < VIEWPORT_LIMITS.min || width > VIEWPORT_LIMITS.max || height > VIEWPORT_LIMITS.max) {
    throw new Error(`Viewport must be between ${VIEWPORT_LIMITS.min} and ${VIEWPORT_LIMITS.max} pixels on each side.`);
  }
  return { width, height, kind: v?.kind || (width < 600 ? 'mobile' : width < 1000 ? 'tablet' : 'desktop'), preset: v?.preset || 'custom' };
}

export class BrowserSession extends EventEmitter {
  /**
   * @param {{viewport: object, log?: Function, browser?: 'chromium'|'chrome', popups?: 'keep'|'redirect', deviceScale?: number}} opts
   *   deviceScale: pixel density of the page (2 = Retina), so the recording is genuinely sharper, not upscaled.
   *   browser: 'chromium' = Playwright's Chromium; 'chrome' = the user's installed Google Chrome (works with Google sign-in).
   *   popups: 'keep' leaves pop-ups open (manual: OAuth windows); 'redirect' folds them into the recorded page (AI).
   */
  constructor({ viewport, log = () => {}, browser = 'chromium', popups = 'redirect', deviceScale = 1, followSignIn = true }) {
    super();
    this.followSignIn = followSignIn;
    this.deviceScale = deviceScale;
    this.browserKind = browser;
    this.popups = popups;
    this.chromeProc = null;
    this.viewport = validateViewport(viewport);
    this.log = log;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.cdp = null;
    this.closed = false;
    this.startOrigin = null;
  }

  async launch() {
    if (this.browserKind === 'chrome') await this._launchChrome(); else await this._launchChromium();
    return this._setupPage();
  }

  async _launchChromium() {
    const { width, height } = this.viewport;
    const chromeHeight = height + 88; // tab strip + toolbar, so the whole viewport is visible
    try {
      this.browser = await chromium.launch({
        headless: false,
        args: [
          `--window-size=${width + 16},${chromeHeight}`,
          '--window-position=40,40',
          '--disable-infobars',
          '--no-first-run',
          '--no-default-browser-check',
          '--autoplay-policy=no-user-gesture-required',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
      });
    } catch (err) {
      const hint = /Executable doesn't exist|browserType.launch/.test(String(err.message))
        ? ' Chromium is not installed for Playwright. Run `npx playwright install chromium` in the motvin-web-recorder folder.'
        : '';
      throw new BrowserLaunchError(`Could not launch Chromium.${hint}`, err);
    }
  }

  /** Starts the user's real Chrome as an ordinary process and attaches over its DevTools port. */
  async _launchChrome() {
    const { width, height } = this.viewport;
    const exe = findChrome();
    if (!exe) throw new BrowserLaunchError('Google Chrome was not found. Install Chrome, set CHROME_PATH, or switch the Browser option to Chromium.');
    fs.mkdirSync(CHROME_PROFILE_DIR, { recursive: true });
    await killOrphanChrome();
    const port = await freePort();
    const args = [
      `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1',
      `--user-data-dir=${CHROME_PROFILE_DIR}`,
      '--no-first-run', '--no-default-browser-check',
      `--window-size=${width},${height + 87}`, '--window-position=40,40',
      '--new-window', 'about:blank',
    ];
    this.chromeProc = spawn(exe, args, { stdio: 'ignore' });
    let exitedEarly = false;
    this.chromeProc.on('exit', () => { exitedEarly = true; });
    const deadline = Date.now() + 20000;
    let ready = false;
    while (Date.now() < deadline && !exitedEarly) {
      try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) { ready = true; break; } } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!ready) {
      this._killChrome();
      throw new BrowserLaunchError(exitedEarly
        ? 'Chrome closed immediately. Another recorder Chrome window may still be using the profile — close it and try again.'
        : 'Chrome did not open its DevTools port in time.');
    }
    try {
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (err) {
      this._killChrome();
      throw new BrowserLaunchError(`Could not attach to Chrome: ${String(err.message).split('\n')[0]}`, err);
    }
  }

  _killChrome() { try { this.chromeProc?.kill('SIGTERM'); } catch { /* noop */ } }

  async _setupPage() {
    const { width, height, kind } = this.viewport;
    this.browser.on('disconnected', () => this._onGone('Browser was closed'));
    this.isMobile = kind === 'mobile';
    this.cdps = new WeakMap();
    if (this.browserKind === 'chrome') {
      this.context = this.browser.contexts()[0] || await this.browser.newContext();
    } else {
      this.context = await this.browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: this.deviceScale,
        isMobile: this.isMobile,
        hasTouch: this.isMobile,
        userAgent: this.isMobile ? MOBILE_UA : undefined,
        ignoreHTTPSErrors: false,
        colorScheme: 'light',
        locale: 'en-US',
      });
    }
    // Which tab is the user working in? Playwright reports every tab as focused, so rely on real (trusted) input instead.
    this.activity = new WeakMap();
    await this.context.exposeBinding('__motvinActivity', (source, type) => {
      const pg = source.page; if (!pg || pg.isClosed()) return;
      this.activity.set(pg, Date.now());
      this.emit('activity', String(type || ''));
      if (this.popups === 'keep' && pg !== this.page) this.switchTo(pg).catch(() => {});
    });
    await this.context.addInitScript(() => {
      // Throttle per event type: mouse movement always fires just before a click or scroll and must not swallow it.
      const last = {}; const gap = { pointermove: 250, wheel: 120, keydown: 60, pointerdown: 0, touchstart: 0 };
      const ping = (e) => { if (!e.isTrusted) return; const n = Date.now(); if (n - (last[e.type] || 0) < (gap[e.type] ?? 100)) return; last[e.type] = n; try { window.__motvinActivity(e.type); } catch { /* binding not ready */ } };
      for (const t of Object.keys(gap)) window.addEventListener(t, ping, { capture: true, passive: true });
    });
    const existing = this.browserKind === 'chrome' ? this.context.pages().find((p) => p.url() === 'about:blank' || p.url().startsWith('chrome://')) : null;
    this.page = existing || await this.context.newPage();
    this._watchPage(this.page);
    // New tabs and pop-ups: manual mode keeps them (the user drives, e.g. Google sign-in) and the recording
    // follows whichever tab is in use; AI mode folds them back into the recorded page.
    this.context.on('page', async (popup) => {
      if (!this.page || popup === this.page) return;
      if (this.popups === 'keep') {
        this._watchPage(popup);
        // A new tab opened from the page the user is on: follow it. Sign-in windows (Google, Microsoft…) are followed too
        // unless the user turned that off; passwords always show as dots.
        await popup.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
        if (!popup.isClosed() && (this.followSignIn || !isIdentityProvider(popup.url()))) this.switchTo(popup).catch(() => {});
        return;
      }
      try {
        if (isIdentityProvider(popup.url())) { this.log('A sign-in pop-up opened; closing it (the AI does not sign in).'); await popup.close().catch(() => {}); return; }
        await popup.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        const url = popup.url();
        await popup.close().catch(() => {});
        if (url && url !== 'about:blank' && this.page && !this.page.isClosed()) {
          this.log(`Pop-up redirected into the recorded page: ${url}`);
          await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
        }
      } catch { /* ignore */ }
    });
    this.cdp = await this._cdpFor(this.page);
    return this;
  }

  /** One CDP session per page. Playwright Chromium gets emulation from its context; My Chrome stays unmodified. */
  async _cdpFor(page) {
    if (this.cdps.has(page)) return this.cdps.get(page);
    const cdp = await this.context.newCDPSession(page);
    this.cdps.set(page, cdp);
    await cdp.send('Page.enable').catch(() => {});
    return cdp;
  }

  _watchPage(page) {
    page.on('crash', () => { if (page === this.page) this._onGone('The page crashed'); });
    page.on('close', () => this._onPageClosed(page));
    page.on('framenavigated', (frame) => { if (page === this.page && frame === page.mainFrame()) this.emit('navigated', frame.url()); });
    page.on('dialog', async (dialog) => {
      this.log(`Dialog (${dialog.type()}): ${dialog.message().slice(0, 120)}`);
      // Accept benign dialogs so a run is not stuck; prompts get an empty answer.
      try { await (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()); } catch { /* noop */ }
    });
  }

  async _onPageClosed(page) {
    if (this.closed) return;
    const remaining = this.context ? this.context.pages().filter((p) => !p.isClosed()) : [];
    if (page !== this.page) return; // a background tab closed: nothing to do
    if (remaining.length) {
      const byRecent = remaining.slice().sort((a, b) => (this.activity?.get(b) || 0) - (this.activity?.get(a) || 0));
      await this.switchTo(byRecent[0]); return;
    }
    this._onGone('The tab was closed');
  }

  /** Proves the in-page input detector works on the current page (it reports back as a 'selftest' event). */
  async selfTestActivity() {
    try { await this.page.evaluate(() => (typeof window.__motvinActivity === 'function' ? window.__motvinActivity('selftest') : null)); return true; } catch { return false; }
  }

  async bringToFront() { try { await this.page.bringToFront(); return true; } catch { return false; } }

  /** Makes another tab the recorded one. */
  async switchTo(page) {
    if (!page || page === this.page || page.isClosed()) return false;
    const cdp = await this._cdpFor(page);
    this.page = page; this.cdp = cdp;
    this.log(`Following the active tab: ${page.url()}`);
    this.emit('page-changed', { page, cdp });
    this.emit('navigated', page.url());
    return true;
  }

  async navigate(rawUrl, { timeout = 30000 } = {}) {
    const url = normalizeUrl(rawUrl);
    this.startOrigin = new URL(url).origin;
    this.startUrl = url;
    try {
      const resp = await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout });
      if (resp && resp.status() >= 400) this.log(`Site answered HTTP ${resp.status()} for ${url}`);
      return { url: this.page.url(), status: resp ? resp.status() : null };
    } catch (err) {
      const msg = String(err.message || err);
      // A page that redirects itself during load (sign-in pages do) aborts the first request; that is not a failure.
      if (/net::ERR_ABORTED|interrupted by another navigation/.test(msg)) {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const landed = this.currentUrl();
          if (landed && !landed.startsWith('about:') && !landed.startsWith('chrome-error')) return { url: landed, status: null };
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (/net::ERR_NAME_NOT_RESOLVED/.test(msg)) throw new NavigationError(`Could not resolve ${new URL(url).hostname}. Check the address and your network connection.`, err);
      if (/net::ERR_CONNECTION_REFUSED/.test(msg)) throw new NavigationError(`${new URL(url).host} refused the connection. Is the site running?`, err);
      if (/net::ERR_INTERNET_DISCONNECTED|net::ERR_NETWORK/.test(msg)) throw new NavigationError('No network connection.', err);
      if (/net::ERR_CERT/.test(msg)) throw new NavigationError('The site has an invalid HTTPS certificate.', err);
      if (/Timeout/i.test(msg)) throw new NavigationError(`The site did not finish loading within ${Math.round(timeout / 1000)} seconds. It may be slow or unavailable.`, err);
      throw new NavigationError(`Navigation failed: ${msg.split('\n')[0]}`, err);
    }
  }

  currentUrl() { try { return this.page?.url() || null; } catch { return null; } }
  async title() { try { return await this.page.title(); } catch { return ''; } }

  /** Same site = same registrable domain (sub.example.com ≈ example.com). */
  isSameSite(url) {
    try {
      const a = new URL(url).hostname.split('.').slice(-2).join('.');
      const b = new URL(this.startOrigin).hostname.split('.').slice(-2).join('.');
      return a === b;
    } catch { return false; }
  }

  /** Remote input from the UI preview (coordinates in viewport pixels). */
  async input(ev) {
    const p = this.page;
    if (!p || p.isClosed()) throw new Error('Browser is not open');
    switch (ev.type) {
      case 'click': await p.mouse.click(ev.x, ev.y, { button: ev.button || 'left', clickCount: ev.clickCount || 1 }); break;
      case 'move': await p.mouse.move(ev.x, ev.y); break;
      case 'wheel': await p.mouse.move(ev.x, ev.y); await p.mouse.wheel(ev.deltaX || 0, ev.deltaY || 0); break;
      case 'key': await p.keyboard.press(ev.key); break;
      case 'type': await p.keyboard.type(String(ev.text || '')); break;
      case 'focus': await p.bringToFront(); break;
      case 'goto': await p.goto(normalizeUrl(ev.url), { waitUntil: 'domcontentloaded', timeout: 30000 }); break;
      case 'back': await p.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}); break;
      case 'forward': await p.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}); break;
      case 'reload': await p.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); break;
      default: throw new Error(`Unknown input type ${ev.type}`);
    }
  }

  _onGone(reason) {
    if (this.closed) return;
    this.closed = true;
    this.emit('gone', reason);
  }

  async close() {
    this.closed = true;
    const withTimeout = (p, ms) => Promise.race([Promise.resolve(p).catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
    const browser = this.browser;
    try { if (this.cdp) await withTimeout(this.cdp.detach(), 1500); } catch { /* noop */ }
    if (this.browserKind === 'chrome') {
      // Ask Chrome to quit itself so the profile (cookies, sign-in) is flushed to disk.
      try { const bs = await browser?.newBrowserCDPSession(); await withTimeout(bs?.send('Browser.close'), 3000); } catch { /* noop */ }
      await withTimeout(new Promise((resolve) => { if (!this.chromeProc || this.chromeProc.exitCode !== null) resolve(); else this.chromeProc.once('exit', resolve); }), 6000);
      this._killChrome();
    } else {
      try { if (this.context) await withTimeout(this.context.close(), 6000); } catch { /* noop */ }
      try { if (browser) await withTimeout(browser.close(), 6000); } catch { /* noop */ }
      // A navigation or dialog can keep Chromium from closing politely; make sure the process is gone.
      try { if (browser && browser.isConnected()) browser.process()?.kill('SIGKILL'); } catch { /* noop */ }
    }
    this.browser = null; this.context = null; this.page = null; this.cdp = null; this.chromeProc = null;
  }
}
