// Manual recording across tabs: A opens B in a NEW TAB, B navigates to C, C closes itself (back to A's tab).
// Expects the recording to contain screens for all of them. Usage: node test/e2e-tabs.mjs
import http from 'node:http';
const base = 'http://localhost:4010';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const page = (title, bg, body) => `<!doctype html><title>${title}</title><body style="margin:0;background:${bg};font:48px system-ui;color:#111"><h1 style="margin:40px">${title}</h1>${body}`;
const link = (href, text, extra = '') => `<a ${extra} href="${href}" style="position:absolute;left:50px;top:200px;width:500px;height:120px;background:#fff;border:3px solid #111;display:flex;align-items:center;justify-content:center;font-size:32px;text-decoration:none;color:#111">${text}</a>`;
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  if (req.url === '/b') return res.end(page('Page B — new tab', '#cfe3ff', link('/c', 'Go to C (same tab)')));
  if (req.url === '/c') return res.end(page('Page C — final', '#d6f5d6', `<button onclick="window.close()" style="position:absolute;left:50px;top:200px;width:500px;height:120px;font-size:32px">Close this tab</button>`));
  res.end(page('Page A — start', '#ffe9c7', link('/b', 'Open B in a NEW TAB', 'target="_blank"')));
}).listen(8791);
async function post(p, body) { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); const d = await r.json(); if (!r.ok) throw new Error(`${p}: ${d.error}`); return d; }
const get = async (p) => (await fetch(base + p)).json();
const click = (x, y) => post('/api/session/input', { type: 'click', x, y });
const browser = process.argv[2] || 'chromium';
await post('/api/session/launch', { url: 'http://localhost:8791/', viewport: { width: 1000, height: 640, preset: 'custom', kind: 'desktop' }, mode: 'manual', browser, videoScale: 2 });
const { recordingId: id } = await post('/api/recording/start');
await sleep(2000);
await click(300, 260); console.log('clicked: open B in a new tab'); await sleep(3500);
let s = await get('/api/state'); console.log('current url after new tab:', s.currentUrl);
await click(300, 260); console.log('clicked: B -> C'); await sleep(3000);
s = await get('/api/state'); console.log('current url:', s.currentUrl);
await click(300, 260); console.log('clicked: close tab C'); await sleep(3500);
s = await get('/api/state'); console.log('after closing C, current url:', s.currentUrl, '| phase', s.phase);
await post('/api/recording/stop'); await post('/api/session/close'); server.close();
await post(`/api/recordings/${id}/process`);
for (let i = 0; i < 90; i++) { const st = await get('/api/state'); const p = st.processing?.[id]; if (p && ['done', 'error'].includes(p.stage)) break; await sleep(1000); }
const rec = await get(`/api/recordings/${id}`);
console.log('screens:', rec.analysis.screens.map((x) => `${x.name} (${x.source})`));
const names = rec.analysis.screens.map((x) => x.name).join(' | ');
for (const want of ['Home', 'Page B', 'Page C']) if (!names.includes(want)) throw new Error(`missing screen: ${want}`);
console.log('TABS E2E OK', id);
