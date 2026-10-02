// Classifies holds as transition / loading / blank / partial so they are never chosen as screens.
import { changedBox, inkMatch, meanAbsDiff } from './imageFeatures.js';

export function median(nums) { const a = nums.slice().sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : 0; }

/**
 * Mutates holds: sets `kind` ∈ screen | transition | loading | blank | partial, and `reason`.
 * @param {Array} holds (with frames[], durationMs)
 * @param {Array} frames (with features)
 * @param {{intervalMs:number, observations?:Array<{recordedMs:number, loading:{indicators:number, pendingImages:number}}>}} ctx
 */
export function classifyHolds(holds, frames, { intervalMs, observations = [], settledAvailable = false }) {
  const edges = holds.map((h) => median(h.frames.map((i) => frames[i].features.edge)));
  const medianEdge = median(edges.filter((e) => e > 0)) || 1;
  const briefMs = Math.max(2 * intervalMs, 450);
  for (let k = 0; k < holds.length; k++) {
    const h = holds[k];
    const feats = h.frames.map((i) => frames[i].features);
    const rep = feats[feats.length - 1];
    const edge = edges[k];
    h.edge = edge;
    h.kind = 'screen';
    if (feats.every((f) => f.blank)) { h.kind = 'blank'; h.reason = 'near-solid frame'; continue; }
    // With browser captures available, any screen that stayed put for ~half a second produced one.
    // A short hold that never settled is a frame from the middle of a load or animation.
    if (settledAvailable && !h.settled && h.durationMs <= 2 * intervalMs && k > 0) {
      h.kind = holds[k + 1] && holds[k + 1].url === h.url ? 'partial' : 'transition';
      h.reason = h.kind === 'partial' ? 'still painting (never settled), page completes next' : 'never settled (mid-load or mid-animation frame)';
      continue;
    }
    // Brief hold squeezed between two different holds: a mid-animation / mid-navigation frame.
    if (h.durationMs <= briefMs && !h.settled && k > 0 && k < holds.length - 1) {
      const prev = frames[holds[k - 1].frames.at(-1)].features;
      const next = frames[holds[k + 1].frames[0]].features;
      const dPrev = meanAbsDiff(prev.thumb, rep.thumb); const dNext = meanAbsDiff(rep.thumb, next.thumb);
      if (dPrev > 3 && dNext > 3) { h.kind = 'transition'; h.reason = 'brief frame between two screens'; continue; }
    }
    // Skeleton / placeholder: lots of pale blocks, little real detail.
    if (rep.pale > 0.45 && edge < medianEdge * 0.55) { h.kind = 'loading'; h.reason = 'skeleton-like placeholder'; continue; }
    // Spinner: frames keep changing in one small area while everything else is still.
    if (feats.length >= 2) {
      let spinnerish = 0;
      for (let i = 1; i < feats.length; i++) {
        const box = changedBox(feats[i - 1].thumb, feats[i].thumb, rep.thumbW, rep.thumbH, 20);
        if (box && box.area < 0.08 && box.count > 0.0005) spinnerish++;
      }
      if (spinnerish >= Math.max(1, Math.floor((feats.length - 1) * 0.6)) && edge < medianEdge * 0.8) { h.kind = 'loading'; h.reason = 'spinner-like local motion'; continue; }
    }
    // Low-detail page that the agent saw with loading indicators at that time.
    const obs = observations.filter((o) => Math.abs(o.recordedMs - frames[h.frames[0]].timeMs) < 1200);
    if (!h.settled && obs.some((o) => (o.loading?.indicators || 0) > 0 || (o.loading?.pendingImages || 0) > 0) && edge < medianEdge * 0.6) { h.kind = 'loading'; h.reason = 'loading indicator observed'; continue; }
    if (!h.settled && edge < medianEdge * 0.22 && h.durationMs < 2000) { h.kind = 'loading'; h.reason = 'almost no rendered detail'; continue; }
  }
  // Partial render (b): a short hold whose content area is mostly empty while a longer hold of the
  // same page (same URL, or an immediate neighbour) is not — the header has painted, the rest has not.
  for (let k = 0; k < holds.length; k++) {
    const h = holds[k];
    if (h.kind !== 'screen' || h.settled || h.durationMs > 1500) continue;
    const rep = frames[h.rep].features;
    if (rep.blankRows < 0.45) continue;
    if (!h.url) continue; // without URL knowledge this rule is too risky on airy layouts
    const peers = holds.filter((n) => n !== h && n.kind === 'screen' && n.durationMs > h.durationMs && n.url === h.url);
    if (peers.some((n) => frames[n.rep].features.blankRows < rep.blankRows - 0.15)) { h.kind = 'partial'; h.reason = 'content area still empty (page not finished rendering)'; }
  }
  // Partial render: a hold immediately followed by the same layout with clearly more detail.
  for (let k = 0; k < holds.length - 1; k++) {
    const h = holds[k]; const n = holds[k + 1];
    if (h.kind !== 'screen' || n.kind !== 'screen' || h.settled) continue;
    const a = frames[h.rep].features; const b = frames[n.rep].features;
    if (inkMatch(a.ink, b.ink) > 0.6 && n.edge > h.edge * 1.12 && h.durationMs < 2500 && n.durationMs >= h.durationMs) { h.kind = 'partial'; h.reason = 'content still arriving (next frame has more detail)'; }
  }
  return holds;
}
