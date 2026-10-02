// Extracts frames from a WebM recording with ffmpeg. Two passes keep disk usage sane:
// an analysis pass at a reduced width for every sampled frame, then full-resolution extraction
// only for the frames chosen as clean screens.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

function run(bin, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 20000) err = err.slice(-20000); });
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(t); reject(new Error(`ffmpeg could not run: ${e.message}`)); });
    child.on('exit', (code) => { clearTimeout(t); if (code === 0) resolve(err); else reject(new Error(`ffmpeg exited with code ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`)); });
  });
}

/**
 * Samples one frame every `intervalSeconds` into `outDir` as PNG (frame-00001.png, …).
 * @returns {Promise<{frames: Array<{index:number, file:string, timeMs:number}>, strategy:string}>}
 */
export async function extractFrames({ ffmpegPath, videoPath, outDir, intervalSeconds = 0.3, width = null, durationMs = null, onProgress = () => {} }) {
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });
  const fps = 1 / intervalSeconds;
  const vf = [];
  if (width) vf.push(`scale=${width}:-2`);
  const pattern = path.join(outDir, 'frame-%05d.png');
  // Strategy A: constant output rate in one pass. Requires ffmpeg's frame-rate conversion.
  const argsA = ['-hide_banner', '-loglevel', 'error', '-y', '-i', videoPath, '-an', '-fps_mode', 'cfr', '-r', String(fps)];
  if (vf.length) argsA.push('-vf', vf.join(','));
  argsA.push('-f', 'image2', pattern);
  let strategy = 'single-pass';
  try {
    await run(ffmpegPath, argsA);
  } catch (err) {
    strategy = `seek-per-frame (single pass failed: ${err.message.slice(0, 80)})`;
    await fsp.rm(outDir, { recursive: true, force: true });
    await fsp.mkdir(outDir, { recursive: true });
    if (!durationMs) throw new Error(`Frame extraction failed and the video duration is unknown: ${err.message}`);
    const total = Math.max(1, Math.floor(durationMs / 1000 / intervalSeconds));
    for (let i = 0; i < total; i++) {
      const t = i * intervalSeconds;
      const file = path.join(outDir, `frame-${String(i + 1).padStart(5, '0')}.png`);
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', t.toFixed(3), '-i', videoPath, '-an', '-frames:v', '1'];
      if (vf.length) args.push('-vf', vf.join(','));
      args.push('-f', 'image2', file);
      await run(ffmpegPath, args, { timeoutMs: 60000 }).catch(() => {});
      if (i % 10 === 0) onProgress({ done: i, total });
    }
  }
  const files = (await fsp.readdir(outDir)).filter((f) => /^frame-\d{5}\.png$/.test(f)).sort();
  const frames = files.map((file, i) => ({ index: i, file, timeMs: Math.round(i * intervalSeconds * 1000) }));
  onProgress({ done: frames.length, total: frames.length });
  return { frames, strategy };
}

/** Extracts single full-resolution frames at the given times. */
export async function extractFullFrames({ ffmpegPath, videoPath, outDir, times, onProgress = () => {} }) {
  await fsp.mkdir(outDir, { recursive: true });
  const results = [];
  let i = 0;
  for (const { timeMs, file } of times) {
    const out = path.join(outDir, file);
    const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', (timeMs / 1000).toFixed(3), '-i', videoPath, '-an', '-frames:v', '1', '-f', 'image2', out];
    try { await run(ffmpegPath, args, { timeoutMs: 60000 }); results.push({ timeMs, file, ok: fs.existsSync(out) }); }
    catch (err) { results.push({ timeMs, file, ok: false, error: err.message }); }
    onProgress({ done: ++i, total: times.length });
  }
  return results;
}
