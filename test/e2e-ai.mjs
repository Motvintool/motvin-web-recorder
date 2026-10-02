// End-to-end check of the AI Agent flow against a running recorder server.
// Usage: node test/e2e-ai.mjs [url] [backend] [maxMinutes] [maxScreens] [maxSteps]
const url = process.argv[2] || 'https://example.com';
const backend = process.argv[3] || 'heuristic';
const limits = { maxMinutes: Number(process.argv[4] || 1.5), maxScreens: Number(process.argv[5] || 8), maxSteps: Number(process.argv[6] || 14) };
const base = 'http://localhost:4010';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, body) { const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); const d = await res.json(); if (!res.ok) throw new Error(`${p} → ${res.status}: ${d.error}`); return d; }
async function get(p) { const res = await fetch(base + p); return res.json(); }
const t0 = Date.now(); const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

let s = await post('/api/session/launch', { url, viewport: { width: 1280, height: 800, preset: 'desktop-1280', kind: 'desktop' }, mode: 'ai', ai: { backend, limits, autoProcess: true } });
log('launched in AI mode:', s.phase, 'recording state:', s.recording?.state, 'brain:', s.ai?.brain);
if (s.recording?.state !== 'recording') throw new Error('Recording did not start automatically');
let lastAction = ''; let pausedOnce = false; let recId = s.recordingId;
while (true) {
  await sleep(1500);
  s = await get('/api/state');
  const a = s.ai || {};
  if (a.currentAction && a.currentAction !== lastAction) { lastAction = a.currentAction; log(`${a.status} · ${a.currentScreen} · ${a.currentAction} · screens ${a.screens}/${a.unique} blocked ${a.blocked} · rec ${s.recording?.durationMs}ms`); }
  if (!pausedOnce && (a.steps || 0) >= 3) {
    pausedOnce = true;
    await post('/api/ai/pause'); log('paused AI');
    await sleep(2500);
    const st = await get('/api/state');
    if (!st.ai?.paused || st.recording?.state !== 'recording') throw new Error('Pause did not hold the AI while keeping the recording alive');
    if (!st.browserOpen) throw new Error('Browser closed while AI paused');
    await post('/api/ai/resume'); log('resumed AI');
  }
  if (s.phase === 'completed' || s.phase === 'idle' || s.phase === 'error') break;
  if (Date.now() - t0 > (limits.maxMinutes * 60 + 90) * 1000) throw new Error('Timed out waiting for the AI to finish');
}
log('session phase:', s.phase, s.error || '');
// Wait for processing (auto) to complete.
for (let i = 0; i < 120; i++) {
  const st = await get('/api/state');
  const p = st.processing?.[recId];
  if (p && (p.stage === 'done' || p.stage === 'error')) { log('processing:', p.stage, p.message); break; }
  await sleep(1000);
}
const rec = await get(`/api/recordings/${recId}`);
console.log(JSON.stringify({ id: rec.id, durationMs: rec.durationMs, video: rec.video, fileSizeBytes: rec.fileSizeBytes, ai: rec.ai?.summary, stats: rec.analysis?.stats, flow: rec.analysis?.flow, screens: rec.analysis?.screens?.map((x) => `${x.name} @${x.timeMs}ms`), agentScreens: rec.events?.screens?.map((x) => `${x.name}${x.blocked ? ' [blocked]' : ''} @${x.recordedMs}ms`) }, null, 1));
if (!rec.video || rec.video.width !== 1280 || rec.video.height !== 800) throw new Error('Video dimensions do not match the viewport');
if (!rec.analysis) throw new Error('Frames were not extracted');
if (/^AI error/.test(rec.ai?.summary?.endReason || '')) throw new Error(rec.ai.summary.endReason);
if ((rec.events?.screens?.length || 0) < 2) throw new Error('AI discovered fewer than 2 screens');
console.log('AI E2E OK');
