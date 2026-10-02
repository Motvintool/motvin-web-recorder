// Export check: MP4 (video) and ZIP (screens) for an existing recording. Usage: node test/e2e-export.mjs <recordingId>
import fs from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
const id = process.argv[2]; const base = 'http://localhost:4010';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import WebSocket from 'ws';
const ws = new WebSocket('ws://localhost:4010/ws'); const events = [];
ws.on('message', (d, bin) => { if (bin) return; const m = JSON.parse(d.toString()); if (m.type === 'export') events.push(m.progress); });
await new Promise((r) => ws.on('open', r));
async function run(kind, outFile) {
  events.length = 0;
  const res = await fetch(`${base}/api/recordings/${id}/export`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind }) });
  if (!res.ok) throw new Error((await res.json()).error);
  let done; for (let i = 0; i < 300 && !done; i++) { await sleep(500); done = events.find((e) => e.kind === kind && (e.stage === 'done' || e.stage === 'error')); }
  if (!done || done.stage !== 'done') throw new Error(`${kind} export failed: ${done?.message}`);
  const dl = await fetch(base + done.downloadUrl); const buf = Buffer.from(await dl.arrayBuffer());
  fs.writeFileSync(outFile, buf);
  console.log(kind, 'downloaded', buf.length, 'bytes; disposition:', dl.headers.get('content-disposition'), '| progress events:', events.filter((e) => e.kind === kind).length);
}
await run('video', process.argv[3] || '/tmp/export.mp4');
await run('screens', process.argv[4] || '/tmp/export.zip');
ws.close();
