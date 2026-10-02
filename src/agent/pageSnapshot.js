// Builds a compact, machine-readable understanding of the current page: interactive elements
// (tagged with data-motvin-id so they can be targeted later), headings, text, loading
// indicators and access-control signals. Everything runs inside the page in one evaluate call.

const SNAPSHOT_FN = `(maxElements) => {
  const vw = window.innerWidth, vh = window.innerHeight;
  const seen = new Set();
  const out = [];
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const isVisible = (el, r) => {
    if (!r || r.width < 4 || r.height < 4) return false;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    if (r.bottom < -vh * 2 || r.top > vh * 3) return false; // far outside the current scroll region
    return true;
  };
  const accessibleName = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = labelledBy.split(/\\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ');
      if (clean(t)) return clean(t);
    }
    if (el.matches('input,textarea,select')) {
      if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && clean(l.textContent)) return clean(l.textContent); }
      const wrap = el.closest('label'); if (wrap && clean(wrap.textContent)) return clean(wrap.textContent);
      if (el.placeholder) return clean(el.placeholder);
      if (el.name) return clean(el.name);
      if (el.value && el.type === 'submit') return clean(el.value);
    }
    const img = el.querySelector('img[alt]'); if (img && clean(img.alt)) return clean(img.alt);
    const svgTitle = el.querySelector('svg title'); if (svgTitle && clean(svgTitle.textContent)) return clean(svgTitle.textContent);
    const text = clean(el.innerText || el.textContent);
    if (text) return text.slice(0, 80);
    if (el.title) return clean(el.title);
    const href = el.getAttribute('href'); if (href) return clean(href).slice(0, 60);
    return '';
  };
  const kindOf = (el) => {
    const role = (el.getAttribute('role') || '').toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (role === 'tab') return 'tab';
    if (role === 'menuitem' || role === 'menuitemradio' || role === 'menuitemcheckbox') return 'menuitem';
    if (role === 'combobox' || tag === 'select') return 'select';
    if (role === 'checkbox' || (tag === 'input' && el.type === 'checkbox')) return 'checkbox';
    if (role === 'radio' || (tag === 'input' && el.type === 'radio')) return 'radio';
    if (role === 'switch') return 'switch';
    if (role === 'slider' || (tag === 'input' && el.type === 'range')) return 'slider';
    if (tag === 'textarea') return 'textarea';
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase();
      if (['submit', 'button', 'image', 'reset'].includes(t)) return 'button';
      if (['hidden'].includes(t)) return 'hidden';
      if (t === 'search') return 'search';
      if (t === 'password') return 'password';
      if (t === 'file') return 'file';
      return 'input';
    }
    if (role === 'searchbox') return 'search';
    if (role === 'textbox' || el.isContentEditable) return 'input';
    if (tag === 'a' && el.getAttribute('href')) return 'link';
    if (tag === 'button' || role === 'button' || role === 'link') return role === 'link' ? 'link' : 'button';
    if (tag === 'summary') return 'button';
    if (el.hasAttribute('onclick') || getComputedStyle(el).cursor === 'pointer') return 'clickable';
    return 'other';
  };
  const selector = 'a[href],button,input,select,textarea,summary,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[role="menuitemradio"],[role="menuitemcheckbox"],[role="checkbox"],[role="radio"],[role="switch"],[role="combobox"],[role="searchbox"],[role="textbox"],[role="option"],[contenteditable="true"],[onclick],[tabindex]:not([tabindex="-1"])';
  const nodes = Array.from(document.querySelectorAll(selector));
  // Add cursor:pointer containers that carry text (cards, tiles) but are not already interactive.
  const extra = Array.from(document.querySelectorAll('div,li,span,article,section')).filter((el) => {
    if (nodes.includes(el) || el.closest(selector)) return false;
    const cs = getComputedStyle(el); if (cs.cursor !== 'pointer') return false;
    const r = el.getBoundingClientRect(); return r.width > 24 && r.height > 24 && r.width * r.height < vw * vh * 0.6;
  }).slice(0, 40);
  let counter = 0;
  const dialogs = Array.from(document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open],[aria-modal="true"]')).filter((d) => { const r = d.getBoundingClientRect(); return r.width > 50 && r.height > 50; });
  const modalRoot = dialogs.length ? dialogs[dialogs.length - 1] : null;
  for (const el of nodes.concat(extra)) {
    if (seen.has(el)) continue; seen.add(el);
    if (el.closest('[aria-hidden="true"]')) continue;
    const r = el.getBoundingClientRect();
    if (!isVisible(el, r)) continue;
    const kind = kindOf(el);
    if (kind === 'hidden' || kind === 'other') continue;
    const id = String(++counter);
    el.setAttribute('data-motvin-id', id);
    const name = accessibleName(el);
    if (!name && !['input', 'search', 'textarea', 'select', 'password', 'checkbox', 'radio', 'switch'].includes(kind) && !el.querySelector('svg,img')) continue;
    const disabled = el.disabled || el.getAttribute('aria-disabled') === 'true';
    const inViewport = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    out.push({
      id, kind, tag: el.tagName.toLowerCase(), name: name.slice(0, 80),
      href: el.tagName === 'A' ? (el.href || '') : (el.closest('a[href]')?.href || ''),
      x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
      inViewport, disabled: Boolean(disabled),
      inNav: Boolean(el.closest('nav,header,[role="navigation"],[role="banner"],[role="menubar"],[role="tablist"]')),
      inFooter: Boolean(el.closest('footer,[role="contentinfo"]')),
      inModal: modalRoot ? modalRoot.contains(el) : false,
      inConsent: Boolean(el.closest('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[aria-label*="cookie" i],[id*="gdpr" i],[class*="gdpr" i]')),
      hasPopup: el.getAttribute('aria-haspopup') || (el.getAttribute('aria-expanded') != null) ? (el.getAttribute('aria-expanded') || 'true') : null,
      expanded: el.getAttribute('aria-expanded'),
      selected: el.getAttribute('aria-selected') === 'true' || el.classList.contains('active') || el.getAttribute('aria-current') != null,
      checked: el.checked == null ? null : Boolean(el.checked),
      value: (el.value != null && typeof el.value === 'string') ? el.value.slice(0, 40) : undefined,
      inputType: el.tagName === 'INPUT' ? (el.type || 'text') : undefined,
      options: el.tagName === 'SELECT' ? Array.from(el.options).slice(0, 8).map((o) => o.text.trim().slice(0, 30)) : undefined,
      target: el.getAttribute('target') || undefined,
    });
    if (out.length >= maxElements * 2) break;
  }
  // Keep the in-viewport elements first, then the rest, capped.
  out.sort((a, b) => Number(b.inViewport) - Number(a.inViewport) || a.y - b.y || a.x - b.x);
  const elements = out.slice(0, maxElements);

  const headings = Array.from(document.querySelectorAll('h1,h2,h3')).map((h) => ({ level: Number(h.tagName[1]), text: clean(h.innerText).slice(0, 100) })).filter((h) => h.text).slice(0, 14);
  const h1 = headings.find((h) => h.level === 1)?.text || '';
  const bodyText = clean(document.body ? document.body.innerText : '');
  const lower = bodyText.toLowerCase();

  // Loading indicators: explicit roles, aria-busy, common class names, and spinning animations.
  const loadingSel = '[role="progressbar"],[aria-busy="true"],.spinner,.loader,.loading,.skeleton,.shimmer,[class*="skeleton" i],[class*="spinner" i],[class*="shimmer" i],[class*="placeholder-glow" i],[class*="loading" i]';
  let loadingIndicators = 0;
  for (const el of Array.from(document.querySelectorAll(loadingSel)).slice(0, 80)) {
    const r = el.getBoundingClientRect(); if (!isVisible(el, r) || r.bottom < 0 || r.top > vh) continue; loadingIndicators++;
  }
  let animating = 0;
  if (document.getAnimations) {
    for (const a of document.getAnimations().slice(0, 200)) {
      const t = a.effect && a.effect.target; if (!t || !(t instanceof Element)) continue;
      const r = t.getBoundingClientRect(); if (r.width < 8 || r.height < 8 || r.bottom < 0 || r.top > vh) continue;
      const timing = a.effect.getTiming ? a.effect.getTiming() : {};
      if (timing.iterations === Infinity) animating++;
    }
  }
  const pendingImages = Array.from(document.images).filter((img) => { const r = img.getBoundingClientRect(); return r.width > 20 && r.height > 20 && r.bottom > 0 && r.top < vh && !img.complete; }).length;

  const passwordFields = Array.from(document.querySelectorAll('input[type="password"]')).filter((el) => isVisible(el, el.getBoundingClientRect()) && !el.closest('[aria-hidden="true"]'));
  const hasPassword = passwordFields.length > 0;
  const passwordInModal = Boolean(modalRoot && passwordFields.some((el) => modalRoot.contains(el)));
  const captcha = /recaptcha|hcaptcha|cf-turnstile|captcha|are you human|verify you are human|unusual traffic/i.test(document.documentElement.innerHTML.slice(0, 400000)) || /captcha|i'm not a robot|verify you are human/.test(lower);
  const otp = /one-time (pass)?code|verification code|enter the code|otp|2-step verification|two-factor|authenticator app|code sent to/.test(lower) && Boolean(document.querySelector('input[autocomplete="one-time-code"],input[inputmode="numeric"],input[type="tel"],input[type="number"],input[maxlength="1"]'));
  const loginTitle = /\\b(sign in|log in|login|sign up|create (an )?account|welcome back)\\b/.test((h1 + ' ' + document.title + ' ' + (modalRoot ? modalRoot.textContent.slice(0, 200) : '')).toLowerCase());
  const login = hasPassword && (loginTitle || passwordInModal || out.filter((e) => e.inViewport && !e.inModal).length < 14);
  const paywall = /subscribe to continue|subscription required|start your free trial to|premium members only|unlock this article|become a member to/.test(lower);
  const accessDenied = /\\b(403|401)\\b.*(forbidden|unauthori[sz]ed)|access denied|you don't have permission|permission denied/.test(lower.slice(0, 2000));
  const notFound = /\\b404\\b|page not found|this page doesn't exist|we can't find that page/.test(lower.slice(0, 2000)) && bodyText.length < 1500;
  const cookieBanner = Array.from(document.querySelectorAll('[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],[aria-label*="cookie" i]')).some((el) => { const r = el.getBoundingClientRect(); return isVisible(el, r) && r.width > 200 && r.height > 40; });

  const scroller = document.scrollingElement || document.documentElement;
  return {
    url: location.href, title: clean(document.title).slice(0, 120), h1, headings,
    textSample: bodyText.slice(0, 1200), textLength: bodyText.length,
    elements,
    modal: Boolean(modalRoot), modalTitle: modalRoot ? clean(modalRoot.querySelector('h1,h2,h3,[id*="title" i]')?.textContent || modalRoot.getAttribute('aria-label') || '').slice(0, 80) : '',
    scroll: { y: Math.round(scroller.scrollTop), max: Math.max(0, Math.round(scroller.scrollHeight - vh)), height: Math.round(scroller.scrollHeight) },
    viewport: { width: vw, height: vh },
    loading: { indicators: loadingIndicators, animating, pendingImages, readyState: document.readyState },
    signals: { hasPassword, passwordInModal, captcha, otp, login, paywall, accessDenied, notFound, cookieBanner },
    forms: document.forms.length,
    counts: { links: document.links.length, buttons: document.querySelectorAll('button,[role="button"]').length, inputs: document.querySelectorAll('input,textarea,select').length, images: document.images.length },
  };
}`;

