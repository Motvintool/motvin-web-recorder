// Video → frames → features → holds → classification → duplicates → clean screens.
// Writes everything next to the recording so Motvin Inspirations can pick it up later.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { extractFrames, extractFullFrames } from './frameExtractor.js';
import { computeFeatures } from './imageFeatures.js';
import { groupHolds, markRevisits } from './duplicateDetector.js';
import { classifyHolds } from './loadingDetector.js';
import { chooseRepresentatives } from './frameSelector.js';
import { buildScreens } from './flowAnalyzer.js';
import { selectFromCaptures } from './captureSelector.js';
import sharp from 'sharp';
import { ANALYSIS_DEFAULTS, SCREEN_DEFAULTS } from '../config.js';
import { hamming, meanAbsDiff } from './imageFeatures.js';
import { readJson, writeJson, VIDEO_FILENAME, EVENTS_FILENAME, ANALYSIS_FILENAME, METADATA_FILENAME } from '../storage/recordingStore.js';

/**
 * @param {object} opts
 * @param {string} opts.recordingDir
 * @param {string} opts.ffmpegPath
 * @param {number} [opts.intervalSeconds]
 * @param {boolean} [opts.keepAllFrames] keep the analysis-size frames on disk (default true)
 * @param {(e:object)=>void} [opts.onProgress]
 */
