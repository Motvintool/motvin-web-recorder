// The AI explorer: observe → understand → decide → act, with pause/resume, limits and
// blocked-path handling. Emits events the UI shows live and that the frame pipeline uses later
// to label screens in the video.
import { EventEmitter } from 'node:events';
import { snapshotPage } from './pageSnapshot.js';
import { waitForStableUI } from './stability.js';
import { StateTracker } from './stateTracker.js';
import { detectBlocked } from './blocked.js';
import { planCandidates, describeScreen } from './planner.js';
import { AI_DEFAULTS } from '../config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ExplorationAgent extends EventEmitter {
  /**
   * @param {object} opts
   * @param {import('../browser/browserController.js').BrowserSession} opts.session
   * @param {import('../recording/screencastRecorder.js').ScreencastRecorder} opts.recorder
   * @param {{brain: object, fallback: object}} opts.brains
   * @param {object} [opts.limits]
   */
  constructor({ session, recorder, brains, limits = {}, log = () => {} }) {
    super();
    this.session = session;
    this.recorder = recorder;
    this.brain = brains.brain;
    this.fallback = brains.fallback;
    this.limits = { ...AI_DEFAULTS, ...limits };
    this.log = log;
    this.tracker = new StateTracker();
    this.screens = []; // {id, stateId, name, url, recordedMs, blocked, kind}
    this.steps = []; // {n, intent, type, label, url, recordedMs, ok, error}
    this.status = 'AI Ready';
    this.currentAction = '';
    this.currentScreen = '';
    this.paused = false;
    this.stopRequested = false;
    this.finished = false;
    this.startedAt = 0;
    this.brainFailures = 0;
    this.perState = new Map(); // stateId → {scrolls, searched, hovered:Set}
    this.searchedQueries = new Set();
    this._resumeResolvers = [];
    this.summary = null;
  }

  setStatus(status, extra = {}) {
    this.status = status;
    this.emit('status', { status, ...extra, ...this.progress() });
  }

  progress() {
    return {
      steps: this.steps.length,
      screens: this.screens.length,
      unique: this.tracker.uniqueCount,
      blocked: this.tracker.blockedCount,
      elapsedMs: this.startedAt ? Date.now() - this.startedAt : 0,
      currentAction: this.currentAction,
      currentScreen: this.currentScreen,
      currentUrl: this.session.currentUrl(),
      paused: this.paused,
      brain: this.brain.label,
    };
  }

  pause() {
    if (this.finished || this.paused) return false;
    this.paused = true;
    this.setStatus('Paused');
    this.log('AI paused — the browser is yours; the page and session are preserved.');
    return true;
  }

  resume() {
    if (!this.paused) return false;
    this.paused = false;
    for (const r of this._resumeResolvers.splice(0)) r();
    this.setStatus('Exploring');
    this.log('AI resumed from the current browser state.');
    return true;
  }

  stop(reason = 'Stopped by user') {
    if (this.finished) return false;
    this.stopRequested = reason;
    if (this.paused) this.resume();
    return true;
  }

  async _waitWhilePaused() {
    while (this.paused && !this.stopRequested) {
      await new Promise((resolve) => this._resumeResolvers.push(resolve));
    }
  }

  _limitReached() {
    const { maxMinutes, maxScreens, maxSteps } = this.limits;
    if (Date.now() - this.startedAt >= maxMinutes * 60 * 1000) return `Maximum exploration time (${maxMinutes} min) reached`;
    if (this.screens.filter((s) => !s.blocked).length >= maxScreens) return `Maximum number of screens (${maxScreens}) reached`;
    if (this.steps.length >= maxSteps) return `Maximum number of steps (${maxSteps}) reached`;
    return null;
  }

  /** Main loop. Resolves with a summary when exploration finishes for any reason. */
  async run() {
    this.startedAt = Date.now();
    let endReason = 'Exploration complete';
    try {
      // Opening dialogs (cookie consent etc.) are handled by the planner; nothing special here.
      let consecutiveFailures = 0;
      let lastStateId = null;
      let sameStateStreak = 0;
      while (!this.stopRequested) {
        await this._waitWhilePaused();
        if (this.stopRequested) break;
        const limit = this._limitReached();
        if (limit) { endReason = limit; break; }
        if (this.session.closed) { endReason = 'Browser closed'; break; }

        // 1. Wait for a stable UI.
        this.setStatus('Waiting for UI');
        const stability = await waitForStableUI(this.session.page, { recorder: this.recorder, timeoutMs: this.limits.stableTimeoutMs, shouldAbort: () => Boolean(this.stopRequested) || this.paused });
        if (this.paused) continue;
        if (this.stopRequested) break;
        if (!stability.stable) this.log(`UI did not fully settle (${stability.reason}); continuing with what is rendered.`);

        // Leaving the site (external link, redirect) → come back.
        const url = this.session.currentUrl();
        if (!url || url.startsWith('about:') || url.startsWith('chrome')) {
          this.log('Landed on an empty tab; returning to the start page.');
          await this._gotoStart();
          continue;
        }
        if (!this.session.isSameSite(url)) {
          this.log(`Left the site (${url}); going back.`);
          await this._goBack();
          continue;
        }

        // 2. Understand the page.
        let snapshot;
        try { snapshot = await snapshotPage(this.session.page); } catch (err) {
          if (this.session.closed) { endReason = 'Browser closed'; break; }
          this.log(`Could not read the page (${firstLine(err)}); retrying.`);
          if (++consecutiveFailures > 4) { endReason = 'The page could not be read repeatedly'; break; }
          await sleep(800);
          continue;
        }
        consecutiveFailures = 0;
        const recordedMs = this.recorder.recordedMs;
        const { state, isNew } = this.tracker.observe(snapshot, { recordedMs });
        const blocked = detectBlocked(snapshot);
        const screenName = this._screenName(snapshot, state);
        state.name = screenName;
        this.currentScreen = screenName;
        this.emit('observation', { stateId: state.id, isNew, url: snapshot.url, screenName, loading: snapshot.loading, blocked: blocked.blocked ? blocked.kind : null, stable: stability.stable });

        if (isNew || (blocked.blocked && !state.blocked)) {
          const screen = { id: `scr${this.screens.length + 1}`, stepIndex: this.steps.length, stateId: state.id, name: screenName, url: snapshot.url, title: snapshot.title, recordedMs, blocked: blocked.blocked ? blocked.kind : null, blockedLabel: blocked.label || null, kind: snapshot.modal ? 'dialog' : snapshot.signals.notFound ? 'error' : blocked.blocked ? 'blocked' : 'screen' };
          this.screens.push(screen);
          this.emit('screen', screen);
          this.log(`${blocked.blocked ? 'Blocked state' : 'New screen'}: ${screenName}${blocked.blocked ? ` (${blocked.label})` : ''}`);
        }

        // 3. Blocked path → mark and leave.
        if (blocked.blocked) {
          state.blocked = true;
          this.setStatus('Blocked', { blockedKind: blocked.kind });
          this.currentAction = `${blocked.label} — leaving this path`;
          await sleep(900); // let the recording show the screen for a moment
          if (blocked.inModal && !state.escapeTried) {
            state.escapeTried = true;
            this.log('Sign-in dialog — closing it and continuing elsewhere.');
            await this.session.page.keyboard.press('Escape').catch(() => {});
            await sleep(500);
            const still = await snapshotPage(this.session.page).catch(() => null);
            if (still && !detectBlocked(still).blocked) continue;
          }
          if (this.tracker.history.length > 1) await this._goBack(); else { endReason = `The start page requires ${blocked.label.toLowerCase()}. Pause here and sign in manually, or record this site in Manual mode.`; break; }
          continue;
        }

        // Cookie / consent banners: dismiss once, preferring the privacy-preserving choice.
        if (!this.consentHandled) {
          const consent = snapshot.elements.filter((e) => e.inConsent && ['button', 'link', 'clickable'].includes(e.kind) && e.inViewport);
          if (consent.length) {
            const pick = consent.find((e) => /\b(reject|decline|refuse|deny|necessary|essential|only required|disagree)\b/i.test(e.name))
              || consent.find((e) => /^(close|dismiss|×|✕|x|got it|ok|okay|continue)$/i.test(e.name))
              || consent.find((e) => /\b(accept|agree|allow|got it|understand)\b/i.test(e.name));
            if (pick) {
              this.consentHandled = true;
              const intent = 'Dismissing the cookie banner';
              this.currentAction = intent; this.emit('action', { intent, type: 'click', label: pick.name, url: snapshot.url }); this.log(`→ ${intent} (“${pick.name}”)`);
              const step = { n: this.steps.length + 1, intent, type: 'click', label: pick.name, url: snapshot.url, recordedMs: this.recorder.recordedMs, ok: true };
              try { await this.session.page.locator(`[data-motvin-id="${pick.id}"]`).first().click({ timeout: 4000 }); } catch (err) { step.ok = false; step.error = firstLine(err); }
              this.steps.push(step); this.emit('step', step);
              await sleep(400);
              continue;
            }
          }
        }

        // Loop guard: arriving at the same state over and over, or acting on it without anything changing.
        if (state.id === lastStateId) sameStateStreak++; else { sameStateStreak = 0; state.arrivals = (state.arrivals || 0) + 1; }
        lastStateId = state.id;
        if ((state.arrivals || 0) > this.limits.maxRevisits + 1 || sameStateStreak >= 4) {
          if (!state.exhausted) this.log(`“${screenName}” keeps coming back — treating this path as explored.`);
          state.exhausted = true;
        }
        const recent = this.steps.slice(-6);
        if (recent.length === 6 && recent.every((st) => st.type === 'back') ) { endReason = 'Nothing new is reachable from here'; break; }
        const lastNewScreenStep = this.screens.length ? this.steps.length - this.screens.at(-1).stepIndex : 0;
        if (this.screens.length > 0 && lastNewScreenStep >= 12) { endReason = 'No new screens found in the last 12 steps'; break; }

        // 4. Decide.
        this.setStatus('Exploring');
        const ps = this._perState(state.id);
        const candidates = planCandidates(snapshot, { tracker: this.tracker, state, startOrigin: this.session.startOrigin, isSameSite: (u) => this.session.isSameSite(u), scrolledHere: ps.scrolls, searchedHere: ps.searched, hoveredHere: ps.hovered, searchedQueries: this.searchedQueries });
        const viable = candidates.filter((c) => c.score > -35 || c.type === 'back');
        if (viable.length === 0) { endReason = 'Nothing left to explore from here'; break; }
        if (!candidates.some((c) => c.type !== 'back' && c.score > -30)) state.exhausted = true;
        if (state.exhausted) {
          const back = candidates.find((c) => c.type === 'back');
          if (back) back.score = 999;
          else if (candidates.every((c) => c.score <= -30)) { endReason = 'Explored everything reachable from the start page'; break; }
          candidates.sort((a, b) => b.score - a.score);
        }
        const decision = await this._decide({ snapshot, candidates, state, screenName });
        if (this.paused || this.stopRequested) continue;
        const cand = candidates.find((c) => c.id === decision.candidateId) || candidates[0];
        // Model-provided names are only used when the page itself gives us nothing useful.
        if (decision.screenName && isNew && !state.renamed && /^(Page|Dialog dialog|Screen)$/i.test(screenName)) {
          state.name = decision.screenName; state.renamed = true;
          const scr = this.screens.find((s) => s.stateId === state.id); if (scr) { scr.name = decision.screenName; this.emit('screen', scr); }
          this.currentScreen = decision.screenName;
        }
        const intent = decision.intent || cand.intent;
        this.currentAction = intent;
        this.emit('action', { intent, type: cand.type, label: cand.label, href: cand.href, url: snapshot.url });
        this.log(`→ ${intent}`);

        // 5. Act.
        state.actionsTried.add(cand.targetKey);
        if (cand.type === 'scroll') ps.scrolls++;
        if (cand.type === 'search') { ps.searched = true; this.searchedQueries.add(cand.value); }
        if (cand.type === 'hover') ps.hovered.add(cand.targetKey);
        const step = { n: this.steps.length + 1, intent, type: cand.type, label: cand.label, url: snapshot.url, recordedMs: this.recorder.recordedMs, ok: true };
        try {
          await this._execute(cand, snapshot);
        } catch (err) {
          step.ok = false; step.error = firstLine(err);
          this.log(`Action failed (${step.error}); trying something else.`);
        }
        this.steps.push(step);
        this.emit('step', step);
        await sleep(350);
      }
      if (this.stopRequested) endReason = typeof this.stopRequested === 'string' ? this.stopRequested : 'Stopped by user';
    } catch (err) {
      endReason = `AI error: ${firstLine(err)}`;
      this.setStatus('Error', { error: endReason });
      this.log(endReason);
    }
    this.finished = true;
    this.currentAction = '';
    this.summary = {
      endReason,
      steps: this.steps.length,
      screens: this.screens.length,
      uniqueScreens: this.tracker.uniqueCount,
      blockedStates: this.tracker.blockedCount,
      brain: this.brain.label,
      brainFailures: this.brainFailures,
      elapsedMs: Date.now() - this.startedAt,
      flow: this.flowDescription(),
    };
    if (this.status !== 'Error') this.setStatus('Completed', { endReason });
    this.emit('done', this.summary);
    return this.summary;
  }

  /** Human-readable flow: the sequence of screens and what the user was doing in between. */
  flowDescription() {
    const items = [];
    for (const scr of this.screens) {
      items.push({ kind: 'screen', name: scr.name, url: scr.url, recordedMs: scr.recordedMs, blocked: scr.blocked });
    }
    const steps = this.steps.map((s) => ({ kind: 'action', name: s.intent, recordedMs: s.recordedMs, ok: s.ok }));
    return items.concat(steps).sort((a, b) => a.recordedMs - b.recordedMs);
  }

  _perState(id) {
    if (!this.perState.has(id)) this.perState.set(id, { scrolls: 0, searched: false, hovered: new Set() });
    return this.perState.get(id);
  }

  _screenName(snapshot, state) {
    if (state.name && !state.renamed) return describeScreen(snapshot);
    return state.name || describeScreen(snapshot);
  }

  async _decide(ctx) {
    const context = {
      snapshot: ctx.snapshot, candidates: ctx.candidates, screens: this.screens, recentSteps: this.steps,
      limits: this.limits, progress: this.progress(), state: ctx.state, screenName: ctx.screenName,
    };
    if (this.brain !== this.fallback && this.brainFailures < 3) {
      try {
        const d = await this.brain.decide(context);
        if (d && ctx.candidates.some((c) => c.id === d.candidateId)) return d;
        throw new Error('brain returned no valid candidate');
      } catch (err) {
        this.brainFailures++;
        this.log(`${this.brain.label} could not decide (${firstLine(err)}); using the built-in planner${this.brainFailures >= 3 ? ' from now on' : ''}.`);
        this.emit('brain-fallback', { failures: this.brainFailures, error: firstLine(err) });
      }
    }
    return this.fallback.decide(context);
  }

  async _execute(cand, snapshot) {
    const page = this.session.page;
    const locator = cand.elementId ? page.locator(`[data-motvin-id="${cand.elementId}"]`).first() : null;
    const navWait = () => page.waitForLoadState('domcontentloaded', { timeout: 6000 }).catch(() => {});
    switch (cand.type) {
      case 'click': {
        await locator.scrollIntoViewIfNeeded({ timeout: 2500 }).catch(() => {});
        if (!(await locator.isVisible().catch(() => false))) throw new Error('element is no longer visible');
        await this._hoverFirst(locator);
        // Links that open new tabs are redirected into this page by the session; plain clicks keep SPA behaviour.
        // Non-semantic pointer elements are often animated; don't wait for them to hold still.
        await locator.click(cand.kind === 'clickable' ? { timeout: 2000, force: true } : { timeout: 3500 });
        await navWait();
        break;
      }
      case 'hover': {
        await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await locator.hover({ timeout: 4000 });
        await sleep(900);
        break;
      }
      case 'focus': {
        await locator.click({ timeout: 4000 });
        break;
      }
      case 'search': {
        await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        await locator.click({ timeout: 4000 });
        await locator.fill('').catch(() => {});
        await page.keyboard.type(cand.value, { delay: 60 });
        await sleep(700); // let suggestions render (they are a screen too)
        await page.keyboard.press('Enter');
        await navWait();
        break;
      }
      case 'select': {
        await locator.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        const tag = await locator.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
        if (tag === 'select') {
          const count = await locator.evaluate((el) => el.options.length).catch(() => 0);
          if (count > 1) await locator.selectOption({ index: 1 }, { timeout: 4000 });
        } else {
          await locator.click({ timeout: 4000 });
          await sleep(600);
        }
        break;
      }
      case 'scroll': {
        const h = snapshot.viewport.height;
        await page.mouse.move(Math.round(snapshot.viewport.width / 2), Math.round(h / 2));
        for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, Math.round(h * 0.2)); await sleep(90); }
        break;
      }
      case 'escape': await page.keyboard.press('Escape'); break;
      case 'back': await this._goBack(); break;
      case 'forward': await page.goForward({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}); break;
      default: throw new Error(`Unknown action ${cand.type}`);
    }
  }

  async _hoverFirst(locator) {
    try { await locator.hover({ timeout: 1500 }); await sleep(120); } catch { /* fine */ }
  }

  async _goBack() {
    const page = this.session.page;
    const before = page.url();
    try {
      await page.goBack({ waitUntil: 'domcontentloaded', timeout: 15000 });
    } catch (err) {
      this.log(`Back navigation failed (${firstLine(err)}).`);
    }
    const now = page.url();
    if (now === before || !now || now.startsWith('about:') || now.startsWith('chrome') || !this.session.isSameSite(now)) await this._gotoStart();
  }

  async _gotoStart() {
    const page = this.session.page;
    const start = this.screens.find((s) => !s.blocked)?.url || this.session.startUrl;
    if (!start) return;
    if (page.url() === start) return;
    await page.goto(start, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch((err) => this.log(`Could not return to the start page (${firstLine(err)}).`));
  }
}

function firstLine(err) { return String(err && err.message ? err.message : err).split('\n')[0].slice(0, 160); }
