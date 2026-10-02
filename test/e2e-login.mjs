// A sign-in flow is mostly typing and small changes on ONE page. Every distinct state must become its own screen.
// Usage: node test/e2e-login.mjs [chromium|chrome]
import http from 'node:http';
const browser = process.argv[2] || 'chromium';
const base = 'http://localhost:4010'; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const css = 'body{margin:0;font:22px system-ui;background:#f4f5f8}h1{margin:40px 40px 20px}input,button{position:absolute;left:40px;width:420px;height:52px;font:22px system-ui;padding:0 14px;box-sizing:border-box}#e{top:150px}#p{top:230px}button{top:310px}button{background:#111;color:#fff;border:0;border-radius:8px}.err{position:absolute;left:40px;top:380px;color:#c0262d}';
const srv = http.createServer((q, r) => {
  r.setHeader('content-type', 'text/html; charset=utf-8');
  if (q.url === '/home') return r.end(`<title>Dashboard</title><style>${css}</style><h1>Welcome back</h1><p style="margin:0 40px">You are signed in.</p>`);
  r.end(`<title>Sign in</title><style>${css}</style><h1>Sign in</h1><input id="e" type="email" placeholder="Email"><input id="p" type="password" placeholder="Password"><button id="b">Sign in</button><div class="err" id="x"></div><script>let tries=0;document.getElementById('b').onclick=()=>{tries++; if(tries<2){document.getElementById('x').textContent='Incorrect password. Try again.';} else {location.href='/home';}}</script>`);
}).listen(8797);
async function post(p, body) { const r = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }); const d = await r.json(); if (!r.ok) throw new Error(`${p}: ${d.error}`); return d; }
const get = async (p) => (await fetch(base + p)).json();
const input = (b) => post('/api/session/input', b);
await post('/api/session/launch', { url: 'http://localhost:8797/login', viewport: { width: 1000, height: 640, preset: 'custom', kind: 'desktop' }, mode: 'manual', browser });
const { recordingId: id } = await post('/api/recording/start');
await sleep(2000);                                                          // 1 empty form
await input({ type: 'click', x: 200, y: 176 }); await input({ type: 'type', text: 'me@example.com' }); await sleep(1400);      // 2 email typed
await input({ type: 'click', x: 200, y: 256 }); await input({ type: 'type', text: 'secret123' }); await sleep(1400);           // 3 password typed
await input({ type: 'click', x: 200, y: 336 }); await sleep(1500);                                                              // 4 error shown
await input({ type: 'click', x: 200, y: 336 }); await sleep(2500);                                                              // 5 dashboard
await post('/api/recording/stop'); await post('/api/session/close'); srv.close();
await post(`/api/recordings/${id}/process`);
for (let i = 0; i < 90; i++) { const st = await get('/api/state'); const p = st.processing?.[id]; if (p && ['done', 'error'].includes(p.stage)) break; await sleep(800); }
const rec = await get(`/api/recordings/${id}`);
console.log(`${browser}: input detector worked: ${rec.events.activityTracked} | recorded input events: ${rec.events.activity?.length}`);
console.log('screens:', rec.analysis.screens.map((s) => `${s.name} @${(s.timeMs / 1000).toFixed(1)}s`));
console.log('stats:', JSON.stringify({ candidates: rec.analysis.stats.candidates, duplicates: rec.analysis.stats.duplicates, stillLoading: rec.analysis.stats.partial, selection: rec.analysis.stats.selection }));
const signIn = rec.analysis.screens.filter((s) => /sign in/i.test(s.baseName));
if (!rec.events.activityTracked || !(rec.events.activity?.length >= 3)) throw new Error('input was not detected');
if (signIn.length < 4) throw new Error(`expected at least 4 distinct sign-in states, got ${signIn.length}`);
if (!rec.analysis.screens.some((s) => /dashboard/i.test(s.baseName))) throw new Error('missing the dashboard screen');
console.log('LOGIN FLOW OK', id);
