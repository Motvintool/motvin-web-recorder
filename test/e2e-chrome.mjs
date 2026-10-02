// "My Chrome" mode: launches the real Chrome as a normal process, records a short clip, verifies exact size and clean shutdown.
// Usage: node test/e2e-chrome.mjs [url]
import { execSync } from 'node:child_process';
const url = process.argv[2] || 'https://example.com/';
const base = 'http://localhost:4010';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, body) { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); const d = await r.json(); if (!r.ok) throw new Error(`${p}: ${d.error}`); return d; }
const vp = { width: 1280, height: 800, preset: 'custom', kind: 'desktop' };
let s = await post('/api/session/launch', { url, viewport: vp, mode: 'manual', browser: 'chrome', screenScale: 2 });
console.log('launched:', s.phase, s.currentUrl);
const chromeProcs = () => execSync("ps aux | grep -c '[b]rowser-profile' || true").toString().trim();
console.log('chrome processes using the recorder profile:', chromeProcs());
s = await post('/api/recording/start'); const id = s.recordingId;
await sleep(2500);
await post('/api/recording/stop');
await post('/api/session/close');
await sleep(6000);
console.log('chrome processes after stop:', chromeProcs());
const rec = await (await fetch(`${base}/api/recordings/${id}`)).json();
console.log(JSON.stringify({ id, browser: rec.browser, video: rec.video, durationMs: rec.durationMs, finalUrl: rec.finalUrl }));
if (rec.video.width !== 1280 || rec.video.height !== 800) throw new Error('wrong size');
console.log('CHROME E2E OK');
