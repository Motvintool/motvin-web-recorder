// WebM → high-quality MP4 (H.264). Needs an ffmpeg with libx264; Playwright's bundled ffmpeg cannot write MP4,
// so we look for: FFMPEG_PATH, a system ffmpeg, then the project-local ffmpeg-static package.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { readWebmInfo } from '../storage/webmInfo.js';

const require = createRequire(import.meta.url);

export const MP4_FILENAME = 'recording.mp4';
export const MP4_LIVE_FILENAME = 'recording.live.mp4';
export const MP4_INSTALL_HINT =
  'MP4 export needs an ffmpeg with the H.264 (libx264) encoder. Run `npm install` in the motvin-web-recorder folder (it includes ffmpeg-static), ' +
  'or install ffmpeg yourself (macOS: `brew install ffmpeg`, Ubuntu: `sudo apt install ffmpeg`) and restart the recorder.';

function hasX264(bin) {
  try {
    const r = spawnSync(bin, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 10000 });
    return /libx264/.test(r.stdout || '');
  } catch { return false; }
}

let cached;
export function findMp4Encoder({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(['FFMPEG_PATH', process.env.FFMPEG_PATH]);
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const p = execFileSync(cmd, ['ffmpeg'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/)[0];
    if (p) candidates.push(['system', p]);
  } catch { /* none on PATH */ }
  try { const p = require('ffmpeg-static'); if (p) candidates.push(['ffmpeg-static', p]); } catch { /* package not installed */ }
  for (const [source, bin] of candidates) {
    if (fs.existsSync(bin) && hasX264(bin)) { cached = { available: true, path: bin, source, installHint: null }; return cached; }
  }
  cached = { available: false, path: null, source: null, installHint: MP4_INSTALL_HINT };
  return cached;
}

/**
 * Produces recording.mp4.
 *  - If the recording has a live high-resolution H.264 file (recorded straight from the browser's frames), it is
 *    simply re-wrapped (no re-encoding, so no quality loss) into a normal MP4 with the index at the front.
 *  - Otherwise (older recordings) recording.webm is converted to H.264 at CRF 10, slow preset.
 * The result is cached next to the recording and reused while its source is unchanged.
 * @returns {Promise<{path:string, sizeBytes:number, cached:boolean, source:'live'|'webm', width?:number, height?:number}>}
 */
export async function exportMp4({ recordingDir, onProgress = () => {} }) {
  const enc = findMp4Encoder();
  if (!enc.available) throw new Error(enc.installHint);
  const webm = path.join(recordingDir, 'recording.webm');
  const live = path.join(recordingDir, MP4_LIVE_FILENAME);
  const output = path.join(recordingDir, MP4_FILENAME);
  const useLive = fs.existsSync(live) && fs.statSync(live).size > 4096;
  const input = useLive ? live : webm;
  if (!fs.existsSync(input)) throw new Error('This recording has no video file.');
  const inStat = fs.statSync(input);
  const dims = (() => { try { return readMp4Dims(output); } catch { return {}; } })();
  if (fs.existsSync(output) && fs.statSync(output).mtimeMs >= inStat.mtimeMs && fs.statSync(output).size > 1000) {
    return { path: output, sizeBytes: fs.statSync(output).size, cached: true, source: useLive ? 'live' : 'webm', ...dims };
  }
  const info = readWebmInfo(webm);
  const totalMs = info.durationMs || 0;
  const tmp = path.join(recordingDir, 'recording.tmp.mp4');
  await fsp.rm(tmp, { force: true });
  const args = useLive
    ? ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-c', 'copy', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp]
    : ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-an',
      // H.264 needs even dimensions: pad by at most one pixel instead of rescaling the picture.
      '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:white,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '10', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-colorspace', 'smpte170m', '-color_primaries', 'smpte170m', '-color_trc', 'smpte170m', '-color_range', 'tv',
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', tmp];
  await new Promise((resolve, reject) => {
    const child = spawn(enc.path, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && totalMs > 0) onProgress({ percent: Math.min(99, Math.round((Number(m[1]) / 1000 / totalMs) * 100)) });
      }
    });
    child.on('error', (e) => reject(new Error(`ffmpeg could not run: ${e.message}`)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`))));
  }).catch(async (e) => { await fsp.rm(tmp, { force: true }); throw e; });
  await fsp.rename(tmp, output);
  return { path: output, sizeBytes: fs.statSync(output).size, cached: false, source: useLive ? 'live' : 'webm', ...(() => { try { return readMp4Dims(output); } catch { return {}; } })() };
}

/** Reads width/height from an MP4's avc1 sample entry (enough for display; avoids needing ffprobe). */
function readMp4Dims(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size; const len = Math.min(size, 4 * 1024 * 1024);
    const buf = Buffer.alloc(len); fs.readSync(fd, buf, 0, len, 0);
    const i = buf.indexOf('avc1');
    if (i < 0) return {};
    return { width: buf.readUInt16BE(i + 4 + 24), height: buf.readUInt16BE(i + 4 + 26) };
  } finally { fs.closeSync(fd); }
}
