// Manual recording that visits several similar pages quickly; checks every visited page becomes a screen.
// Usage: node test/e2e-manual-nav.mjs [port] [WxH]
const base = `http://localhost:${process.argv[2] || 4010}`;
const [vw, vh] = (process.argv[3] || '1280x800').split('x').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, body) { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); const d = await r.json(); if (!r.ok) throw new Error(`${p}: ${d.error}`); return d; }
async function get(p) { return (await fetch(base + p)).json(); }
const site = 'https://books.toscrape.com';
const visits = [
  ['/', 1600], ['/catalogue/category/books/travel_2/index.html', 1300], ['/catalogue/category/books/mystery_3/index.html', 1300],
  ['/catalogue/category/books/classics_6/index.html', 1300], ['/catalogue/a-light-in-the-attic_1000/index.html', 1500],
  ['/catalogue/tipping-the-velvet_999/index.html', 1500], ['/catalogue/soumission_998/index.html', 1500], ['/catalogue/page-2.html', 1600],
];
await post('/api/session/launch', { url: site, viewport: { width: vw, height: vh, preset: 'custom', kind: vw < 600 ? 'mobile' : 'desktop' }, mode: 'manual' });
const s = await post('/api/recording/start'); const id = s.recordingId;
await sleep(1600);
for (const [path, dwell] of visits.slice(1)) { await post('/api/session/input', { type: 'goto', url: site + path }); await sleep(dwell); }
await post('/api/recording/stop');
await post('/api/session/close');
await post(`/api/recordings/${id}/process`);
for (let i = 0; i < 90; i++) { const st = await get('/api/state'); const p = st.processing?.[id]; if (p && ['done', 'error'].includes(p.stage)) break; await sleep(1000); }
const rec = await get(`/api/recordings/${id}`);
console.log(JSON.stringify(rec.analysis.stats));
for (const sc of rec.analysis.screens) console.log(String(sc.timeMs).padStart(6), sc.name.padEnd(40), 'hold', sc.holdMs, sc.file);
console.log(`visited ${visits.length} pages, got ${rec.analysis.screens.length} screens`, id);
