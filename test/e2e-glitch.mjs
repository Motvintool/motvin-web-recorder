// A static page must give a static video: taking screen captures must not disturb what is recorded.
// Usage: node test/e2e-glitch.mjs [chromium|chrome] [screenScale] [videoScale]
import http from 'node:http';
import { createRequire } from 'node:module';
const sharp = createRequire(import.meta.url)('sharp');
import fs from 'node:fs';
const browser = process.argv[2] || 'chromium'; const screenScale = Number(process.argv[3] || 3); const videoScale = Number(process.argv[4] || 2);
const base = 'http://localhost:4010'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const srv = http.createServer((q, r) => { r.setHeader('content-type', 'text/html; charset=utf-8'); r.end('<title>Static</title><body style="margin:0;font:40px system-ui;background:linear-gradient(135deg,#fde68a,#a5b4fc)"><h1 style="margin:40px">A completely static page</h1><p style="margin:40px">Nothing here moves.</p>'); }).listen(8794);
async function post(p, body) { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); const d = await r.json(); if (!r.ok) throw new Error(`${p}: ${d.error}`); return d; }
await post('/api/session/launch', { url: 'http://localhost:8794/', viewport: { width: 1000, height: 640, preset: 'custom', kind: 'desktop' }, mode: 'manual', browser, screenScale, videoScale });
const { recordingId: id } = await post('/api/recording/start');
await sleep(9000); await post('/api/recording/stop'); await post('/api/session/close'); srv.close();
await post(`/api/recordings/${id}/process`);
for (let i = 0; i < 90; i++) { const st = await (await fetch(base + '/api/state')).json(); const p = st.processing?.[id]; if (p && ['done', 'error'].includes(p.stage)) break; await sleep(800); }
const rec = await (await fetch(`${base}/api/recordings/${id}`)).json();
const { computeFeatures, changedFraction } = await import('../src/analysis/imageFeatures.js');
const dir = `recordings/${id}/frames`; const files = fs.readdirSync(dir).filter((f) => /^frame-\d+\.png$/.test(f)).sort();
let prev = null; let worst = 0; let worstAt = 0;
for (let i = 0; i < files.length; i++) { const f = await computeFeatures(`${dir}/${files[i]}`); if (prev && i > 3) { const c = changedFraction(prev.detail, f.detail, 20); if (c > worst) { worst = c; worstAt = i * 0.3; } } prev = f; }
const caps = fs.existsSync(`recordings/${id}/captures`) ? fs.readdirSync(`recordings/${id}/captures`).length : 0;
console.log(`${browser}: screenScale ${screenScale}x videoScale ${videoScale}x | captures ${caps} | settle events ${rec.events.settled.length} | largest change between sampled frames after load: ${(worst * 100).toFixed(2)}% at ${worstAt.toFixed(1)}s`);
if (worst > 0.01) throw new Error('captures disturbed the video');
console.log('GLITCH-FREE', id);
