// A Stop within a moment of Start (a stray double-click) must be refused; a normal Stop must work.
const base = 'http://localhost:4010';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, body) { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); return { ok: r.ok, status: r.status, data: await r.json() }; }
await post('/api/session/launch', { url: 'https://example.com', viewport: { width: 1280, height: 800, preset: 'custom', kind: 'desktop' }, mode: 'manual' });
await post('/api/recording/start');
await sleep(300);
const early = await post('/api/recording/stop');
console.log('stop after 0.3s ->', early.status, early.data.error);
if (early.ok) throw new Error('an immediate Stop should have been refused');
let s = await (await fetch(base + '/api/state')).json();
if (s.recording.state !== 'recording') throw new Error('recording should still be running');
await sleep(2500);
const late = await post('/api/recording/stop');
console.log('stop after 2.8s ->', late.status, late.ok ? 'saved' : late.data.error);
if (!late.ok) throw new Error('a normal Stop should work');
await post('/api/session/close');
console.log('STOP GUARD OK');
