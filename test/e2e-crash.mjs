// Kills the recorder server with SIGKILL in the middle of a recording, restarts it, and checks the recording is recovered.
// Usage: node test/e2e-crash.mjs   (starts/stops its own server on port 4020)
import { spawn, execSync } from 'node:child_process';
const PORT = 4020; const base = `http://localhost:${PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const env = { ...process.env, MOTVIN_RECORDER_PORT: String(PORT) };
for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL']) delete env[k];
const startServer = async () => { const p = spawn('node', ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let out = ''; p.stdout.on('data', (d) => out += d); for (let i = 0; i < 40 && !out.includes('http://localhost'); i++) await sleep(150); return { p, get out() { return out; } }; };
async function post(p, body) { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); const d = await r.json(); if (!r.ok) throw new Error(`${p}: ${d.error}`); return d; }
let srv = await startServer();
await post('/api/session/launch', { url: 'https://books.toscrape.com', viewport: { width: 1280, height: 800, preset: 'custom', kind: 'desktop' }, mode: 'manual' });
const { recordingId: id } = await post('/api/recording/start');
await sleep(9000);
const kids = execSync(`pgrep -P ${srv.p.pid} || true`).toString().split('\n').filter(Boolean);
srv.p.kill('SIGKILL'); await sleep(500);
for (const k of kids) { try { execSync(`pkill -9 -P ${k} || true; kill -9 ${k} || true`); } catch { /* gone */ } }
console.log(`killed the server (SIGKILL) ${9}s into recording ${id}`);
srv = await startServer();
console.log(srv.out.split('\n').filter((l) => /Recovered/.test(l)).join('\n') || '(no recovery line!)');
const rec = await (await fetch(`${base}/api/recordings/${id}`)).json();
console.log(JSON.stringify({ status: rec.status, durationMs: rec.durationMs, video: rec.video, highRes: rec.highRes, note: rec.note }, null, 1));
if (rec.status !== 'interrupted') throw new Error('recording was not marked interrupted');
if (!(rec.durationMs > 6000)) throw new Error('recovered duration is too short: ' + rec.durationMs);
await post(`/api/recordings/${id}/export`, { kind: 'video' });
let ok = false; for (let i = 0; i < 60 && !ok; i++) { await sleep(500); ok = (await fetch(`${base}/api/recordings/${id}/download/video`)).ok; }
if (!ok) throw new Error('MP4 export of the recovered recording failed');
const mp4 = Buffer.from(await (await fetch(`${base}/api/recordings/${id}/download/video`)).arrayBuffer());
console.log('exported MP4 from the recovered recording:', mp4.length, 'bytes');
srv.p.kill('SIGTERM'); await sleep(1000);
console.log('CRASH RECOVERY OK', id);
