// Locates an ffmpeg binary. Preference: explicit env → system PATH → Playwright's bundled build.
// Nothing is ever downloaded here; when nothing is found we return install instructions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

function playwrightCacheDirs() {
  const dirs = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') {
    dirs.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  }
  const home = os.homedir();
  if (process.platform === 'darwin') dirs.push(path.join(home, 'Library', 'Caches', 'ms-playwright'));
  else if (process.platform === 'win32') dirs.push(path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'ms-playwright'));
  else dirs.push(path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'ms-playwright'));
  return dirs;
}

function findBundledFfmpeg() {
  for (const dir of playwrightCacheDirs()) {
    let entries = [];
    try { entries = fs.readdirSync(dir); } catch { continue; }
    const candidates = entries.filter((e) => e.startsWith('ffmpeg-')).sort().reverse();
    for (const c of candidates) {
      const sub = path.join(dir, c);
      let files = [];
      try { files = fs.readdirSync(sub); } catch { continue; }
      const bin = files.find((f) => /^ffmpeg-(mac|linux|win64)/.test(f));
      if (bin) return path.join(sub, bin);
    }
  }
  return null;
}

function findOnPath() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['ffmpeg'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split(/\r?\n/)[0];
    return out || null;
  } catch { return null; }
}

function probe(binary) {
  const caps = { vp8Encode: false, vp8Decode: false, webmMux: false, webmDemux: false, pngEncode: false, mjpegDecode: false, fpsFilter: false };
  const run = (flag) => {
    const r = spawnSync(binary, ['-hide_banner', flag], { encoding: 'utf8', timeout: 10000 });
    return (r.stdout || '') + (r.stderr || '');
  };
  const enc = run('-encoders');
  const dec = run('-decoders');
  const mux = run('-muxers');
  const dem = run('-demuxers');
  const fil = run('-filters');
  caps.vp8Encode = /libvpx|vp8/i.test(enc);
  caps.vp8Decode = /libvpx|vp8/i.test(dec);
  caps.pngEncode = /\spng\s/.test(enc);
  caps.mjpegDecode = /\smjpeg\s/.test(dec);
  caps.webmMux = /webm|matroska/i.test(mux);
  caps.webmDemux = /webm|matroska/i.test(dem);
  caps.fpsFilter = /\sfps\s/.test(fil);
  return caps;
}

let cached;
export function findFfmpeg({ refresh = false } = {}) {
  if (cached && !refresh) return cached;
  let binary = null;
  let source = null;
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) { binary = process.env.FFMPEG_PATH; source = 'FFMPEG_PATH'; }
  if (!binary) { const p = findOnPath(); if (p) { binary = p; source = 'system'; } }
  if (!binary) { const p = findBundledFfmpeg(); if (p) { binary = p; source = 'playwright'; } }
  let capabilities = null;
  if (binary) {
    try { capabilities = probe(binary); } catch { capabilities = null; }
  }
  cached = {
    available: Boolean(binary && capabilities && capabilities.vp8Encode && capabilities.webmMux),
    path: binary,
    source,
    capabilities,
    installHint: INSTALL_HINT,
  };
  return cached;
}

export const INSTALL_HINT =
  'ffmpeg was not found. Either run `npx playwright install ffmpeg` (installs Playwright\'s small bundled build, used for WebM recording) ' +
  'or install a system ffmpeg (macOS: `brew install ffmpeg`, Ubuntu: `sudo apt install ffmpeg`, Windows: https://ffmpeg.org/download.html) ' +
  'and restart the recorder. You can also point FFMPEG_PATH at a binary.';
