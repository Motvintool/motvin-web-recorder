// Local storage for recordings: one folder per recording with video, metadata, frames and screens.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RECORDINGS_DIR } from '../config.js';
import { readWebmInfo } from './webmInfo.js';

export const VIDEO_FILENAME = 'recording.webm';
export const METADATA_FILENAME = 'metadata.json';
export const EVENTS_FILENAME = 'events.json';
export const ANALYSIS_FILENAME = 'analysis.json';

function pad(n, w = 2) { return String(n).padStart(w, '0'); }

export function slugify(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'site';
}

export function makeRecordingId(url, mode, date = new Date()) {
  let host = 'site';
  try { host = new URL(url).hostname; } catch { /* keep default */ }
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${stamp}-${slugify(host)}-${mode}`;
}

export function ensureRecordingsDir() {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  return RECORDINGS_DIR;
}

export function recordingDir(id) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) throw new Error('Invalid recording id');
  return path.join(RECORDINGS_DIR, id);
}

export function createRecordingFolder(id) {
  const dir = recordingDir(id);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export async function writeJson(file, data) {
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data, null, 2));
  await fsp.rename(tmp, file);
}

export async function readJson(file, fallback = null) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); } catch { return fallback; }
}

export async function saveMetadata(id, metadata) {
  const dir = recordingDir(id);
  await writeJson(path.join(dir, METADATA_FILENAME), metadata);
  return metadata;
}

export async function updateMetadata(id, patch) {
  const current = (await readJson(path.join(recordingDir(id), METADATA_FILENAME))) || {};
  const next = { ...current, ...patch, id };
  await saveMetadata(id, next);
  return next;
}

/** Refreshes file-derived fields (size, duration, dimensions) from the video on disk. */
export async function refreshVideoFacts(id) {
  const dir = recordingDir(id);
  const video = path.join(dir, VIDEO_FILENAME);
  if (!fs.existsSync(video)) return null;
  const info = readWebmInfo(video);
  return updateMetadata(id, {
    videoPath: video,
    fileSizeBytes: info.sizeBytes,
    video: { width: info.width, height: info.height, codec: info.codec, durationMs: info.durationMs, durationEstimated: Boolean(info.durationEstimated) },
  });
}

export async function getRecording(id) {
  const dir = recordingDir(id);
  const meta = await readJson(path.join(dir, METADATA_FILENAME));
  if (!meta) return null;
  const analysis = await readJson(path.join(dir, ANALYSIS_FILENAME));
  const events = await readJson(path.join(dir, EVENTS_FILENAME));
  return { ...meta, dir, hasVideo: fs.existsSync(path.join(dir, VIDEO_FILENAME)), analysis: analysis ? summarizeAnalysis(analysis) : null, events };
}

function summarizeAnalysis(a) {
  return {
    processedAt: a.processedAt,
    intervalSeconds: a.intervalSeconds,
    frameCount: a.frameCount,
    screens: a.screens,
    flow: a.flow,
    stats: a.stats,
    frames: a.frames,
  };
}

export async function listRecordings() {
  ensureRecordingsDir();
  const entries = await fsp.readdir(RECORDINGS_DIR, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = await readJson(path.join(RECORDINGS_DIR, e.name, METADATA_FILENAME));
    if (!meta) continue;
    const analysis = await readJson(path.join(RECORDINGS_DIR, e.name, ANALYSIS_FILENAME));
    items.push({
      ...meta,
      dir: path.join(RECORDINGS_DIR, e.name),
      hasVideo: fs.existsSync(path.join(RECORDINGS_DIR, e.name, VIDEO_FILENAME)),
      analysisSummary: analysis ? { screens: analysis.screens?.length ?? 0, frames: analysis.frameCount, processedAt: analysis.processedAt } : null,
    });
  }
  items.sort((a, b) => String(b.startedAt || b.id).localeCompare(String(a.startedAt || a.id)));
  return items;
}

export async function deleteRecording(id) {
  const dir = recordingDir(id);
  await fsp.rm(dir, { recursive: true, force: true });
}

/** Opens a folder in the OS file browser. */
export function openInFileBrowser(target) {
  return new Promise((resolve, reject) => {
    let cmd; let args;
    if (process.platform === 'darwin') { cmd = 'open'; args = [target]; }
    else if (process.platform === 'win32') { cmd = 'explorer'; args = [target]; }
    else { cmd = 'xdg-open'; args = [target]; }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', reject);
    child.on('spawn', () => { child.unref(); resolve(true); });
  });
}

/**
 * Recordings still marked "recording" when the server starts were cut short (crash, killed server, power loss).
 * Their files are kept; this fixes up the metadata so they can be viewed, processed and exported like any other.
 * @returns {Promise<string[]>} ids that were recovered
 */
export async function recoverInterrupted() {
  ensureRecordingsDir();
  const recovered = [];
  const entries = await fsp.readdir(RECORDINGS_DIR, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const dir = path.join(RECORDINGS_DIR, e.name);
    const meta = await readJson(path.join(dir, METADATA_FILENAME));
    if (!meta && (await fsp.readdir(dir)).length === 0) { await fsp.rmdir(dir).catch(() => {}); continue; } // leftover from a failed launch
    if (!meta || meta.status !== 'recording') continue;
    const video = path.join(dir, VIDEO_FILENAME);
    if (!fs.existsSync(video)) continue;
    const info = readWebmInfo(video);
    const live = path.join(dir, 'recording.live.mp4');
    const stat = fs.statSync(video);
    await updateMetadata(meta.id || e.name, {
      status: 'interrupted',
      endedAt: new Date(stat.mtimeMs).toISOString(),
      durationMs: info.durationMs ?? meta.durationMs ?? null,
      note: 'This recording was cut short (the recorder stopped unexpectedly). Everything captured up to that moment was kept.',
      highRes: fs.existsSync(live) && fs.statSync(live).size > 4096 ? meta.highRes || { file: 'recording.live.mp4' } : null,
    });
    await refreshVideoFacts(meta.id || e.name);
    recovered.push(meta.id || e.name);
  }
  return recovered;
}
