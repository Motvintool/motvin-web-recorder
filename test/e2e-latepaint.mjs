// A page whose main content arrives late (no user input) must give ONE screen: the finished one.
import http from 'node:http';
const base = 'http://localhost:4010';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const html = (title, body) => `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="margin:0;font:40px system-ui;background:#fafafa"><h1 style="margin:30px">${title}</h1>${body}`;
const srv = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url === '/slow') return res.end(html('Slow product', `<p style="margin:30px">Some text is here immediately.</p><div id="late"></div><script>setTimeout(() => { document.getElementById('late').innerHTML = '<div style="margin:30px;width:520px;height:340px;background:linear-gradient(135deg,#6366f1,#ef4444)"></div><p style="margin:30px">Details arrived.</p>'; }, 1800);</script>`));
  if (req.url === '/end') return res.end(html('Checkout done', '<p style="margin:30px">All finished.</p>'));
  res.end(html('Start page', '<p style="margin:30px">Welcome.</p>'));
}).listen(8793);
async function post(p, body) { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); const d = await r.json(); if (!r.ok) throw new Error(`${p}: ${d.error}`); return d; }
const get = async (p) => (await fetch(base + p)).json();
await post('/api/session/launch', { url: 'http://localhost:8793/', viewport: { width: 1000, height: 640, preset: 'custom', kind: 'desktop' }, mode: 'manual' });
const { recordingId: id } = await post('/api/recording/start');
await sleep(2200);
await post('/api/session/input', { type: 'goto', url: 'http://localhost:8793/slow' }); await sleep(4500);
await post('/api/session/input', { type: 'goto', url: 'http://localhost:8793/end' }); await sleep(2500);
await post('/api/recording/stop'); await post('/api/session/close'); srv.close();
await post(`/api/recordings/${id}/process`);
for (let i = 0; i < 90; i++) { const st = await get('/api/state'); const p = st.processing?.[id]; if (p && ['done', 'error'].includes(p.stage)) break; await sleep(1000); }
const rec = await get(`/api/recordings/${id}`);
console.log('screens:', rec.analysis.screens.map((x) => x.name));
const slow = rec.analysis.screens.filter((x) => /slow/i.test(x.name));
if (slow.length !== 1) throw new Error(`expected exactly one "Slow product" screen, got ${slow.length}`);
for (const want of ['Home', 'Slow', 'Checkout']) if (!rec.analysis.screens.some((x) => x.name.includes(want))) throw new Error('missing ' + want);
console.log('LATE PAINT OK', id);
