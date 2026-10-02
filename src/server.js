// HTTP + WebSocket server for the Motvin Web Recorder UI.
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { WebSocketServer } from 'ws';
import { PORT, PUBLIC_DIR, RECORDINGS_DIR, VIEWPORT_PRESETS, AI_DEFAULTS, ANALYSIS_DEFAULTS, SCREEN_DEFAULTS, RECORDING_DEFAULTS, CHROME_PROFILE_DIR } from './config.js';
import { findChrome } from './browser/chrome.js';
import { findMp4Encoder } from './export/mp4.js';
import { findFfmpeg } from './recording/ffmpeg.js';
import { describeBackends } from './agent/brains/index.js';
import { SessionManager } from './manual/sessionManager.js';
import { listRecordings, getRecording, deleteRecording, openInFileBrowser, recordingDir, ensureRecordingsDir, recoverInterrupted } from './storage/recordingStore.js';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(PUBLIC_DIR, { etag: false, maxAge: 0 }));
app.use('/recordings', express.static(RECORDINGS_DIR, { etag: true, maxAge: '1h', index: false }));

const manager = new SessionManager();

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  const status = err.status || 400;
  res.status(status).json({ error: String(err.message || err) });
});

app.get('/api/health', wrap(async (_req, res) => {
  const ff = findFfmpeg({ refresh: true });
  const ai = await describeBackends();
  res.json({
    ok: true,
    ffmpeg: { available: ff.available, path: ff.path, source: ff.source, installHint: ff.available ? null : ff.installHint, capabilities: ff.capabilities },
    ai,
    presets: VIEWPORT_PRESETS,
    aiDefaults: AI_DEFAULTS,
    screenDefaults: SCREEN_DEFAULTS,
    videoDefaults: { scale: RECORDING_DEFAULTS.videoScale, fps: RECORDING_DEFAULTS.fps, maxPixels: RECORDING_DEFAULTS.maxVideoPixels },
    mp4: (() => { const e = findMp4Encoder(); return { available: e.available, source: e.source, installHint: e.installHint }; })(),
    chrome: { available: Boolean(findChrome()), path: findChrome(), profileDir: CHROME_PROFILE_DIR },
    analysisDefaults: ANALYSIS_DEFAULTS,
    recordingsDir: RECORDINGS_DIR,
    state: manager.state(),
  });
}));

app.get('/api/state', (_req, res) => res.json(manager.state()));

app.post('/api/session/launch', wrap(async (req, res) => {
  const { url, viewport, mode, ai, browser, screenScale, videoScale, autoStart, followSignIn } = req.body || {};
  const state = await manager.launch({ url, viewport, mode, ai, browser, screenScale, videoScale, autoStart: Boolean(autoStart), followSignIn });
  res.json(state);
}));
app.post('/api/session/close', wrap(async (_req, res) => res.json(await manager.closeSession())));
app.post('/api/session/input', wrap(async (req, res) => { await manager.input(req.body || {}); res.json({ ok: true }); }));

app.post('/api/recording/start', wrap(async (_req, res) => { await manager.startRecording(); res.json(manager.state()); }));
app.post('/api/recording/pause', wrap(async (_req, res) => { manager.pauseRecording(); res.json(manager.state()); }));
app.post('/api/recording/resume', wrap(async (_req, res) => { manager.resumeRecording(); res.json(manager.state()); }));
app.post('/api/recording/stop', wrap(async (req, res) => {
  const meta = await manager.stopRecording({ closeBrowser: req.body?.closeBrowser === true });
  res.json({ state: manager.state(), recording: meta });
}));

app.post('/api/ai/pause', wrap(async (_req, res) => { manager.pauseAi(); res.json(manager.state()); }));
app.post('/api/ai/resume', wrap(async (_req, res) => { manager.resumeAi(); res.json(manager.state()); }));
app.post('/api/ai/stop', wrap(async (_req, res) => { manager.stopAi(); res.json(manager.state()); }));

