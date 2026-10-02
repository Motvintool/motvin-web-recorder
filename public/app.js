/* Motvin Web Recorder — front-end. Vanilla JS; the server pushes state over a WebSocket. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);

  // ───────────────────────── icons ─────────────────────────
  const PATHS = {
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
    tablet: '<rect x="4.5" y="3" width="15" height="18" rx="2.5"/><path d="M11 18h2"/>',
    sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
    cursor: '<path d="M5 3.5l13 6.2-5.6 1.8-1.9 5.9z"/><path d="M13 13l5 5"/>',
    sparkles: '<path d="M11 3l1.9 4.9 4.9 1.9-4.9 1.9L11 16.6 9.1 11.7 4.2 9.8l4.9-1.9z"/><path d="M18.5 14.5l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    play: '<path d="M8 5v14l11-7z"/>',
    pause: '<path d="M8.5 5v14M15.5 5v14" stroke-width="2.6"/>',
    stop: '<rect x="6.5" y="6.5" width="11" height="11" rx="2.2"/>',
    folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H9l2 2.5h7.5A2.5 2.5 0 0 1 21 10v7a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17z"/>',
    download: '<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14"/>',
    video: '<rect x="3" y="6" width="13" height="12" rx="2.5"/><path d="M16 10.5l5-3v9l-5-3z"/>',
    image: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 17l5-4.5 4 3.5 3-2.5 4 3.5"/>',
    trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l.8 12h9.4l.8-12M10 11v5M14 11v5"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>',
    check: '<path d="M5 12.5l4.5 4.5L19 7.5" stroke-width="2.4"/>',
    x: '<path d="M6 6l12 12M18 6L6 18"/>',
    chevron: '<path d="M6 9l6 6 6-6"/>',
    activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
    lock: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
    window: '<rect x="3" y="4.5" width="18" height="15" rx="2.5"/><path d="M3 9.5h18"/>',
    layers: '<path d="M12 3.5l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
    external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
    record: '<circle cx="12" cy="12" r="6.5" fill="currentColor" stroke="none"/>',
  };
  const icon = (name, size) => `<svg class="ico" viewBox="0 0 24 24"${size ? ` style="width:${size}px;height:${size}px"` : ''} aria-hidden="true">${PATHS[name] || ''}</svg>`;

  // ───────────────────────── state ─────────────────────────
  const ui = {
    health: null, presets: [], presetId: 'desktop-1440', mode: 'manual', brain: 'auto', browser: 'chromium',
    state: { phase: 'idle' }, log: [], recordings: [], processing: {}, exports: {},
    menu: null, activityOpen: false, previewUrlObj: null, viewerId: null,
    sig: { cta: '', dock: '', flow: '', banner: '' }, cards: new Map(), launching: false,
  };
  const el = {
    url: $('urlInput'), urlWrap: $('urlWrap'), urlError: $('urlError'), presets: $('presetList'), customVp: $('customViewport'), customW: $('customW'), customH: $('customH'),
    modeManual: $('modeManual'), modeAi: $('modeAi'), aiOptions: $('aiOptions'), aiSummary: $('aiSummary'), brainList: $('brainList'), autoStartRow: $('autoStartRow'), autoStart: $('autoStart'), signInRow: $('signInRow'), followSignIn: $('followSignIn'),
    limMinutes: $('limMinutes'), limScreens: $('limScreens'), limSteps: $('limSteps'), autoProcess: $('autoProcess'),
    browserSeg: $('browserSeg'), chromeBtn: $('chromeBtn'), browserHint: $('browserHint'), scale: $('scaleSelect'), videoScale: $('videoScaleSelect'), videoScaleHint: $('videoScaleHint'), qualitySummary: $('qualitySummary'),
    controls: $('controls'), hint: $('setupHint'), ffWarn: $('ffmpegWarning'), sessionBanner: $('sessionBanner'), setup: $('setupPanel'),
    pill: $('statusPill'), previewUrl: $('previewUrl'), urlbar: $('urlbar'), stageMeta: $('stageMeta'), previewFrame: $('previewFrame'), previewImg: $('previewImg'),
    banner: $('banner'), dock: $('dock'), busyVeil: $('busyVeil'), busyText: $('busyText'), flow: $('flowStrip'), ticker: $('tickerText'), activityToggle: $('activityToggle'), activityDrawer: $('activityDrawer'), log: $('logList'),
    gallery: $('recordingsList'), recordingsDir: $('recordingsDir'), recordingsSub: $('recordingsSub'), viewer: $('viewer'), viewerCard: $('viewerCard'), toasts: $('toasts'),
  };

  // ───────────────────────── helpers ─────────────────────────
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtTime = (ms) => { const s = Math.max(0, Math.floor((ms || 0) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const fmtBytes = (b) => b == null ? '—' : b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
  const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u || ''; } };
  const pathOf = (u) => { try { const x = new URL(u); return (x.pathname === '/' ? '' : x.pathname) + x.search; } catch { return ''; } };
  const busy = () => !['idle', 'completed', 'error'].includes(ui.state.phase);
  const recState = () => ui.state.recording?.state || 'idle';
  const store = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(`motvin.${k}`)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(`motvin.${k}`, JSON.stringify(v)); } catch { /* private mode */ } } };

  function toast(message, kind = 'info') {
    const t = document.createElement('div'); t.className = `toast ${kind}`; t.textContent = message; el.toasts.appendChild(t);
    setTimeout(() => t.remove(), kind === 'error' ? 8000 : 4200);
  }
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    return data;
  }
  async function act(fn, okMessage) {
    try { const r = await fn(); if (okMessage) toast(okMessage, 'ok'); return r; } catch (err) { toast(err.message, 'error'); throw err; }
  }
  const btn = (html, cls, onClick, { disabled = false, title = '' } = {}) => {
    const b = document.createElement('button'); b.className = cls; b.disabled = disabled; b.innerHTML = html; if (title) b.title = title; if (onClick) b.onclick = onClick; return b;
  };

  // ───────────────────────── viewport / options ─────────────────────────
  function currentViewport() {
    if (ui.presetId === 'custom') return { width: Number(el.customW.value), height: Number(el.customH.value), preset: 'custom', kind: Number(el.customW.value) < 600 ? 'mobile' : Number(el.customW.value) < 1000 ? 'tablet' : 'desktop' };
    const p = ui.presets.find((x) => x.id === ui.presetId) || ui.presets[0] || { width: 1440, height: 900, id: 'desktop-1440', kind: 'desktop' };
    return { width: p.width, height: p.height, preset: p.id, kind: p.kind };
  }
  const aiOptions = () => ({
    backend: ui.brain, autoProcess: el.autoProcess.checked,
    limits: { maxMinutes: Number(el.limMinutes.value) || 4, maxScreens: Number(el.limScreens.value) || 25, maxSteps: Number(el.limSteps.value) || 60 },
  });
  function effectiveVideoScale(vp, req) {
    const max = ui.health?.videoDefaults?.maxPixels || 8500000; let eff = req;
    while (eff > 1 && vp.width * vp.height * eff * eff > max) eff--;
    return eff;
  }

  // ───────────────────────── Setup panel ─────────────────────────
  function renderPresets() {
    el.presets.innerHTML = '';
    const items = ui.presets.concat([{ id: 'custom', label: 'Custom', kind: 'custom' }]);
    for (const p of items) {
      const b = document.createElement('button');
      b.className = `preset${p.id === ui.presetId ? ' selected' : ''}`; b.disabled = busy();
      const ic = p.kind === 'mobile' ? 'phone' : p.kind === 'tablet' ? 'tablet' : p.kind === 'custom' ? 'sliders' : 'monitor';
      b.innerHTML = `${icon(ic)}<span class="preset-text"><span class="preset-size">${p.width ? `${p.width} × ${p.height}` : 'W × H'}</span><span class="preset-name">${esc(p.label)}</span></span>`;
      b.onclick = () => { ui.presetId = p.id; store.set('preset', p.id); renderPresets(); renderPreviewFrame(); renderStageHead(); renderQualityHints(); };
      el.presets.appendChild(b);
    }
    el.customVp.classList.toggle('hidden', ui.presetId !== 'custom');
  }
  function renderMode() {
    el.modeManual.classList.toggle('selected', ui.mode === 'manual');
    el.modeAi.classList.toggle('selected', ui.mode === 'ai');
    el.modeManual.disabled = el.modeAi.disabled = busy();
    el.autoStartRow.classList.toggle('hidden', ui.mode !== 'manual');
    el.signInRow.classList.toggle('hidden', ui.mode !== 'manual');
    el.aiOptions.classList.toggle('hidden', ui.mode !== 'ai');
    if (ui.mode === 'ai' && !el.aiOptions.dataset.touched) el.aiOptions.open = true;
    const ai = ui.health?.ai; const b = ai && (ui.brain === 'auto' ? ai.backends.find((x) => x.id === ai.auto) : ai.backends.find((x) => x.id === ui.brain));
    el.aiSummary.textContent = b ? `${b.label}${ui.brain === 'auto' ? ' (auto)' : ''}` : '';
  }
  function renderBrains() {
    if (!ui.health) return;
    const { backends, auto } = ui.health.ai;
    el.brainList.innerHTML = '';
    const rows = [{ id: 'auto', label: 'Auto', available: true, detail: `uses ${backends.find((b) => b.id === auto)?.label || auto}` }].concat(backends);
    for (const b of rows) {
      const x = document.createElement('button');
      x.className = `brain${ui.brain === b.id ? ' selected' : ''}`; x.disabled = !b.available || busy();
      x.innerHTML = `<span class="brain-dot${b.available ? ' on' : ''}"></span><span class="brain-name">${esc(b.label)}</span><span class="brain-detail" title="${esc(b.detail)}">${esc(b.detail)}</span>`;
      x.onclick = () => { ui.brain = b.id; store.set('brain', b.id); renderBrains(); renderMode(); };
      el.brainList.appendChild(x);
    }
  }
  function renderBrowserOptions() {
    const chrome = ui.health?.chrome;
    if (chrome && !chrome.available && ui.browser === 'chrome') ui.browser = 'chromium';
    for (const b of el.browserSeg.querySelectorAll('.seg-btn')) {
      b.classList.toggle('selected', b.dataset.browser === ui.browser);
      b.disabled = busy() || (b.dataset.browser === 'chrome' && chrome && !chrome.available);
    }
    el.browserHint.textContent = ui.browser === 'chrome'
      ? 'Opens your installed Google Chrome with its own saved profile, so Google sign-in works. Sign in once; it is remembered.'
      : chrome && !chrome.available ? 'Google Chrome was not found, so only the built-in Chromium is available. Google sign-in does not work there.' : 'Built-in Chromium. Google blocks sign-in here; choose My Chrome if the site needs it.';
    el.scale.disabled = el.videoScale.disabled = busy();
    renderQualityHints();
  }
  function renderQualityHints() {
    let vp; try { vp = currentViewport(); } catch { vp = null; }
    const req = Number(el.videoScale.value);
    if (vp && vp.width) {
      const eff = ui.browser === 'chrome' ? 1 : effectiveVideoScale(vp, req);
      el.videoScaleHint.textContent = ui.browser === 'chrome'
        ? `Video: ${vp.width} × ${vp.height} (native Chrome viewport for smooth direct navigation). Screens keep their selected resolution.`
        : `Video: ${vp.width * eff} × ${vp.height * eff}${eff !== req ? ` (limited from ${req}× to keep recording smooth)` : ''}. The WebM stays exactly ${vp.width} × ${vp.height}.`;
    }
    el.qualitySummary.textContent = `${ui.browser === 'chrome' ? 'My Chrome · native video' : `Chromium · ${req}× video`} · ${el.scale.value}× screens`;
  }

  function renderSetup() {
    const s = ui.state; const isBusy = busy() || ui.launching;
    el.setup.classList.toggle('locked', isBusy);
    el.url.disabled = isBusy;
    [el.limMinutes, el.limScreens, el.limSteps, el.autoProcess, el.customW, el.customH, el.autoStart, el.followSignIn].forEach((i) => { i.disabled = isBusy; });
    renderPresets(); renderMode(); renderBrains(); renderBrowserOptions();

    // Session banner + call to action are rebuilt only when their content changes (so clicks are never lost).
    const open = Boolean(s.browserOpen);
    const bannerSig = `${open}|${s.mode}|${s.url}|${s.viewport?.width}|${recState()}|${s.phase}`;
    if (bannerSig !== ui.sig.banner) {
      ui.sig.banner = bannerSig;
      el.sessionBanner.classList.toggle('hidden', !open);
      el.sessionBanner.className = `session-banner${s.mode === 'ai' ? ' ai' : ''}${open ? '' : ' hidden'}`;
      if (open) {
        const canClose = s.mode === 'manual' && recState() === 'idle' && s.phase !== 'launching';
        el.sessionBanner.innerHTML = `<span class="sb-icon">${icon(s.mode === 'ai' ? 'sparkles' : 'cursor', 18)}</span><div class="sb-text"><div class="sb-title">${s.mode === 'ai' ? 'AI session running' : 'Manual session open'}</div><div class="sb-sub">${esc(hostOf(s.url))} · ${s.viewport?.width} × ${s.viewport?.height}</div></div>`;
        if (canClose) el.sessionBanner.appendChild(btn(`${icon('x', 14)} Close`, 'btn btn-sm', () => act(() => api('/api/session/close', { method: 'POST' })), { title: 'Close the browser without recording' }));
      }
    }
    const ctaSig = `${isBusy}|${ui.mode}|${ui.launching}`;
    if (ctaSig !== ui.sig.cta) {
      ui.sig.cta = ctaSig; el.controls.innerHTML = '';
      if (!isBusy) {
        el.controls.appendChild(ui.mode === 'manual'
          ? btn(`${icon('window', 18)} Open browser`, 'btn btn-primary btn-lg btn-block', () => launch('manual'))
          : btn(`${icon('sparkles', 18)} Start AI exploration`, 'btn btn-ai btn-lg btn-block', () => launch('ai')));
      } else {
        el.controls.appendChild(btn(ui.launching || s.phase === 'launching' ? '<span class="spinner"></span> Opening…' : 'Session in progress', 'btn btn-lg btn-block', null, { disabled: true }));
      }
    }
    let hint = '';
    if (!isBusy) hint = ui.mode === 'manual' ? 'Opens a browser at this size. You press Start when you are ready.' : 'Opens the site, starts recording and lets the AI explore. It stops by itself.';
    else hint = 'Controls are on the preview. Settings unlock when the session ends.';
    if (!isBusy && s.error) hint = s.error;
    el.hint.textContent = hint; el.hint.style.color = !isBusy && s.error ? 'var(--rec)' : '';
  }

  async function launch(mode) {
    const raw = el.url.value.trim();
    el.urlWrap.classList.remove('invalid'); el.urlError.classList.add('hidden');
    if (!raw) { el.urlWrap.classList.add('invalid'); el.urlError.textContent = 'Enter a website address to record, e.g. example.com'; el.urlError.classList.remove('hidden'); el.url.focus(); return; }
    store.set('url', raw); store.set('mode', mode);
    ui.launching = true; ui.sig.cta = ''; ui.state = { ...ui.state, phase: 'launching', mode }; renderAll();
    try {
      await api('/api/session/launch', { method: 'POST', body: { url: raw, viewport: currentViewport(), mode, ai: aiOptions(), browser: ui.browser, screenScale: Number(el.scale.value), videoScale: Number(el.videoScale.value), autoStart: el.autoStart.checked, followSignIn: el.followSignIn.checked } });
    } catch (err) {
      toast(err.message, 'error');
      if (/url|host|address|valid/i.test(err.message)) { el.urlWrap.classList.add('invalid'); el.urlError.textContent = err.message; el.urlError.classList.remove('hidden'); }
      ui.state = await api('/api/state').catch(() => ({ phase: 'error', error: err.message }));
    } finally { ui.launching = false; ui.sig.cta = ''; ui.sig.dock = ''; renderAll(); }
  }

  // ───────────────────────── Stage ─────────────────────────
  function statusLabel() {
    const s = ui.state;
    if (ui.launching || s.phase === 'launching') return ['Opening browser', 'ai'];
    if (s.phase === 'idle') return ['Ready', 'idle'];
    if (s.phase === 'error') return ['Error', 'error'];
    if (s.phase === 'stopping') return ['Saving', 'ai'];
    if (s.phase === 'completed') return ['Completed', 'completed'];
    if (s.mode === 'ai' && s.ai) { const st = s.ai.status || 'AI Ready'; return [st, st === 'Blocked' || st === 'Paused' ? 'paused' : st === 'Error' ? 'error' : st === 'Completed' ? 'completed' : 'ai']; }
    const r = recState();
    return r === 'recording' ? ['Recording', 'recording'] : r === 'paused' ? ['Paused', 'paused'] : ['Browser open', 'idle'];
  }
  function renderPill() { const [label, cls] = statusLabel(); el.pill.className = `pill pill-${cls}`; el.pill.innerHTML = `<i></i><span>${esc(label)}</span>`; }

  function renderPreviewFrame() {
    const vp = (ui.state.browserOpen && ui.state.viewport) || currentViewport();
    if (vp.width && vp.height) el.previewFrame.style.setProperty('--ar', String(vp.width / vp.height));
    const live = Boolean(ui.state.browserOpen) && Boolean(ui.previewUrlObj);
    el.previewFrame.classList.toggle('live', live);
    const r = recState();
    el.previewFrame.classList.toggle('recording', r === 'recording');
    el.previewFrame.classList.toggle('paused', r === 'paused');
    el.previewFrame.classList.toggle('ai-run', ui.state.mode === 'ai' && Boolean(ui.state.ai) && busy() && r !== 'paused' && !ui.state.ai?.paused);
    const launching = ui.launching || ui.state.phase === 'launching';
    el.busyVeil.classList.toggle('hidden', !launching && ui.state.phase !== 'stopping');
    el.busyText.textContent = ui.state.phase === 'stopping' ? 'Saving your recording…' : 'Opening the browser…';
    if (!ui.state.browserOpen && ui.previewUrlObj) { URL.revokeObjectURL(ui.previewUrlObj); ui.previewUrlObj = null; el.previewImg.removeAttribute('src'); el.previewFrame.classList.remove('live'); }
  }

  function renderStageHead() {
    const s = ui.state; const vp = (s.browserOpen && s.viewport) || currentViewport();
    el.previewUrl.textContent = s.browserOpen ? (s.currentUrl || s.url || '') : 'No website open';
    el.urlbar.classList.toggle('live', Boolean(s.browserOpen));
    const chips = [];
    if (vp?.width) chips.push(`<span class="chip">${icon('window', 13)} ${vp.width} × ${vp.height}</span>`);
    if (vp?.width) { const eff = s.browserOpen && s.videoScale ? s.videoScale : effectiveVideoScale(vp, Number(el.videoScale.value) || 2); chips.push(`<span class="chip ok">${icon('video', 13)} MP4 ${vp.width * eff} × ${vp.height * eff}</span>`); }
    el.stageMeta.innerHTML = chips.join('');
  }

  function renderBanner() {
    const s = ui.state; const r = recState(); let text = '', cls = '';
    if (ui.launching || s.phase === 'launching') { text = ''; }
    else if (s.error && !busy() && s.phase === 'error') { text = esc(s.error); cls = 'err'; }
    else if (s.mode === 'ai' && s.ai && busy()) { text = s.ai.paused ? '<b>AI paused.</b> The browser is yours. Resume when you are ready.' : '<b>AI is exploring.</b> It waits for each page to finish loading before it moves on. Recording is automatic.'; cls = s.ai.paused ? 'warn' : 'ai'; }
    else if (r === 'recording' && s.mode === 'manual' && (s.idleMs || 0) > 15000) { text = `<b>Nothing is happening in the recorded browser</b> (${Math.round(s.idleMs / 1000)}s). Are you working in a different window or tab? <button class="banner-btn" data-banner="focus">Show the browser</button>`; cls = 'warn'; }
    else if (r === 'recording') { text = '<b>Recording.</b> Browse normally in the browser window. Every page you visit is captured. Pause to skip private steps.'; cls = 'rec'; }
    else if (r === 'paused') { text = '<b>Paused.</b> The page is exactly where you left it. Resume to continue the same video.'; cls = 'warn'; }
    const sig = `${text.replace(/\(\d+s\)/, '')}|${cls}`; if (sig === ui.sig.banner2) { if (text) el.banner.innerHTML = text; return; } ui.sig.banner2 = sig;
    el.banner.className = `banner ${cls}${text ? '' : ' hidden'}`; el.banner.innerHTML = text;
  }

  // The dock: the one place recording is controlled.
  function dockModel() {
    const s = ui.state; const r = recState(); const phase = s.phase;
    if (ui.launching || phase === 'launching') return { kind: 'none' };
    if (phase === 'stopping') return { kind: 'saving' };
    if (s.mode === 'ai' && s.browserOpen && s.ai && (r === 'recording' || r === 'paused' || phase === 'ready')) return { kind: s.ai.paused ? 'ai-paused' : 'ai-run' };
    if (s.mode === 'manual' && s.browserOpen && r === 'recording') { const left = Math.max(0, Math.ceil((3000 - (s.recordingAgeMs || 0)) / 1000)); return { kind: 'rec', left }; }
    if (s.mode === 'manual' && s.browserOpen && r === 'paused') return { kind: 'paused' };
    if (s.mode === 'manual' && s.browserOpen && phase === 'ready') return { kind: 'ready', saved: s.lastSavedId || '' };
    if ((phase === 'completed' || phase === 'error') && s.lastSavedId) { const p = ui.processing[s.lastSavedId]; return { kind: 'done', id: s.lastSavedId, proc: p && p.stage !== 'done' ? `${p.stage}:${p.done || 0}/${p.total || 0}:${p.stage === 'error'}` : '' }; }
    return { kind: 'none' };
  }
  function renderDock() {
    const m = dockModel(); const s = ui.state;
    const sig = JSON.stringify(m);
    if (sig !== ui.sig.dock) {
      ui.sig.dock = sig; const d = el.dock; d.innerHTML = ''; d.className = 'dock';
      if (m.kind === 'none') d.classList.add('hidden');
      if (m.kind === 'ready') {
        d.appendChild(btn(`${icon('record', 18)} Start recording`, 'dbtn dbtn-rec', () => act(() => api('/api/recording/start', { method: 'POST' }))));
        if (m.saved) { d.insertAdjacentHTML('beforeend', '<span class="dock-sep"></span>'); d.appendChild(btn(`<span class="dock-ok">${icon('check', 16)}</span> Saved · View`, 'dbtn-link dbtn', () => openViewer(m.saved))); }
        d.appendChild(btn(`${icon('x', 15)} Close browser`, 'dbtn dbtn-link', () => act(() => api('/api/session/close', { method: 'POST' }))));
      } else if (m.kind === 'rec') {
        d.insertAdjacentHTML('beforeend', '<span class="dock-dot"></span><span class="dock-label">Recording</span><span class="dock-time" id="dockTimer">00:00</span><span class="dock-sep"></span>');
        d.appendChild(btn(`${icon('pause', 16)} Pause`, 'dbtn', () => act(() => api('/api/recording/pause', { method: 'POST' }))));
        d.appendChild(btn(`${icon('stop', 16)} Stop${m.left ? ` <small>in ${m.left}s</small>` : ''}`, 'dbtn dbtn-stop', () => act(() => api('/api/recording/stop', { method: 'POST' }), 'Recording saved. The browser is still open: record again, or close it.'), { disabled: m.left > 0, title: m.left ? 'Stop unlocks a moment after starting, so a double-click cannot end the recording' : 'Stop and save' }));
      } else if (m.kind === 'paused') {
        d.classList.add('paused');
        d.insertAdjacentHTML('beforeend', '<span class="dock-dot"></span><span class="dock-label">Paused</span><span class="dock-time" id="dockTimer">00:00</span><span class="dock-sep"></span>');
        d.appendChild(btn(`${icon('play', 16)} Resume`, 'dbtn dbtn-rec', () => act(() => api('/api/recording/resume', { method: 'POST' }))));
        d.appendChild(btn(`${icon('stop', 16)} Stop`, 'dbtn dbtn-stop', () => act(() => api('/api/recording/stop', { method: 'POST' }), 'Recording saved.')));
      } else if (m.kind === 'ai-run' || m.kind === 'ai-paused') {
        d.classList.add('ai');
        d.insertAdjacentHTML('beforeend', `<span style="display:grid;color:#a5b4fc">${icon('sparkles', 18)}</span><span class="dock-label">${m.kind === 'ai-paused' ? 'AI paused' : 'AI exploring'}</span><span class="dock-time" id="dockTimer">00:00</span><span class="dock-action" id="dockAction"></span><span class="dock-sep"></span>`);
        d.appendChild(m.kind === 'ai-paused'
          ? btn(`${icon('play', 16)} Resume AI`, 'dbtn dbtn-ai', () => act(() => api('/api/ai/resume', { method: 'POST' })))
          : btn(`${icon('pause', 16)} Pause AI`, 'dbtn', () => act(() => api('/api/ai/pause', { method: 'POST' }))));
        d.appendChild(btn(`${icon('stop', 16)} Stop AI`, 'dbtn dbtn-stop', () => act(() => api('/api/ai/stop', { method: 'POST' }))));
      } else if (m.kind === 'saving') {
        d.insertAdjacentHTML('beforeend', '<span class="spinner" style="border-color:rgba(255,255,255,.25);border-top-color:#fff"></span><span class="dock-label">Saving recording…</span>');
      } else if (m.kind === 'done') {
        const p = ui.processing[m.id];
        d.insertAdjacentHTML('beforeend', `<span class="dock-ok">${icon('check', 20)}</span><span class="dock-label">${p && p.stage !== 'done' ? (p.stage === 'error' ? 'Saved (screen extraction failed)' : 'Saved · extracting screens') : 'Recording saved'}</span>`);
        if (p && p.stage !== 'done' && p.stage !== 'error') d.insertAdjacentHTML('beforeend', `<span class="dock-bar"><i style="width:${p.total ? Math.round((p.done || 0) / p.total * 100) : 15}%"></i></span>`);
        d.insertAdjacentHTML('beforeend', '<span class="dock-sep"></span>');
        d.appendChild(btn(`${icon('layers', 16)} View recording`, 'dbtn dbtn-stop', () => openViewer(m.id)));
      }
    }
    // Cheap in-place updates every tick.
    const t = $('dockTimer'); if (t && s.recording) t.textContent = fmtTime(s.recording.durationMs);
    const a = $('dockAction'); if (a) a.textContent = s.ai?.currentAction || s.ai?.status || '';
  }

  const crumb = (f) => (f.title && f.title.trim()) ? f.title.trim().replace(/\s+[|–—-]\s+.*$/, '').slice(0, 40) : (pathOf(f.url) || hostOf(f.url) || 'Home');
  function renderFlow() {
    const s = ui.state; let sig, html;
    if (s.mode === 'ai' && s.ai) {
      const list = s.ai.screensList || [];
      sig = `ai|${list.length}|${list.at(-1)?.name}|${s.ai.unique}|${s.ai.blocked}|${s.ai.steps}|${s.browserOpen}`;
      if (sig === ui.sig.flow) return; ui.sig.flow = sig;
      html = `<div class="flow-label">${icon('layers', 15)} ${s.browserOpen ? 'Screens discovered' : 'Last AI session'} <span class="flow-count">${s.ai.unique ?? list.length}</span></div><div class="flow-track">${list.length ? list.slice(-12).map((x, i, a) => `${i ? `<span class="flow-arrow">${icon('arrow', 13)}</span>` : ''}<span class="flow-chip${x.blocked ? ' blocked' : ''}${i === a.length - 1 ? ' current' : ''}" title="${esc(x.url)}"><span>${esc(x.name)}</span><em>${fmtTime(x.recordedMs)}</em></span>`).join('') : '<span class="flow-empty">The AI is looking at the first page…</span>'}</div><div class="flow-stats"><span class="chip">Steps ${s.ai.steps ?? 0}${s.ai.limits ? ` / ${s.ai.limits.maxSteps}` : ''}</span>${s.ai.blocked ? `<span class="chip warn">${s.ai.blocked} blocked</span>` : ''}</div>`;
    } else {
      const list = s.flow || [];
      const recording = recState() !== 'idle';
      sig = `m|${list.length}|${list.at(-1)?.url}|${list.at(-1)?.title}|${recording}|${s.browserOpen}`;
      if (sig === ui.sig.flow) return; ui.sig.flow = sig;
      html = `<div class="flow-label">${icon('layers', 15)} ${s.browserOpen || !list.length ? 'Pages captured' : 'Last session'} <span class="flow-count">${list.length}</span></div><div class="flow-track">${list.length ? list.slice(-14).map((f, i, a) => `${i ? `<span class="flow-arrow">${icon('arrow', 13)}</span>` : ''}<span class="flow-chip${i === a.length - 1 ? ' current' : ''}" title="${esc(f.url)}"><span>${esc(crumb(f))}</span><em>${fmtTime(f.recordedMs)}</em></span>`).join('') : `<span class="flow-empty">${recording ? 'Browse in the browser window. Each page you visit appears here.' : 'Start recording, then browse. Every page you visit appears here as it is captured.'}</span>`}</div>`;
    }
    el.flow.innerHTML = html;
    const tr = el.flow.querySelector('.flow-track'); if (tr) tr.scrollLeft = tr.scrollWidth;
  }

  function renderActivity() {
    const last = ui.log[ui.log.length - 1];
    el.activityToggle.innerHTML = `${icon('activity', 14)} Activity ${icon('chevron', 13)}`;
    el.activityToggle.setAttribute('aria-expanded', String(ui.activityOpen));
    el.ticker.textContent = last ? last.message : 'Nothing yet. Activity from the browser and the AI shows up here.';
    el.ticker.style.color = last?.level === 'error' ? 'var(--rec)' : '';
    el.activityDrawer.classList.toggle('hidden', !ui.activityOpen);
    if (ui.activityOpen) el.log.innerHTML = ui.log.slice(-120).reverse().map((e) => `<div class="log-row ${e.level}"><span class="t">${new Date(e.t).toLocaleTimeString([], { hour12: false })}</span><span class="m">${esc(e.message)}</span></div>`).join('');
  }

  function renderStage() { renderPill(); renderPreviewFrame(); renderStageHead(); renderBanner(); renderDock(); renderFlow(); renderActivity(); }

  el.banner.addEventListener('click', (e) => { if (e.target.closest('[data-banner="focus"]')) sendInput({ type: 'focus' }); });

  // ───────────────────────── Library ─────────────────────────
  async function loadRecordings() {
    try { ui.recordings = await api('/api/recordings'); renderLibrary(); } catch (err) { toast(err.message, 'error'); }
  }
  function cardBody(r) {
    const v = r.video || {}; const dur = r.durationMs ?? v.durationMs; const ps = ui.processing[r.id];
    const exporting = Object.values(ui.exports).filter((x) => x.id === r.id && x.stage !== 'done');
    const done = ['completed', 'interrupted'].includes(r.status) && r.hasVideo;
    const chips = [];
    chips.push(`<span class="chip">${icon('window', 13)} ${r.highRes?.width ? `${r.highRes.width} × ${r.highRes.height}` : `${v.width || r.viewport?.width} × ${v.height || r.viewport?.height}`}</span>`);
    chips.push(`<span class="chip">${fmtBytes((r.fileSizeBytes || 0) + (r.highRes ? 0 : 0))}</span>`);
    if (r.analysisSummary) chips.push(`<span class="chip ok">${icon('layers', 13)} ${r.analysisSummary.screens} screens</span>`);
    if (r.pauseCount) chips.push(`<span class="chip">${r.pauseCount} pause${r.pauseCount > 1 ? 's' : ''}</span>`);
    if (r.browser === 'chrome') chips.push('<span class="chip">Chrome</span>');
    if (r.status === 'interrupted') chips.push('<span class="chip warn">Interrupted</span>');
    if (r.status === 'recording') chips.push('<span class="chip rec">Recording…</span>');
    const procHtml = (ps && ps.stage !== 'done') ? `<div class="rprogress${ps.stage === 'error' ? ' err' : ''}"><span>${esc(ps.message || ps.stage)}${ps.total ? ` ${Math.round((ps.done || 0) / ps.total * 100)}%` : ''}</span><div class="bar"><i style="width:${ps.total ? Math.round((ps.done || 0) / ps.total * 100) : (ps.stage === 'error' ? 100 : 20)}%"></i></div></div>` : '';
    const expHtml = exporting.map((x) => `<div class="rprogress${x.stage === 'error' ? ' err' : ''}"><span>${esc(x.message || 'Exporting…')}</span><div class="bar"><i style="width:${x.stage === 'error' ? 100 : (x.percent || 10)}%"></i></div></div>`).join('');
    const mp4 = ui.health?.mp4;
    const exportMenu = done ? `<div class="menu-wrap"><button class="btn btn-primary btn-sm" data-action="menu" data-menu="export:${r.id}" ${exporting.length ? 'disabled' : ''}>${icon('download', 14)} ${exporting.length ? 'Exporting…' : 'Export'} ${icon('chevron', 12)}</button>
      <div class="menu" id="menu-export:${r.id}">
        <button class="menu-item" data-action="export" data-kind="video" data-id="${r.id}" ${mp4 && !mp4.available ? 'disabled' : ''}><span class="mi-ico">${icon('video', 16)}</span><span><b>Video · MP4</b><small>${mp4 && !mp4.available ? 'Needs ffmpeg with H.264. Run npm install.' : r.highRes?.width ? `High quality H.264 at ${r.highRes.width} × ${r.highRes.height}` : 'High quality H.264'}</small></span></button>
        <button class="menu-item" data-action="export" data-kind="screens" data-id="${r.id}"><span class="mi-ico">${icon('image', 16)}</span><span><b>Screens · WebP</b><small>${r.analysisSummary ? `${r.analysisSummary.screens} clean screens as a ZIP` : 'Extracts the clean screens first, then downloads a ZIP'}</small></span></button>
      </div></div>` : '';
    const more = `<div class="menu-wrap"><button class="btn btn-quiet btn-sm" data-action="menu" data-menu="more:${r.id}" title="More">${icon('more', 16)}</button>
      <div class="menu small" id="menu-more:${r.id}">
        <button class="menu-item" data-action="folder" data-id="${r.id}"><span class="mi-ico">${icon('folder', 15)}</span><span><b>Show in folder</b></span></button>
        ${done ? `<button class="menu-item" data-action="process" data-id="${r.id}"><span class="mi-ico">${icon('refresh', 15)}</span><span><b>${r.analysisSummary ? 'Re-extract screens' : 'Extract screens'}</b></span></button>` : ''}
        <button class="menu-item danger" data-action="delete" data-id="${r.id}"><span class="mi-ico">${icon('trash', 15)}</span><span><b>Delete</b></span></button>
      </div></div>`;
    return `<div class="rtitle">${esc(hostOf(r.url))}<small>${esc(pathOf(r.url).slice(0, 40))}</small></div>
      <div class="rsub">${esc(fmtDate(r.startedAt))}${dur != null ? ` · ${fmtTime(dur)}` : ''}</div>
      <div class="rchips">${chips.join('')}</div>
      ${r.status === 'interrupted' ? `<div class="rnote">${esc(r.note || 'This recording was cut short. Everything captured up to that moment was kept.')}</div>` : ''}
      ${procHtml}${expHtml}
      <div class="ractions">${done ? `<button class="btn btn-sm" data-action="view" data-id="${r.id}">${icon('layers', 14)} View</button>` : ''}${exportMenu}<span class="grow"></span>${more}</div>`;
  }
  function buildCard(r) {
    const a = document.createElement('article'); a.className = 'rcard'; a.dataset.id = r.id;
    const dur = r.durationMs ?? r.video?.durationMs;
    a.innerHTML = `<div class="rthumb" data-action="view" data-id="${r.id}"><video muted playsinline preload="metadata"></video><span class="rthumb-wait"></span><span class="tag ${r.mode === 'ai' ? 'ai' : ''}">${r.mode === 'ai' ? `${icon('sparkles', 12)} AI Agent` : `${icon('cursor', 12)} Manual`}</span><span class="dur">${dur != null ? fmtTime(dur) : '…'}</span><span class="play"><span>${icon('play', 22)}</span></span></div><div class="rbody"></div>`;
    return a;
  }
  function renderLibrary() {
    const list = ui.recordings;
    el.recordingsDir.textContent = ui.health?.recordingsDir || '';
    el.recordingsSub.textContent = list.length ? `${list.length} recording${list.length > 1 ? 's' : ''}, newest first` : 'Your recordings will appear here';
    if (!list.length) { el.gallery.innerHTML = `<div class="empty-library"><b>No recordings yet</b>Your first recording shows up here with its video, screens and exports.</div>`; ui.cards.clear(); return; }
    el.gallery.querySelector('.empty-library')?.remove();
    const seen = new Set();
    for (const r of list) {
      seen.add(r.id);
      let c = ui.cards.get(r.id);
      if (!c) { c = buildCard(r); ui.cards.set(r.id, c); }
      c.classList.toggle('live', ui.state.recordingId === r.id && busy() && recState() !== 'idle');
      const dur = r.durationMs ?? r.video?.durationMs; c.querySelector('.dur').textContent = dur != null ? fmtTime(dur) : '…';
      // Attach the video only once the file is complete; a half-written file would fail to load and never retry.
      const ready = ['completed', 'interrupted'].includes(r.status) && r.hasVideo;
      const vid = c.querySelector('video'); const wait = c.querySelector('.rthumb-wait');
      if (ready && c.dataset.src !== '1') { c.dataset.src = '1'; vid.src = `/recordings/${encodeURIComponent(r.id)}/recording.webm#t=0.8`; }
      wait.innerHTML = ready ? '' : (r.status === 'recording' ? '<span class="live-dot"></span>Recording…' : '');
      wait.style.display = ready ? 'none' : 'flex';
      c.querySelector('.rbody').innerHTML = cardBody(r);
      if (ui.menu) { const m = c.querySelector(`[id="menu-${ui.menu}"]`); if (m) m.classList.add('open'); }
      el.gallery.appendChild(c); // keeps newest-first order without recreating the video thumbnails
    }
    for (const [id, c] of ui.cards) if (!seen.has(id)) { c.remove(); ui.cards.delete(id); }
  }
  el.gallery.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-action]'); if (!t) return; e.stopPropagation();
    const { action, id, kind, menu } = t.dataset;
    if (action === 'menu') { const open = ui.menu === menu; closeMenus(); if (!open) { ui.menu = menu; document.getElementById(`menu-${menu}`)?.classList.add('open'); } return; }
    closeMenus();
    if (action === 'view') openViewer(id);
    else if (action === 'export') startExport(id, kind);
    else if (action === 'folder') act(() => api(`/api/recordings/${encodeURIComponent(id)}/open`, { method: 'POST' }));
    else if (action === 'process') act(() => api(`/api/recordings/${encodeURIComponent(id)}/process`, { method: 'POST', body: {} }), 'Extracting clean screens…');
    else if (action === 'delete') { if (confirm('Delete this recording? The video, screens and metadata are removed from disk.')) { await act(() => api(`/api/recordings/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'Recording deleted'); loadRecordings(); } }
  });
  function closeMenus() { ui.menu = null; document.querySelectorAll('.menu.open').forEach((m) => m.classList.remove('open')); }
  document.addEventListener('click', closeMenus);

  async function startExport(id, kind) {
    ui.exports[`${id}:${kind}`] = { id, kind, stage: 'working', percent: 0, message: kind === 'video' ? 'Preparing MP4…' : 'Preparing screens…' };
    renderLibrary(); renderViewerActions();
    try { await api(`/api/recordings/${encodeURIComponent(id)}/export`, { method: 'POST', body: { kind } }); }
    catch (err) { delete ui.exports[`${id}:${kind}`]; renderLibrary(); renderViewerActions(); toast(err.message, 'error'); }
  }
  function triggerDownload(url) { const a = document.createElement('a'); a.href = url; a.download = ''; document.body.appendChild(a); a.click(); a.remove(); }

  // ───────────────────────── Viewer ─────────────────────────
  async function openViewer(id) {
    ui.viewerId = id; el.viewer.classList.remove('hidden'); document.body.style.overflow = 'hidden';
    el.viewerCard.innerHTML = '<div style="padding:60px;text-align:center"><span class="spinner" style="margin:auto"></span></div>';
    try { renderViewer(await api(`/api/recordings/${encodeURIComponent(id)}`)); } catch (err) { el.viewerCard.innerHTML = `<div class="viewer-empty">${esc(err.message)}</div>`; }
  }
  function closeViewer() { ui.viewerId = null; el.viewer.classList.add('hidden'); document.body.style.overflow = ''; el.viewerCard.innerHTML = ''; }
  function renderViewerActions() {
    const box = $('viewerActions'); if (!box || !ui.viewerId) return;
    const id = ui.viewerId; const working = (k) => ui.exports[`${id}:${k}`]?.stage === 'working'; const mp4 = ui.health?.mp4;
    box.innerHTML = '';
    box.appendChild(btn(`${icon('video', 15)} ${working('video') ? 'Preparing MP4…' : 'Video · MP4'}`, 'btn btn-primary btn-sm', () => startExport(id, 'video'), { disabled: working('video') || (mp4 && !mp4.available) }));
    box.appendChild(btn(`${icon('image', 15)} ${working('screens') ? 'Preparing…' : 'Screens · WebP'}`, 'btn btn-sm', () => startExport(id, 'screens'), { disabled: working('screens') }));
    box.appendChild(btn(icon('x', 16), 'btn btn-quiet btn-sm', closeViewer, { title: 'Close (Esc)' }));
  }
  function renderViewer(r) {
    const a = r.analysis; const v = r.video || {}; const portrait = (r.viewport?.height || 0) > (r.viewport?.width || 0);
    const dur = r.durationMs ?? v.durationMs;
    const stats = [`<span class="chip">${icon('window', 13)} ${r.highRes?.width ? `${r.highRes.width} × ${r.highRes.height} MP4` : `${v.width} × ${v.height}`}</span>`, `<span class="chip">${fmtTime(dur)}</span>`, `<span class="chip">${fmtBytes(r.fileSizeBytes)}</span>`, `<span class="chip">${esc(fmtDate(r.startedAt))}</span>`];
    if (r.ai?.summary?.endReason) stats.push(`<span class="chip ai">${icon('sparkles', 13)} ${esc(r.ai.summary.endReason)}</span>`);
    const flowChips = (a?.flow || []).map((f, i) => `${i ? `<span class="flow-arrow">${icon('arrow', 13)}</span>` : ''}<span class="flow-chip"><span>${esc(f)}</span></span>`).join('');
    el.viewerCard.innerHTML = `
      <div class="viewer-head"><div class="viewer-title"><h3>${esc(hostOf(r.url))}${esc(pathOf(r.url).slice(0, 50))}</h3><p>${r.mode === 'ai' ? 'AI Agent' : 'Manual'} recording · ${esc(r.id)}</p></div><div class="viewer-actions" id="viewerActions"></div></div>
      <div class="viewer-body">
        <div class="viewer-video viewer-section"><video controls preload="metadata" playsinline src="/recordings/${encodeURIComponent(r.id)}/recording.webm"></video><div class="viewer-stats">${stats.join('')}</div></div>
        <div>
          ${a ? `<div class="viewer-section"><h4>Flow</h4><div class="flow-line">${flowChips || '<span class="muted">No named flow.</span>'}</div><div class="viewer-stats"><span class="chip ok">${a.screens.length} clean screens</span><span class="chip">${a.stats.frames} frames sampled</span><span class="chip">${a.stats.duplicates} duplicates removed</span><span class="chip">${(a.stats.loading || 0) + (a.stats.transitions || 0) + (a.stats.partial || 0) + (a.stats.blank || 0)} loading / transition frames dropped</span></div></div>
          <div class="viewer-section"><h4>Screens</h4><div class="screens-grid">${a.screens.map((s) => `<figure class="screen-tile${portrait ? ' portrait' : ''}"><a href="/recordings/${encodeURIComponent(r.id)}/${esc(s.file || s.thumb)}" target="_blank" rel="noopener"><img loading="lazy" decoding="async" src="/recordings/${encodeURIComponent(r.id)}/${esc(s.file || s.thumb)}" alt="${esc(s.name)}"></a><figcaption><span class="n" title="${esc(s.name)}">${esc(s.name)}</span><span class="s">${fmtTime(s.timeMs)}${s.width ? ` · ${s.width}×${s.height}` : ''}</span></figcaption></figure>`).join('')}</div></div>`
          : `<div class="viewer-empty"><b>Screens are not extracted yet</b><br>Turn the video into clean, deduplicated screens: loading and in-between frames are removed.<br><button class="btn btn-primary" id="viewerExtract">${icon('layers', 15)} Extract clean screens</button></div>`}
        </div>
      </div>`;
    renderViewerActions();
    $('viewerExtract')?.addEventListener('click', () => { act(() => api(`/api/recordings/${encodeURIComponent(r.id)}/process`, { method: 'POST', body: {} })); });
  }
  el.viewer.addEventListener('click', (e) => { if (e.target === el.viewer) closeViewer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && ui.viewerId) closeViewer(); });

  // ───────────────────────── Preview interaction ─────────────────────────
  function previewCoords(ev) {
    const rect = el.previewImg.getBoundingClientRect(); const vp = ui.state.viewport; if (!vp || !rect.width) return null;
    const scale = Math.min(rect.width / vp.width, rect.height / vp.height); const dw = vp.width * scale, dh = vp.height * scale;
    const x = (ev.clientX - (rect.left + (rect.width - dw) / 2)) / scale, y = (ev.clientY - (rect.top + (rect.height - dh) / 2)) / scale;
    return x < 0 || y < 0 || x > vp.width || y > vp.height ? null : { x: Math.round(x), y: Math.round(y) };
  }
  const sendInput = (body) => api('/api/session/input', { method: 'POST', body }).catch((err) => toast(err.message, 'error'));
  el.previewImg.addEventListener('click', (ev) => { const c = previewCoords(ev); if (!c || !ui.state.browserOpen) return; el.previewFrame.focus(); sendInput({ type: 'click', ...c, clickCount: ev.detail > 1 ? 2 : 1 }); });
  el.previewImg.addEventListener('contextmenu', (ev) => { ev.preventDefault(); const c = previewCoords(ev); if (c && ui.state.browserOpen) sendInput({ type: 'click', ...c, button: 'right' }); });
  el.previewImg.addEventListener('wheel', (ev) => { const c = previewCoords(ev); if (!c || !ui.state.browserOpen) return; ev.preventDefault(); sendInput({ type: 'wheel', ...c, deltaX: Math.round(ev.deltaX), deltaY: Math.round(ev.deltaY) }); }, { passive: false });
  let moveTimer = null;
  el.previewImg.addEventListener('mousemove', (ev) => { if (!ui.state.browserOpen || moveTimer) return; moveTimer = setTimeout(() => { moveTimer = null; }, 120); const c = previewCoords(ev); if (c) sendInput({ type: 'move', ...c }); });
  el.previewFrame.addEventListener('keydown', (ev) => {
    if (!ui.state.browserOpen) return;
    if (ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey) { ev.preventDefault(); sendInput({ type: 'type', text: ev.key }); return; }
    const keys = { Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Escape: 'Escape', ArrowDown: 'ArrowDown', ArrowUp: 'ArrowUp', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Delete: 'Delete', ' ': 'Space', Home: 'Home', End: 'End', PageDown: 'PageDown', PageUp: 'PageUp' };
    if (keys[ev.key]) { ev.preventDefault(); sendInput({ type: 'key', key: keys[ev.key] }); }
  });

  // ───────────────────────── WebSocket ─────────────────────────
  function connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'blob';
    let previewLoading = false;
    let pendingPreview = null;
    const showPreview = (blob) => {
      previewLoading = true;
      const url = URL.createObjectURL(blob);
      const old = ui.previewUrlObj;
      ui.previewUrlObj = url;
      el.previewImg.onload = () => {
        if (old) URL.revokeObjectURL(old);
        previewLoading = false;
        if (pendingPreview) { const next = pendingPreview; pendingPreview = null; showPreview(next); }
      };
      el.previewImg.onerror = () => {
        URL.revokeObjectURL(url);
        previewLoading = false;
        if (pendingPreview) { const next = pendingPreview; pendingPreview = null; showPreview(next); }
      };
      el.previewImg.src = url;
      el.previewFrame.classList.add('live');
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof Blob) {
        if (previewLoading) pendingPreview = ev.data;
        else showPreview(ev.data);
        return;
      }
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'hello': ui.state = msg.state; ui.log = msg.log || []; ui.sig = { cta: '', dock: '', flow: '', banner: '' }; renderAll(); break;
        case 'state': {
          const was = ui.state; ui.state = msg.state; ui.launching = ui.launching && msg.state.phase === 'launching';
          const changed = was.phase !== msg.state.phase || was.recordingId !== msg.state.recordingId || was.browserOpen !== msg.state.browserOpen || was.mode !== msg.state.mode;
          if (changed) { renderSetup(); renderLibrary(); if (was.phase !== msg.state.phase) loadRecordings(); } renderStage();
          break;
        }
        case 'log': ui.log.push(msg.entry); if (ui.log.length > 400) ui.log.shift(); renderActivity(); if (msg.entry.level === 'error' && /sign-in page/i.test(msg.entry.message)) toast(msg.entry.message, 'error'); break;
        case 'ai': if (msg.event.type === 'done') toast(`AI exploration finished: ${msg.event.summary.endReason}`, 'ok'); break;
        case 'processing': {
          const p = msg.progress; ui.processing[p.id] = p;
          if (p.stage === 'done') { toast(`Clean screens ready: ${p.message}`, 'ok'); loadRecordings(); if (ui.viewerId === p.id) openViewer(p.id); }
          else if (p.stage === 'error') toast(`Extracting screens failed: ${p.message}`, 'error');
          renderLibrary(); renderDock(); break;
        }
        case 'export': {
          const p = msg.progress; ui.exports[`${p.id}:${p.kind}`] = p;
          if (p.stage === 'done') { toast(`${p.kind === 'video' ? 'MP4' : 'Screens ZIP'} ready (${fmtBytes(p.sizeBytes)}). Downloading…`, 'ok'); triggerDownload(p.downloadUrl); delete ui.exports[`${p.id}:${p.kind}`]; }
          else if (p.stage === 'error') { toast(`Export failed: ${p.message}`, 'error'); setTimeout(() => { delete ui.exports[`${p.id}:${p.kind}`]; renderLibrary(); renderViewerActions(); }, 6000); }
          renderLibrary(); renderViewerActions(); break;
        }
        case 'recording-saved': loadRecordings(); break;
        case 'recording-updated': loadRecordings(); break;
        default: break;
      }
    };
    ws.onclose = () => setTimeout(connect, 1500);
  }

  function renderAll() { renderSetup(); renderStage(); renderLibrary(); }

  // ───────────────────────── init ─────────────────────────
  async function init() {
    $('urlIcon').innerHTML = icon('globe', 18); $('urlbarIcon').innerHTML = icon('lock', 14);
    $('iconManual').innerHTML = icon('cursor', 18); $('iconAi').innerHTML = icon('sparkles', 18);
    document.querySelectorAll('.mode-check').forEach((c) => { c.innerHTML = icon('check', 12); });
    $('emptyArt').innerHTML = icon('window', 38);
    $('openRootBtn').innerHTML = `${icon('folder', 16)} <span class="btn-label">Recordings folder</span>`;
    $('refreshRecordings').innerHTML = `${icon('refresh', 14)} <span class="btn-label">Refresh</span>`;

    el.url.value = store.get('url', ''); ui.mode = store.get('mode', 'manual'); ui.brain = store.get('brain', 'auto'); ui.presetId = store.get('preset', 'desktop-1440');
    ui.browser = store.get('browser', 'chromium'); el.autoStart.checked = store.get('autoStart', false); el.followSignIn.checked = store.get('followSignIn', true);
    el.scale.value = store.get('scale', '2'); el.videoScale.value = store.get('videoScale', '2');

    el.modeManual.onclick = () => { ui.mode = 'manual'; store.set('mode', 'manual'); ui.sig.cta = ''; renderSetup(); };
    el.modeAi.onclick = () => { ui.mode = 'ai'; store.set('mode', 'ai'); ui.sig.cta = ''; renderSetup(); };
    el.aiOptions.addEventListener('toggle', () => { el.aiOptions.dataset.touched = '1'; });
    el.url.addEventListener('input', () => { el.urlWrap.classList.remove('invalid'); el.urlError.classList.add('hidden'); });
    el.url.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && !busy()) launch(ui.mode); });
    [el.customW, el.customH].forEach((i) => i.addEventListener('input', () => { renderPreviewFrame(); renderStageHead(); renderQualityHints(); }));
    for (const b of el.browserSeg.querySelectorAll('.seg-btn')) b.onclick = () => { if (!b.disabled) { ui.browser = b.dataset.browser; store.set('browser', ui.browser); renderBrowserOptions(); } };
    el.videoScale.addEventListener('change', () => { store.set('videoScale', el.videoScale.value); renderQualityHints(); renderStageHead(); });
    el.scale.addEventListener('change', () => { store.set('scale', el.scale.value); renderQualityHints(); });
    el.autoStart.addEventListener('change', () => store.set('autoStart', el.autoStart.checked));
    el.followSignIn.addEventListener('change', () => store.set('followSignIn', el.followSignIn.checked));
    el.activityToggle.onclick = () => { ui.activityOpen = !ui.activityOpen; renderActivity(); };
    $('openRootBtn').onclick = () => act(() => api('/api/recordings-folder/open', { method: 'POST' }));
    $('refreshRecordings').onclick = loadRecordings;

    try {
      ui.health = await api('/api/health');
      ui.presets = ui.health.presets; ui.state = ui.health.state;
      if (!ui.presets.some((p) => p.id === ui.presetId) && ui.presetId !== 'custom') ui.presetId = ui.presets[0].id;
      el.limMinutes.value = ui.health.aiDefaults.maxMinutes; el.limScreens.value = ui.health.aiDefaults.maxScreens; el.limSteps.value = ui.health.aiDefaults.maxSteps;
      if (!ui.health.ffmpeg.available) { el.ffWarn.textContent = ui.health.ffmpeg.installHint; el.ffWarn.classList.remove('hidden'); }
    } catch (err) { toast(`Cannot reach the recorder server: ${err.message}`, 'error'); }
    renderAll(); loadRecordings(); connect();
    setInterval(async () => { if (!busy()) { try { ui.health = await api('/api/health'); renderBrains(); } catch { /* offline */ } } }, 30000);
  }
  init();
})();
