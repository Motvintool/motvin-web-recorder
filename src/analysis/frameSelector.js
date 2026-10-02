// Picks the cleanest frame of each hold: fully drawn, stable, no fade or placeholder.
import { meanAbsDiff } from './imageFeatures.js';

export function frameQuality(f) {
  let q = f.edge;
  if (f.blank) q -= 50;
  if (f.pale > 0.45) q -= 10;
  if (f.flat) q -= 15;
  return q;
}

/** Sets `rep` (frame index) on each hold. Prefers the latest frame in the longest still stretch. */
export function chooseRepresentatives(holds, frames) {
  for (const h of holds) {
    let best = h.frames[h.frames.length - 1]; let bestScore = -Infinity;
    for (let j = 0; j < h.frames.length; j++) {
      const idx = h.frames[j];
      const f = frames[idx].features;
      let score = frameQuality(f);
      // Stability bonus: identical to its neighbours inside the hold.
      const prev = j > 0 ? frames[h.frames[j - 1]].features : null;
      const next = j < h.frames.length - 1 ? frames[h.frames[j + 1]].features : null;
      if (prev && meanAbsDiff(prev.thumb, f.thumb) < 1.2) score += 3;
      if (next && meanAbsDiff(next.thumb, f.thumb) < 1.2) score += 3;
      score += j * 0.01; // later frames win ties (more content has arrived)
      if (score >= bestScore) { bestScore = score; best = idx; }
    }
    h.rep = best;
    h.quality = bestScore;
  }
  return holds;
}