/**
 * @param {import('playwright').Page} page
 * @param {{maxElements?: number}} [opts]
 */
export async function snapshotPage(page, { maxElements = 90 } = {}) {
  const snap = await page.evaluate(`(${SNAPSHOT_FN})(${maxElements})`);
  snap.capturedAt = Date.now();
  return snap;
}

/** A cheap structural digest used to detect whether the UI is still changing between polls. */
const DIGEST_FN = `() => {
  const vh = window.innerHeight;
  let count = 0; let boxes = '';
  const all = document.body ? document.body.querySelectorAll('*') : [];
  const step = Math.max(1, Math.floor(all.length / 400));
  for (let i = 0; i < all.length; i += step) {
    const el = all[i]; const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.bottom < 0 || r.top > vh) continue;
    count++; boxes += (r.left | 0) + ',' + (r.top | 0) + ',' + (r.width | 0) + ',' + (r.height | 0) + ';';
  }
  const text = document.body ? document.body.innerText : '';
  let hash = 0; for (let i = 0; i < boxes.length; i++) hash = (hash * 31 + boxes.charCodeAt(i)) | 0;
  let thash = 0; for (let i = 0; i < text.length; i += 7) thash = (thash * 31 + text.charCodeAt(i)) | 0;
  const pending = Array.from(document.images).filter((img) => { const r = img.getBoundingClientRect(); return r.width > 20 && r.height > 20 && r.bottom > 0 && r.top < vh && !img.complete; }).length;
  return { nodes: all.length, visible: count, hash, thash, textLength: text.length, pending, ready: document.readyState, url: location.href };
}`;

export async function digestPage(page) {
  return page.evaluate(`(${DIGEST_FN})()`);
}