export async function processRecording({ recordingDir, ffmpegPath, intervalSeconds = ANALYSIS_DEFAULTS.intervalSeconds, analysisWidth = ANALYSIS_DEFAULTS.analysisWidth, keepAllFrames = true, onProgress = () => {} }) {
  const videoPath = path.join(recordingDir, VIDEO_FILENAME);
  if (!fs.existsSync(videoPath)) throw new Error('This recording has no video file.');
  const meta = (await readJson(path.join(recordingDir, METADATA_FILENAME))) || {};
  const events = (await readJson(path.join(recordingDir, EVENTS_FILENAME))) || {};
  const framesDir = path.join(recordingDir, 'frames');
  const screensDir = path.join(recordingDir, 'screens');
  const intervalMs = Math.round(intervalSeconds * 1000);
  const t0 = Date.now();

  onProgress({ stage: 'extract', message: 'Extracting frames from the video…' });
  const { frames: extracted, strategy } = await extractFrames({ ffmpegPath, videoPath, outDir: framesDir, intervalSeconds, width: analysisWidth, durationMs: meta.video?.durationMs || meta.durationMs, onProgress: (p) => onProgress({ stage: 'extract', ...p }) });
  if (extracted.length === 0) throw new Error('No frames could be extracted from the video.');

  onProgress({ stage: 'analyze', message: `Analyzing ${extracted.length} frames…`, total: extracted.length, done: 0 });
  const frames = [];
  for (let i = 0; i < extracted.length; i++) {
    const f = extracted[i];
    const features = await computeFeatures(path.join(framesDir, f.file));
    frames.push({ ...f, features });
    if (i % 20 === 0) onProgress({ stage: 'analyze', done: i, total: extracted.length });
  }

  onProgress({ stage: 'group', message: 'Detecting duplicate and loading frames…' });
  const holds = groupHolds(frames, intervalMs);
  chooseRepresentatives(holds, frames);
  const navEvents = (events.observations || []).filter((o) => o.url).sort((a, b) => a.recordedMs - b.recordedMs);
  const urlAt = (timeMs) => { let u = meta.url || null; for (const o of navEvents) { if (o.recordedMs <= timeMs + 150) u = o.url; else break; } return u; };
  // A navigation only becomes visible at the next visual change, so a hold takes the URL current when it BEGAN.
  for (const h of holds) h.url = urlAt(h.start * intervalMs + 100);
  // A settled moment (the page painted, then went quiet) proves a screen was really shown, however briefly.
  // The browser capture taken at that moment is matched to the video hold it looks like, so small
  // timing offsets between the screencast and the encoded video cannot attach it to the wrong frame.
  const settled = events.settled || [];
  const isLoadingTitle = (t) => !t || /^loading\b/i.test(t) || /^https?:\/\//i.test(t) || t === 'about:blank';
  for (const ev of settled) {
    if (!ev.file) continue;
    let f; try { f = await computeFeatures(path.join(recordingDir, ev.file)); } catch { continue; }
    let best = null;
    for (const h of holds) {
      const startMs = h.start * intervalMs; const endMs = (h.end + 1) * intervalMs;
      if (startMs > ev.recordedMs + 600 || endMs < ev.recordedMs - 3000) continue;
      const rf = frames[h.rep].features;
      if (rf.thumb.length !== f.thumb.length) continue;
      const mad = meanAbsDiff(f.thumb, rf.thumb); const ham = hamming(f.dhash, rf.dhash);
      if (mad > 10 || ham > 20) continue;
      const gap = ev.recordedMs < startMs ? startMs - ev.recordedMs : ev.recordedMs > endMs ? ev.recordedMs - endMs : 0; // distance to the hold's time span
      const score = mad + ham * 0.5 + gap / 1000;
      if (!best || score < best.score) best = { h, score };
    }
    if (!best) continue;
    const h = best.h;
    h.settled = true; (h.captures ||= []).push(ev);
    if (!isLoadingTitle(ev.title)) { h.title = ev.title; if (ev.url) h.url = ev.url; }
    else if (!h.url && ev.url) h.url = ev.url;
  }
  classifyHolds(holds, frames, { intervalMs, observations: events.observations || [], settledAvailable: settled.some((e) => e.file) });
  const videoEnd = meta.video?.durationMs || meta.durationMs || Infinity;
  // Preferred: build the screens from the browser's own settled captures, so every distinct state reached is kept.
  // Fallback (recordings without captures): group the video frames into holds.
  let selection = null;
  if (settled.some((e) => e.file)) {
    selection = await selectFromCaptures({ settled, recordingDir, activity: events.activity, activityKinds: events.activityKinds, activityTracked: events.activityTracked, agentScreens: events.screens || [], observations: events.observations || [], durationMs: Number.isFinite(videoEnd) ? videoEnd : (frames.length * intervalMs) });
  }
  let screens; let flow = [];
  if (selection && selection.screens.length) {
    screens = selection.screens;
    for (const sc of screens) {
      sc.frameIndex = Math.max(0, Math.min(frames.length - 1, Math.round(sc.timeMs / intervalMs)));
      sc.holdId = holds.find((h) => sc.frameIndex >= h.start && sc.frameIndex <= h.end)?.id || null;
      if (flow.at(-1) !== sc.baseName) flow.push(sc.baseName);
    }
  } else {
    markSuperseded(holds, settled, events.activityTracked ? events.activity : undefined);
    markRevisits(holds, frames);
    ({ screens, flow } = buildScreens(holds, frames, { screens: events.screens || [], steps: events.steps || [], observations: events.observations || [], mode: meta.mode, intervalMs }));
  }

  onProgress({ stage: 'screens', message: `Saving ${screens.length} clean screens (WebP)…`, total: screens.length, done: 0 });
  await fsp.rm(screensDir, { recursive: true, force: true });
  await fsp.mkdir(screensDir, { recursive: true });
  const tmpDir = path.join(recordingDir, '.screens-tmp');
  await fsp.rm(tmpDir, { recursive: true, force: true });
  const safeTime = (t) => Math.max(0, Math.min(t, videoEnd - intervalMs)); // the last sampled frame can sit past the final packet
  const withCapture = [];
  const needVideo = [];
  let done = 0;
  for (const sc of screens) {
    sc.thumb = `frames/${frames[sc.frameIndex].file}`;
    const hold = holds.find((h) => h.id === sc.holdId);
    const cap = sc.captureFile ? { file: sc.captureFile } : (hold?.captures?.length ? hold.captures[hold.captures.length - 1] : null);
    const out = path.join(screensDir, `${sc.id}.webp`);
    if (cap) {
      await fsp.copyFile(path.join(recordingDir, cap.file), out);
      const m = await sharp(out).metadata();
      Object.assign(sc, { file: `screens/${sc.id}.webp`, source: 'browser-capture', width: m.width, height: m.height });
      withCapture.push(sc);
      onProgress({ stage: 'screens', done: ++done, total: screens.length });
    } else needVideo.push(sc);
  }
  // Fall back to a video frame (lossy source) converted to high-quality WebP.
  if (needVideo.length) {
    let full = await extractFullFrames({ ffmpegPath, videoPath, outDir: tmpDir, times: needVideo.map((s) => ({ timeMs: safeTime(s.timeMs), file: `${s.id}.png` })) });
    const retry = needVideo.filter((s) => !full.find((x) => x.file === `${s.id}.png`)?.ok).map((s) => ({ timeMs: safeTime(s.timeMs - intervalMs), file: `${s.id}.png` }));
    if (retry.length) full = full.concat(await extractFullFrames({ ffmpegPath, videoPath, outDir: tmpDir, times: retry }));
    for (const sc of needVideo) {
      const png = path.join(tmpDir, `${sc.id}.png`);
      const out = path.join(screensDir, `${sc.id}.webp`);
      try {
        const info = await sharp(png).webp({ quality: SCREEN_DEFAULTS.webpQuality, smartSubsample: true, effort: 5 }).toFile(out);
        Object.assign(sc, { file: `screens/${sc.id}.webp`, source: 'video-frame', width: info.width, height: info.height });
      } catch {
        sc.file = sc.thumb; sc.source = 'analysis-frame'; // never leave a screen without an image
      }
      onProgress({ stage: 'screens', done: ++done, total: screens.length });
    }
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }

  const stats = {
    frames: frames.length,
    holds: holds.length,
    screens: screens.length,
    duplicates: selection?.screens.length ? selection.dropped.duplicate : holds.filter((h) => h.duplicateOf).length,
    loading: selection?.screens.length ? selection.dropped.loading : holds.filter((h) => h.kind === 'loading').length,
    transitions: holds.filter((h) => h.kind === 'transition').length,
    blank: selection?.screens.length ? selection.dropped.blank : holds.filter((h) => h.kind === 'blank').length,
    browserCaptures: screens.filter((s) => s.source === 'browser-capture').length,
    partial: selection?.screens.length ? selection.dropped.stillLoading : holds.filter((h) => h.kind === 'partial').length,
    candidates: selection?.evaluated ?? null,
    selectionLog: selection?.decisions || null,
    selection: selection?.screens.length ? 'captures' : 'video-holds',
    processingMs: Date.now() - t0,
    extraction: strategy,
  };
  const analysis = {
    version: 1,
    processedAt: new Date().toISOString(),
    intervalSeconds,
    analysisWidth,
    frameCount: frames.length,
    screenFormat: { type: 'webp', quality: SCREEN_DEFAULTS.webpQuality, scale: meta.screenScale || null },
    frames: frames.map((f) => { const h = holds.find((x) => x.frames.includes(f.index)); return { index: f.index, timeMs: f.timeMs, file: `frames/${f.file}`, holdId: h?.id, kind: h?.duplicateOf ? 'duplicate' : h?.kind, edge: Math.round(f.features.edge * 10) / 10 }; }),
    holds: holds.map((h) => ({ id: h.id, url: h.url || null, settled: Boolean(h.settled), start: h.start, end: h.end, durationMs: h.durationMs, kind: h.duplicateOf ? 'duplicate' : h.kind, reason: h.reason || null, duplicateOf: h.duplicateOf || null, rep: h.rep, quality: Math.round((h.quality ?? 0) * 10) / 10 })),
    screens,
    flow,
    stats,
    inspirations: { // hand-off contract for Motvin Inspirations
      source: 'motvin-web-recorder', recordingId: meta.id, url: meta.url, viewport: meta.viewport, mode: meta.mode,
      screens: screens.map((s) => ({ id: s.id, name: s.baseName, file: s.file, width: s.width, height: s.height, timeMs: s.timeMs, url: s.url, action: s.action })),
    },
  };
  await writeJson(path.join(recordingDir, ANALYSIS_FILENAME), analysis);
  if (!keepAllFrames) {
    const keep = new Set(screens.map((s) => frames[s.frameIndex].file));
    for (const f of frames) if (!keep.has(f.file)) await fsp.rm(path.join(framesDir, f.file), { force: true });
  }
  onProgress({ stage: 'done', message: `Done: ${screens.length} clean screens from ${frames.length} frames.`, stats });
  return analysis;
}


