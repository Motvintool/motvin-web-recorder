// Groups consecutive near-identical frames into "holds" and finds holds that revisit an earlier screen.
import { hamming, meanAbsDiff, inkMatch, changedFraction } from './imageFeatures.js';

export const SAME_HOLD_MAD = 3.5;
export const SAME_HOLD_HAMMING = 10;
export const SAME_HOLD_CHANGED = 0.012;
export const REVISIT_HAMMING = 12;
export const REVISIT_MAD = 6;
export const REVISIT_INK = 0.78;

/** Strips fragments and trailing slashes so the same page compares equal. */
export function urlKey(url) {
  if (!url) return null;
  try { const u = new URL(url); u.hash = ''; return `${u.origin}${u.pathname.replace(/\/+$/, '') || '/'}${u.search}`; } catch { return url; }
}

/**
 * @param {Array<{index:number, timeMs:number, features:object}>} frames
 * @returns {Array<{id:string, start:number, end:number, frames:number[], durationMs:number}>}
 */
export function groupHolds(frames, intervalMs) {
  const holds = [];
  let current = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const prev = i > 0 ? frames[i - 1] : null;
    const same = prev
      && meanAbsDiff(prev.features.thumb, f.features.thumb) < SAME_HOLD_MAD
      && hamming(prev.features.dhash, f.features.dhash) <= SAME_HOLD_HAMMING
      && changedFraction(prev.features.detail, f.features.detail, 24) < SAME_HOLD_CHANGED;
    if (same && current) { current.end = i; current.frames.push(i); }
    else { current = { id: `h${holds.length + 1}`, start: i, end: i, frames: [i] }; holds.push(current); }
  }
  for (const h of holds) h.durationMs = h.frames.length * intervalMs;
  return holds;
}

/**
 * Same screen test for two frames. When both URLs are known and differ, only an essentially
 * pixel-identical frame counts (two different list pages share layout but not content).
 */
export function sameScreen(a, b, urlA = null, urlB = null) {
  const sameUrl = urlA && urlB ? urlA === urlB : null;
  if (sameUrl === false) return hamming(a.dhash, b.dhash) <= 4 && changedFraction(a.detail, b.detail, 16) < 0.004;
  if (hamming(a.dhash, b.dhash) > REVISIT_HAMMING) return false;
  if (meanAbsDiff(a.thumb, b.thumb) > REVISIT_MAD) return false;
  if (inkMatch(a.ink, b.ink) < REVISIT_INK) return false;
  return changedFraction(a.detail, b.detail, 20) < (sameUrl ? 0.03 : 0.015);
}

/** Marks each hold's `duplicateOf` (an earlier hold id) when it revisits a screen already seen. */
export function markRevisits(holds, frames) {
  const kept = [];
  for (const h of holds) {
    if (h.kind && h.kind !== 'screen') continue;
    const feat = frames[h.rep].features;
    const matchIdx = kept.findIndex((k) => sameScreen(frames[k.rep].features, feat, urlKey(k.url), urlKey(h.url)));
    if (matchIdx < 0) { kept.push(h); continue; }
    const match = kept[matchIdx];
    // Prefer the better-drawn, longer-held version as the canonical screen: a page that is still
    // hydrating produces a short early hold that the fully loaded one should absorb.
    const better = h.durationMs >= match.durationMs * 1.2 && (h.quality ?? 0) >= (match.quality ?? 0) - 1 && !match.settled;
    if (better) {
      match.duplicateOf = h.id; match.reason = 'earlier, less complete version of this screen';
      for (const other of holds) if (other.duplicateOf === match.id) other.duplicateOf = h.id;
      kept[matchIdx] = h;
    } else {
      h.duplicateOf = match.id;
    }
  }
  return holds;
}
