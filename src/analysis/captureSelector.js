// Chooses the clean screens from the browser's own captures.
//
// While recording, a capture is taken every time the page settles (paints, then stops changing). Each capture is a
// candidate screen. We drop only what is genuinely not a screen of its own:
//   - blank frames and loading skeletons,
//   - a state the page was still loading (the same URL settled again with no click, key or scroll in between),
//   - exact repeats of a screen already kept.
// Everything else stays, including small but meaningful changes on the same page: a field filled in, an error message,
// a menu or dialog opening. That is what makes a sign-in flow (typing on one URL) come through as separate screens.
import path from 'node:path';
import { computeFeatures, hamming, changedFraction } from './imageFeatures.js';
import { cleanTitle } from '../agent/planner.js';
import { nameFromUrl } from './flowAnalyzer.js';

/** Same URL: pixels differing by less than this fraction (at 320 px width) is the same state (a blinking caret). A few
 *  password dots or one error line is well above it. */
export const SAME_STATE_CHANGED = 0.0004;
export const MAX_SCREENS = 200;

const urlKey = (u) => { try { const x = new URL(u); x.hash = ''; return x.origin + x.pathname.replace(/\/+$/, '') + x.search; } catch { return u || ''; } };
const isLoadingTitle = (t) => !t || /^loading\b/i.test(t) || /^https?:\/\//i.test(t) || t === 'about:blank';
const median = (a) => { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };

/** The agent/observation label closest before `ms` (AI recordings name their screens as they discover them). */
function labelBefore(ms, list, windowMs = 2500) {
  let best = null;
  for (const e of list) if (e.recordedMs <= ms + 300 && ms - e.recordedMs <= windowMs && (!best || e.recordedMs > best.recordedMs)) best = e;
  return best;
}

/**
 * @param {object} p
 * @param {Array} p.settled settled events that have a capture file
 * @param {string} p.recordingDir
 * @param {number[]|undefined} p.activity timestamps (ms) of real clicks, keys and scrolls
 * @param {boolean} p.activityTracked whether the input detector was proven to work in this recording
 * @param {Array} p.agentScreens screens named by the AI agent
 * @param {Array} p.observations
 * @param {number} p.durationMs
 */
export async function selectFromCaptures({ settled, recordingDir, activity, activityKinds, activityTracked, agentScreens = [], observations = [], durationMs }) {
  const evs = settled.filter((e) => e.file).slice().sort((a, b) => a.recordedMs - b.recordedMs);
  const feats = [];
  for (const ev of evs) { try { feats.push(await computeFeatures(path.join(recordingDir, ev.file))); } catch { feats.push(null); } }
  const edges = feats.filter(Boolean).map((f) => f.edge).filter((e) => e > 0);
  const medianEdge = median(edges) || 1;
  const dropped = { blank: 0, loading: 0, stillLoading: 0, duplicate: 0, unreadable: 0 };
  const kept = []; // {ev, f, dupCount}
  const decisions = [];
  const note = (ev, action, reason) => decisions.push({ at: ev.recordedMs, frameAt: ev.lastFrameMs, url: ev.url, action, reason });
  const canJudgeLoading = activityTracked === true && Array.isArray(activity);

  for (let i = 0; i < evs.length; i++) {
    const ev = evs[i]; const f = feats[i];
    if (!f) { dropped.unreadable++; note(ev, 'dropped', 'unreadable capture'); continue; }
    if (f.blank) { dropped.blank++; note(ev, 'dropped', 'blank frame'); continue; }
    if (f.pale > 0.45 && f.edge < medianEdge * 0.5) { dropped.loading++; note(ev, 'dropped', 'loading placeholder'); continue; } // skeleton / placeholder
    // Still loading: the same page settled again with nobody touching it in between.
    if (canJudgeLoading) {
      let next = null;
      for (let j = i + 1; j < evs.length; j++) { if (feats[j] && !feats[j].blank) { next = evs[j]; break; } }
      if (next && urlKey(next.url) === urlKey(ev.url) && !activity.some((t) => t > ev.recordedMs - 150 && t < next.recordedMs)) { dropped.stillLoading++; note(ev, 'dropped', 'page still loading (settled again with no input)'); continue; }
    }
    // Exact repeat of a screen we already kept (same URL: nearly identical pixels; other URL: identical pixels).
    let dupOf = null;
    for (let k = kept.length - 1; k >= 0; k--) {
      const q = kept[k];
      const sameUrl = urlKey(q.ev.url) === urlKey(ev.url);
      if (sameUrl ? changedFraction(q.f.fine, f.fine, 24) < SAME_STATE_CHANGED : (hamming(q.f.dhash, f.dhash) <= 4 && changedFraction(q.f.detail, f.detail, 16) < 0.004)) { dupOf = q; break; }
    }
    if (dupOf) { dropped.duplicate++; dupOf.dupCount = (dupOf.dupCount || 0) + 1; note(ev, 'dropped', `repeat of the screen at ${dupOf.ev.lastFrameMs} ms`); continue; }
    if (kept.length >= MAX_SCREENS) break;
    kept.push({ ev, f, dupCount: 0 }); note(ev, 'kept', 'new state');
  }

  // Names: the AI's own label if there is one, else the page title, else the URL.
  const nameCounts = new Map(); const screens = [];
  kept.forEach((k, idx) => {
    const { ev, f } = k;
    const timeMs = ev.lastFrameMs ?? ev.recordedMs;
    const agent = labelBefore(timeMs, agentScreens, 4000);
    let host = ''; try { host = new URL(ev.url || '').hostname; } catch { /* no url */ }
    const titleName = !isLoadingTitle(ev.title) ? cleanTitle(ev.title, host) : '';
    let isHome = false; try { const pth = new URL(ev.url).pathname.replace(/\/+$/, ''); isHome = !pth || /^\/(index|default|home)\.(html?|php|aspx?)$/i.test(pth); } catch { /* no url */ }
    let name = agent?.name || (isHome ? 'Home' : titleName) || nameFromUrl(ev.url) || `Screen ${idx + 1}`;
    // A later state of the same page: say what the user did to get there.
    const prev = kept[idx - 1];
    if (!agent && prev && urlKey(prev.ev.url) === urlKey(ev.url) && Array.isArray(activity)) {
      const from = prev.ev.lastFrameMs ?? prev.ev.recordedMs; const kinds = new Set();
      activity.forEach((t, i) => { if (t > from - 100 && t <= ev.recordedMs) kinds.add(activityKinds?.[i] || 'c'); });
      const how = kinds.has('k') ? 'typing' : kinds.has('w') ? 'scrolled' : kinds.has('c') ? 'after click' : '';
      if (how) name = `${name} · ${how}`;
    }
    const count = (nameCounts.get(name) || 0) + 1; nameCounts.set(name, count);
    const nextTime = kept[idx + 1] ? (kept[idx + 1].ev.lastFrameMs ?? kept[idx + 1].ev.recordedMs) : durationMs;
    screens.push({
      id: `screen-${String(idx + 1).padStart(2, '0')}`,
      name: count > 1 ? `${name} (${count})` : name, baseName: name,
      captureFile: ev.file, timeMs, holdMs: Math.max(0, Math.min(nextTime - timeMs, durationMs - timeMs)),
      url: ev.url || null, action: null, quality: Math.round(f.edge * 10) / 10, source: 'browser-capture', width: f.width, height: f.height,
      repeats: k.dupCount || 0,
    });
  });
  return { screens, dropped, evaluated: evs.length, decisions };
}
