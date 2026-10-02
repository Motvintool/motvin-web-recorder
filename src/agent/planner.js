// Heuristic UX-researcher planner. Turns a page snapshot + exploration history into a ranked
// list of candidate actions with human-readable intents. Used directly as the "heuristic" brain
// and as the shortlist that the LLM brains choose from.
import { DESTRUCTIVE_RE, AUTH_RE } from './blocked.js';
import { normalizeUrlForState } from './stateTracker.js';

const IMPORTANT = [
  [/\b(search|find|look ?up)\b/i, 30, 'search'],
  [/\b(home|dashboard|overview|feed|explore|discover|browse|catalog(ue)?|all (products|items|courses|articles|jobs|listings|templates|icons|logos|inspirations))\b/i, 22, 'home'],
  [/\b(products?|pricing|plans|features?|solutions?|services?|templates?|collections?|categories|categor(y|ies)|gallery|portfolio|projects?|docs?|documentation|guides?|tutorials?|blog|news|articles?|stories|library|resources?|examples?|showcase|marketplace|store|shop|menu|courses?|jobs?|listings?|events?|community|forum|inspirations?|icons?|logos?)\b/i, 18, 'section'],
  [/\b(profile|account|settings|preferences|my (account|profile|orders|library|favou?rites|saved|list))\b/i, 17, 'account'],
  [/\b(details?|view (all|more)|see (all|more|details)|learn more|read more|open|explore|more info|show (all|more))\b/i, 14, 'detail'],
  [/\b(filters?|sort( by)?|refine|advanced)\b/i, 12, 'filter'],
  [/\b(create|new|add|compose|write|start|upload|import|generate|build|try( it)?( now| free)?|demo|playground|editor)\b/i, 12, 'create'],
  [/\b(notifications?|inbox|messages?|chat|alerts?|activity|history|recent)\b/i, 11, 'section'],
  [/\b(about( us)?|team|careers|contact( us)?|help|support|faq|changelog|roadmap|status|press|partners)\b/i, 6, 'info'],
  [/\b(next|previous|page \d+|load more|show more|more)\b/i, 5, 'pagination'],
];

const LOW_VALUE = /\b(terms|privacy|cookie|legal|licen[cs]e|imprint|impressum|sitemap|accessibility statement|copyright|©)\b/i;

export function describeScreen(snapshot) {
  const url = new URL(snapshot.url);
  const q = url.searchParams.get('q') || url.searchParams.get('query') || url.searchParams.get('search') || url.searchParams.get('s') || url.searchParams.get('keyword');
  if (snapshot.modal) return `${cleanTitle(snapshot.modalTitle, url.hostname) || 'Dialog'} dialog`;
  if (q) return `Search results for “${q}”`;
  const path = url.pathname.replace(/\/+$/, '');
  if (!path || path === '/') return 'Home';
  const title = cleanTitle(snapshot.h1, url.hostname) || cleanTitle(snapshot.title, url.hostname);
  if (title) return title;
  const last = decodeURIComponent(path.split('/').filter(Boolean).pop() || '').replace(/[-_]+/g, ' ');
  return last ? capitalize(last) : 'Page';
}