app.get('/api/recordings', wrap(async (_req, res) => res.json(await listRecordings())));
app.get('/api/recordings/:id', wrap(async (req, res) => {
  const rec = await getRecording(req.params.id);
  if (!rec) return res.status(404).json({ error: 'Recording not found' });
  res.json(rec);
}));
app.delete('/api/recordings/:id', wrap(async (req, res) => {
  if (manager.recordingId === req.params.id && manager.busy) throw new Error('This recording is still in progress.');
  await deleteRecording(req.params.id);
  res.json({ ok: true });
}));
app.post('/api/recordings/:id/process', wrap(async (req, res) => {
  const id = req.params.id;
  if (!fs.existsSync(recordingDir(id))) return res.status(404).json({ error: 'Recording not found' });
  const opts = { intervalSeconds: Number(req.body?.intervalSeconds) || undefined, keepAllFrames: req.body?.keepAllFrames };
  // Run in the background; progress arrives over the WebSocket.
  manager.process(id, opts).catch(() => {});
  res.json({ ok: true, started: true });
}));
app.post('/api/recordings/:id/export', wrap(async (req, res) => {
  const id = req.params.id; const kind = req.body?.kind;
  if (!fs.existsSync(recordingDir(id))) return res.status(404).json({ error: 'Recording not found' });
  if (!['video', 'screens'].includes(kind)) return res.status(400).json({ error: 'kind must be "video" or "screens"' });
  if (kind === 'video' && !findMp4Encoder().available) return res.status(400).json({ error: findMp4Encoder().installHint });
  // Runs in the background; progress and the download link arrive over the WebSocket.
  manager.export(id, kind).catch(() => {});
  res.json({ ok: true, started: true });
}));
app.get('/api/recordings/:id/download/:kind', wrap(async (req, res) => {
  const { id, kind } = req.params;
  const dir = recordingDir(id);
  const file = kind === 'video' ? path.join(dir, 'recording.mp4') : kind === 'screens' ? path.join(dir, 'screens.zip') : null;
  if (!file) return res.status(400).json({ error: 'Unknown export kind' });
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'Export not prepared yet. Start the export first.' });
  res.download(file, kind === 'video' ? `${id}.mp4` : `${id}-screens.zip`);
}));
app.post('/api/recordings/:id/open', wrap(async (req, res) => {
  const dir = recordingDir(req.params.id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Recording not found' });
  await openInFileBrowser(dir);
  res.json({ ok: true, path: dir });
}));
app.post('/api/recordings-folder/open', wrap(async (_req, res) => { ensureRecordingsDir(); await openInFileBrowser(RECORDINGS_DIR); res.json({ ok: true, path: RECORDINGS_DIR }); }));

app.use((err, _req, res, _next) => { // eslint-disable-line no-unused-vars
  res.status(500).json({ error: String(err.message || err) });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) if (client.readyState === 1) client.send(data);
}
function broadcastBinary(buf) {
  for (const client of wss.clients) if (client.readyState === 1 && client.bufferedAmount < 2_000_000) client.send(buf, { binary: true });
}

manager.on('state', (state) => broadcast({ type: 'state', state }));
manager.on('log', (entry) => broadcast({ type: 'log', entry }));
manager.on('ai', (ev) => broadcast({ type: 'ai', event: ev }));
manager.on('export', (p) => broadcast({ type: 'export', progress: p }));
manager.on('processing', (p) => broadcast({ type: 'processing', progress: p }));
manager.on('recording-saved', (meta) => broadcast({ type: 'recording-saved', recording: meta }));
manager.on('recording-updated', (id) => broadcast({ type: 'recording-updated', id }));
manager.on('preview', (buf) => broadcastBinary(buf));

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'hello', state: manager.state(), log: manager.logBuffer.slice(-100) }));
  // A static page produces no new frames, so give a newly opened tab the latest one straight away.
  if (manager.lastPreview && manager.state().browserOpen) ws.send(manager.lastPreview, { binary: true });
});

// Periodic state ticks so durations advance in the UI without polling.
setInterval(() => { if (manager.busy) broadcast({ type: 'state', state: manager.state() }); }, 1000);

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  // Save any recording in progress and close the browser completely before exiting.
  try { await Promise.race([manager.shutdown(), new Promise((r) => setTimeout(r, 25000))]); } catch { /* noop */ }
  process.exit(0);
}
process.on('SIGHUP', shutdown);
process.on('uncaughtException', (err) => { console.error('Uncaught:', err); shutdown(); });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Finish recovering interrupted recordings BEFORE accepting requests, so nobody ever sees one half-fixed.
try { const ids = await recoverInterrupted(); if (ids.length) console.log(`Recovered ${ids.length} interrupted recording(s): ${ids.join(', ')}`); }
catch (err) { console.error('Recovery failed:', err.message); }

server.listen(PORT, () => {
  const ff = findFfmpeg();
  console.log(`Motvin Web Recorder → http://localhost:${PORT}`);
  console.log(`Recordings folder: ${RECORDINGS_DIR}`);
  console.log(ff.available ? `ffmpeg: ${ff.path} (${ff.source})` : `ffmpeg: NOT FOUND — ${ff.installHint}`);
});