const urlKeyOf = (u) => { try { const x = new URL(u); x.hash = ''; return x.origin + x.pathname.replace(/\/+$/, '') + x.search; } catch { return u || ''; } };

/**
 * A page that settles, then settles again on the same URL with no click, key or scroll in between, was simply
 * still loading (an image or script arrived late). The earlier state is incomplete: drop it in favour of the later one.
 */
function markSuperseded(holds, settled, activity) {
  if (!Array.isArray(activity)) return; // older recordings carry no input record; keep the previous behaviour
  const evs = settled.filter((e) => e.file).slice().sort((a, b) => a.recordedMs - b.recordedMs);
  const superseded = new Set();
  for (let i = 0; i < evs.length - 1; i++) {
    const a = evs[i]; const b = evs[i + 1];
    if (urlKeyOf(a.url) !== urlKeyOf(b.url)) continue;
    const touched = activity.some((t) => t > a.recordedMs - 150 && t < b.recordedMs);
    if (!touched) superseded.add(a);
  }
  for (const h of holds) {
    if (h.kind !== 'screen' || !h.captures?.length) continue;
    const laterOther = holds.some((n) => n !== h && n.start > h.end && n.captures?.some((c) => c.recordedMs > h.captures[h.captures.length - 1].recordedMs && urlKeyOf(c.url) === urlKeyOf(h.captures[0].url)));
    if (laterOther && h.captures.every((c) => superseded.has(c))) { h.kind = 'partial'; h.reason = 'page was still loading; it completed in a later frame'; }
  }
}