/** "Motvin Icons: A complete icon toolkit…" → "Icons"; "Pricing | Acme" → "Pricing". */
export function cleanTitle(title, hostname = '') {
  const raw = String(title || '').replace(/\s+/g, ' ').trim();
  if (!raw) return '';
  const brand = hostname.replace(/^www\./, '').split('.')[0];
  const brandRe = brand && brand.length > 2 ? new RegExp(`\\b${brand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i') : null;
  let segments = raw.split(/\s*[|–—:·•»]\s*|\s[-]\s/).map((x) => x.trim()).filter(Boolean);
  if (segments.length > 1 && brandRe) {
    const withoutBrandOnly = segments.filter((seg) => !(brandRe.test(seg) && seg.replace(brandRe, '').trim().length === 0));
    if (withoutBrandOnly.length) segments = withoutBrandOnly;
  }
  // Prefer a short, label-like segment over a long tagline.
  segments.sort((a, b) => (a.length > 48 ? 1 : 0) - (b.length > 48 ? 1 : 0));
  let t = segments[0] || raw;
  if (brandRe && t.replace(brandRe, '').trim().length >= 3) t = t.replace(brandRe, '').replace(/^\W+|\W+$/g, '').trim();
  t = t.replace(/^(welcome to|home)\s*/i, '').trim();
  if (t.length > 48) { t = t.slice(0, 48); t = t.slice(0, t.lastIndexOf(' ') > 24 ? t.lastIndexOf(' ') : 48).trim() + '…'; }
  return t;
}

function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function targetKey(el, pageUrl) {
  if (el.href) return `url:${normalizeUrlForState(el.href)}`;
  return `el:${el.kind}:${el.name.toLowerCase()}`;
}

/** Picks a search phrase that fits the site: a frequent nav word, a heading word, or a safe default. */
export function pickSearchQuery(snapshot) {
  const words = [];
  for (const el of snapshot.elements) if (el.kind === 'link' && el.inNav && /^[A-Za-z][A-Za-z ]{2,18}$/.test(el.name) && !AUTH_RE.test(el.name) && !DESTRUCTIVE_RE.test(el.name)) words.push(el.name.split(' ')[0]);
  for (const h of snapshot.headings) for (const w of h.text.split(/\s+/)) if (/^[A-Za-z]{4,12}$/.test(w) && !/^(the|and|your|with|from|that|this|what|when|where|about|more|every|into|best|free|most)$/i.test(w)) words.push(w);
  const counts = new Map();
  for (const w of words) counts.set(w.toLowerCase(), (counts.get(w.toLowerCase()) || 0) + 1);
  const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  const pick = sorted.find(([w]) => !/^(home|search|menu|login|about|contact|help|blog|more|skip|close|open|next|back)$/.test(w));
  return pick ? pick[0] : 'design';
}

/**
 * @returns {Array<{id:string, type:string, elementId?:string, label:string, intent:string, score:number, targetKey?:string, value?:string}>}
 */
export function planCandidates(snapshot, { tracker, state, startOrigin, isSameSite, scrolledHere = 0, searchedHere = false, hoveredHere = new Set(), searchedQueries = new Set() }) {
  const onResultsPage = /[?&](q|query|search|s|keyword)=/.test(snapshot.url);
  const cands = [];
  const seenTargets = new Set();
  const stateDepthPenalty = Math.min(10, state.visits * 3);
  const here = describeScreen(snapshot);

  for (const el of snapshot.elements) {
    if (el.disabled) continue;
    if (!el.inViewport && snapshot.modal) continue;
    const name = el.name || '';
    if (DESTRUCTIVE_RE.test(name)) continue;
    if (el.href) {
      if (/^(mailto:|tel:|javascript:|#$)/i.test(el.href)) continue;
      if (!isSameSite(el.href)) continue;
      if (/\.(pdf|zip|dmg|exe|mp4|mp3|png|jpg|jpeg|gif|svg|csv|xlsx?|docx?)(\?|$)/i.test(el.href)) continue;
    }
    if (snapshot.modal && !el.inModal) continue; // while a dialog is open, only act inside it (or close it)
    const key = targetKey(el, snapshot.url);
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    const tried = state.actionsTried.has(key);
    let score = 0; let category = 'other'; let type = 'click';
    let intent = '';
    let value;
    for (const [re, pts, cat] of IMPORTANT) { if (re.test(name)) { score += pts; category = cat; break; } }
    if (LOW_VALUE.test(name)) score -= 15;
    if (AUTH_RE.test(name)) score -= 6; // one look at a sign-in page is fine; it will be marked blocked after
    if (el.inFooter) score -= 8;
    if (el.inNav) score += 6;
    if (!el.inViewport) score -= 6;
    if (el.href && tracker.visitedUrl(el.href)) score -= 25;
    if (el.href && normalizeUrlForState(el.href) === normalizeUrlForState(snapshot.url)) score -= 30;
    if (tried) score -= 40;
    if (el.selected) score -= 12;
    if (name.length < 2) score -= 10;
    if (/^\d+$/.test(name)) score -= 10;
    score -= stateDepthPenalty;

    switch (el.kind) {
      case 'search': {
        type = 'search'; value = pickSearchQuery(snapshot); score += 28; category = 'search';
        intent = `Searching for “${value}”`;
        if (searchedHere || onResultsPage || searchedQueries.has(value)) score -= 45;
        break;
      }
      case 'input': {
        const t = (el.inputType || 'text').toLowerCase();
        const looksSearch = /search|find|query|look/i.test(name) || /search|query|q$/i.test(el.name);
        if (looksSearch) { type = 'search'; value = pickSearchQuery(snapshot); score += 24; category = 'search'; intent = `Searching for “${value}”`; if (searchedHere || onResultsPage || searchedQueries.has(value)) score -= 45; }
        else if (['email', 'tel', 'password', 'number'].includes(t)) { continue; }
        else { score -= 12; type = 'focus'; intent = `Focusing the ${name || 'text'} field`; }
        break;
      }
      case 'password': case 'file': continue;
      case 'textarea': score -= 15; type = 'focus'; intent = `Focusing the ${name || 'text'} area`; break;
      case 'select': type = 'select'; score += 8; intent = `Choosing an option in ${name || 'the dropdown'}`; break;
      case 'tab': type = 'click'; score += 16; intent = `Switching to the ${name} tab`; category = 'tab'; break;
      case 'menuitem': type = 'click'; score += 10; intent = `Choosing ${name} from the menu`; break;
      case 'checkbox': case 'switch': type = 'click'; score -= 2; intent = `Toggling ${name || 'the option'}`; break;
      case 'radio': type = 'click'; score -= 4; intent = `Selecting ${name || 'the option'}`; break;
      case 'link': {
        intent = intentForLink(name, category);
        if (el.hasPopup && el.expanded === 'false') { type = 'hover'; intent = `Opening the ${name} menu`; score += 6; if (hoveredHere.has(key)) score -= 40; }
        break;
      }
      case 'button': {
        intent = intentForButton(name, category);
        if (el.hasPopup || el.expanded != null) { score += 8; intent = el.expanded === 'true' ? `Closing the ${name} menu` : `Opening the ${name} menu`; if (el.expanded === 'true') score -= 20; }
        if (/^(close|dismiss|×|✕|x|cancel|got it|ok|okay|no thanks|maybe later|not now|skip)$/i.test(name)) {
          score = snapshot.modal ? 20 : -20; intent = `Closing the ${snapshot.modalTitle || 'dialog'}`;
        }
        if (!/close|hide|collapse/i.test(name) && (/^(menu|open menu|hamburger|navigation|toggle (menu|navigation)|☰|more)$/i.test(name) || (/menu|hamburger|navigation/i.test(name) && el.w < 80))) { score += 14; intent = 'Opening the navigation menu'; category = 'menu'; }
        if (/^close( menu| navigation| drawer)?$/i.test(name) && !snapshot.modal) { score -= 25; intent = `Closing the ${name.replace(/^close\s*/i, '') || 'panel'}`; }
        break;
      }
      case 'clickable': {
        score -= 4; intent = name ? `Opening ${shorten(name)}` : 'Opening a card';
        break;
      }
      default: score -= 10; intent = `Clicking ${name}`;
    }
    if (!intent) intent = name ? `Opening ${shorten(name)}` : 'Clicking an element';
    cands.push({ id: `a${cands.length + 1}`, type, elementId: el.id, label: name, kind: el.kind, href: el.href || undefined, intent, score, targetKey: key, category, value });
  }

  // Page-level actions.
  const canScroll = snapshot.scroll.max - snapshot.scroll.y > snapshot.viewport.height * 0.5;
  if (canScroll && !snapshot.modal) {
    cands.push({ id: `a${cands.length + 1}`, type: 'scroll', label: 'Scroll down', intent: `Browsing further down ${here}`, score: 15 - scrolledHere * 12 - stateDepthPenalty, targetKey: `scroll:${scrolledHere}`, category: 'scroll' });
  }
  if (snapshot.modal) {
    cands.push({ id: `a${cands.length + 1}`, type: 'escape', label: 'Press Escape', intent: `Closing the ${snapshot.modalTitle || 'dialog'}`, score: 8, targetKey: 'escape', category: 'close' });
  }
  if (tracker.history.length > 1) {
    const prev = tracker.byId(tracker.previousStateId);
    cands.push({ id: `a${cands.length + 1}`, type: 'back', label: 'Go back', intent: prev ? `Returning to ${prev.name || 'the previous screen'}` : 'Returning to the previous screen', score: -5 + stateDepthPenalty * 1.5 + (state.exhausted ? 30 : 0), targetKey: 'back', category: 'back' });
  }
  cands.sort((a, b) => b.score - a.score);
  return cands;
}

function shorten(s) { return s.length > 40 ? `${s.slice(0, 38).trim()}…` : s; }

function intentForLink(name, category) {
  const n = shorten(name);
  switch (category) {
    case 'home': return `Going to ${n}`;
    case 'section': return `Browsing ${n}`;
    case 'account': return /settings|preferences/i.test(name) ? 'Managing account settings' : `Viewing ${n}`;
    case 'detail': return 'Opening the details';
    case 'filter': return `Refining with ${n}`;
    case 'create': return `Starting “${n}”`;
    case 'info': return `Reading ${n}`;
    case 'pagination': return `Going to ${n}`;
    default: return `Opening ${n}`;
  }
}

function intentForButton(name, category) {
  const n = shorten(name);
  switch (category) {
    case 'search': return 'Running the search';
    case 'filter': return `Opening ${n}`;
    case 'create': return `Starting “${n}”`;
    case 'detail': return 'Expanding the details';
    default: return `Pressing “${n}”`;
  }
}
