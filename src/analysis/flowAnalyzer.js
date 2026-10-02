// Turns kept holds + the agent's observations into named screens and a readable flow.
import { cleanTitle } from '../agent/planner.js';

/** The observation made while this hold was on screen (first one inside its time span), else the latest before it. */
function labelFor(startMs, endMs, events) {
  let inside = null;
  for (const e of events) {
    if (e.recordedMs >= startMs - 150 && e.recordedMs <= endMs + 400) { if (!inside || e.recordedMs < inside.recordedMs) inside = e; }
  }
  if (inside) return inside;
  let best = null;
  for (const e of events) if (e.recordedMs <= startMs + 150 && (!best || e.recordedMs > best.recordedMs)) best = e;
  return best;
}

/** Derives a name from a URL when no agent label exists (manual recordings). */
export function nameFromUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const q = u.searchParams.get('q') || u.searchParams.get('query') || u.searchParams.get('search') || u.searchParams.get('s');
    if (q) return `Search results for “${q}”`;
    const parts = u.pathname.split('/').filter(Boolean);
    if (!parts.length) return 'Home';
    let segs = parts.slice();
    if (/^(index|default|home)\.(html?|php|aspx?)$/i.test(segs.at(-1))) segs.pop();
    if (!segs.length) return 'Home';
    const last = decodeURIComponent(segs[segs.length - 1]).replace(/\.(html?|php|aspx?)$/i, '').replace(/[-_]+/g, ' ').replace(/\s+\d+$/, '').trim();
    if (!last || /^\d+$/.test(last)) { const prev = segs.length > 1 ? decodeURIComponent(segs[segs.length - 2]).replace(/[-_]+/g, ' ') : ''; return prev ? `${cap(prev)} detail` : 'Page'; }
    return cap(last.length > 40 ? `${last.slice(0, 38).trim()}…` : last);
  } catch { return null; }
}
const isPathHome = (url) => { try { const p = new URL(url).pathname.replace(/\/+$/, ''); return !p || /^\/(index|default|home)\.(html?|php|aspx?)$/i.test(p); } catch { return false; } };
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/**
 * @param {Array} holds classified, with rep and duplicateOf
 * @param {Array} frames
 * @param {{screens?:Array, steps?:Array, observations?:Array, mode:string, intervalMs?:number}} ctx
 */
export function buildScreens(holds, frames, { screens = [], steps = [], observations = [], mode, intervalMs = 300 }) {
  const result = [];
  let n = 0;
  const nameCounts = new Map();
  for (const h of holds) {
    if (h.kind !== 'screen' || h.duplicateOf) continue;
    const frame = frames[h.rep];
    const startMs = frames[h.start].timeMs; const endMs = frames[h.end].timeMs + intervalMs;
    const agentScreen = labelFor(startMs, endMs, screens);
    const obs = labelFor(startMs, endMs, observations.filter((o) => o.screenName));
    const step = (() => { let best = null; for (const s of steps) if (s.recordedMs <= startMs + 150 && (!best || s.recordedMs > best.recordedMs)) best = s; return best; })();
    const host = (() => { try { return new URL(h.url || '').hostname; } catch { return ''; } })();
    const titleName = h.title ? cleanTitle(h.title, host) : '';
    let name = agentScreen?.name || obs?.screenName || (isPathHome(h.url) ? 'Home' : titleName) || nameFromUrl(h.url) || null;
    if (!name) name = `Screen ${n + 1}`;
    const count = (nameCounts.get(name) || 0) + 1; nameCounts.set(name, count);
    const uniqueName = count > 1 ? `${name} (${count})` : name;
    n++;
    result.push({
      id: `screen-${String(n).padStart(2, '0')}`,
      name: uniqueName,
      baseName: name,
      holdId: h.id,
      frameIndex: h.rep,
      timeMs: frame.timeMs,
      holdMs: h.durationMs,
      url: h.url || obs?.url || agentScreen?.url || null,
      action: step?.intent || null,
      quality: Math.round((h.quality ?? 0) * 10) / 10,
      source: agentScreen || obs ? 'agent' : h.url ? 'url' : 'derived',
    });
  }
  const flow = [];
  for (const s of result) if (flow.at(-1) !== s.baseName) flow.push(s.baseName);
  return { screens: result, flow };
}
