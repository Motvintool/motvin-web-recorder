// End-to-end check of the Manual flow against a running recorder server.
// Usage: node test/e2e-manual.mjs [url] [port]
const url = process.argv[2] || 'https://example.com';
const base = `http://localhost:${process.argv[3] || 4010}`;
const [vw, vh] = (process.argv[4] || '1280x800').split('x').map(Number);
const viewport = { width: vw, height: vh, preset: 'custom', kind: vw < 600 ? 'mobile' : 'desktop' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, body) {
  const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
  const data = await res.json();
  if (!res.ok) throw new Error(`${p} → ${res.status}: ${data.error}`);
  return data;
}
const t0 = Date.now();
const log = (...a) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
let s = await post('/api/session/launch', { url, viewport, mode: 'manual' });
log('launched:', s.phase, s.currentUrl);
s = await post('/api/recording/start');
log('recording:', s.phase, s.recordingId);
await sleep(2500);
await post('/api/session/input', { type: 'wheel', x: Math.round(vw / 2), y: Math.round(vh / 2), deltaY: 700 });
log('scrolled down');
await sleep(1500);
await post('/api/session/input', { type: 'wheel', x: Math.round(vw / 2), y: Math.round(vh / 2), deltaY: -700 });
log('scrolled up');
await sleep(1000);
s = await post('/api/recording/pause');
log('paused at', s.recording.durationMs, 'ms');
const pausedAt = s.recording.durationMs;
await sleep(3000);
s = await post('/api/recording/resume');
log('resumed; duration still', s.recording.durationMs, 'ms (paused clock must not advance)');
if (Math.abs(s.recording.durationMs - pausedAt) > 150) throw new Error('Recorded clock advanced while paused');
await sleep(2500);
await post('/api/session/input', { type: 'click', x: Math.round(vw / 2), y: Math.round(vh / 3) });
await sleep(1500);
const out = await post('/api/recording/stop');
const r = out.recording;
log('stopped:', out.state.phase, '(browser stays open for another recording)');
await post('/api/session/close');
console.log(JSON.stringify({ id: r.id, durationMs: r.durationMs, pauseCount: r.pauseCount, pausedMs: r.pausedMs, framesWritten: r.framesWritten, fileSizeBytes: r.fileSizeBytes, video: r.video, location: r.location }, null, 1));
const expectDur = r.durationMs;
if (!r.video || r.video.width !== vw || r.video.height !== vh) throw new Error('WebM dimensions do not match the viewport');
if (!r.highRes || r.highRes.width < vw * 2 || r.highRes.height < vh * 2) throw new Error('Expected a 2x high-resolution MP4, got ' + JSON.stringify(r.highRes));
console.log('high-res MP4:', r.highRes.width + 'x' + r.highRes.height);
if (Math.abs(r.video.durationMs - expectDur) > 600) throw new Error(`Container duration ${r.video.durationMs} differs from recorded ${expectDur}`);
console.log('MANUAL E2E OK');
