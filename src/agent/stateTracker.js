// Remembers which screens/states have been seen so exploration does not loop.
// A state = normalised URL + structural signature of the visible interactive elements.

const VOLATILE_PARAMS = /^(utm_|fbclid|gclid|ref$|_ga|sessionid|sid$|token|ts$|t$|_t$|cache)/i;

export function normalizeUrlForState(url) {
  try {
    const u = new URL(url);
    const params = new URLSearchParams();
    for (const [k, v] of Array.from(u.searchParams.entries()).sort()) if (!VOLATILE_PARAMS.test(k)) params.set(k, v);
    const search = params.toString();
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.origin}${path}${search ? `?${search}` : ''}`;
  } catch { return url; }
}

function tokenSet(snapshot) {
  const set = new Set();
  for (const el of snapshot.elements) {
    if (!el.inViewport) continue;
    set.add(`${el.kind}:${el.name.toLowerCase().slice(0, 40)}`);
  }
  for (const h of snapshot.headings) set.add(`h:${h.text.toLowerCase().slice(0, 50)}`);
  if (snapshot.modal) set.add(`modal:${snapshot.modalTitle.toLowerCase()}`);
  return set;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export class StateTracker {
  constructor({ similarityThreshold = 0.82 } = {}) {
    this.states = []; // {id, urlKey, tokens, name, visits, firstSeenAt, actionsTried:Set, blocked, scrollBucket}
    this.threshold = similarityThreshold;
    this.history = []; // state ids in order visited
  }

  /** Finds the existing state matching the snapshot or registers a new one. */
  observe(snapshot, { recordedMs = 0 } = {}) {
    const urlKey = normalizeUrlForState(snapshot.url);
    const tokens = tokenSet(snapshot);
    const scrollBucket = Math.round((snapshot.scroll.y || 0) / Math.max(1, snapshot.viewport.height * 0.8));
    let best = null; let bestScore = 0;
    for (const s of this.states) {
      if (s.urlKey !== urlKey) continue;
      if (s.modal !== snapshot.modal) continue;
      if (s.scrollBucket !== scrollBucket) continue;
      const score = jaccard(s.tokens, tokens);
      if (score > bestScore) { bestScore = score; best = s; }
    }
    if (best && bestScore >= this.threshold) {
      best.visits++;
      best.tokens = tokens; // keep the latest view of it
      this.history.push(best.id);
      return { state: best, isNew: false, similarity: bestScore };
    }
    const state = {
      id: `s${this.states.length + 1}`,
      urlKey, url: snapshot.url, tokens, modal: snapshot.modal, scrollBucket,
      title: snapshot.title, h1: snapshot.h1,
      visits: 1, firstSeenAt: Date.now(), recordedMs, actionsTried: new Set(), blocked: false, exhausted: false,
    };
    this.states.push(state);
    this.history.push(state.id);
    return { state, isNew: true, similarity: best ? bestScore : 0 };
  }

  get uniqueCount() { return this.states.length; }
  get blockedCount() { return this.states.filter((s) => s.blocked).length; }
  get previousStateId() { return this.history.length >= 2 ? this.history[this.history.length - 2] : null; }
  byId(id) { return this.states.find((s) => s.id === id) || null; }

  /** Has this URL (normalised) been visited as any state already? */
  visitedUrl(url) {
    const key = normalizeUrlForState(url);
    return this.states.some((s) => s.urlKey === key);
  }

  /** Number of times the last N history entries repeat the same state (loop detection). */
  recentRepeats(stateId, window = 6) {
    return this.history.slice(-window).filter((id) => id === stateId).length;
  }
}
