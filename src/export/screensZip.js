// Bundles the clean screens of a recording into a ZIP of WebP files plus a manifest for Motvin Inspirations.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { readJson, ANALYSIS_FILENAME, METADATA_FILENAME } from '../storage/recordingStore.js';

export const SCREENS_ZIP = 'screens.zip';

const slug = (s) => String(s || 'screen').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'screen';

/** @returns {Promise<{path:string, sizeBytes:number, count:number}>} */
export async function exportScreensZip({ recordingDir }) {
  const analysis = await readJson(path.join(recordingDir, ANALYSIS_FILENAME));
  const meta = (await readJson(path.join(recordingDir, METADATA_FILENAME))) || {};
  if (!analysis || !analysis.screens?.length) throw new Error('No clean screens yet for this recording.');
  const files = analysis.screens.filter((s) => s.file && fs.existsSync(path.join(recordingDir, s.file)));
  if (!files.length) throw new Error('The screen images are missing on disk. Re-process the recording.');
  const out = path.join(recordingDir, SCREENS_ZIP);
  const tmp = `${out}.tmp`;
  await fsp.rm(tmp, { force: true });
  const manifest = {
    source: 'motvin-web-recorder', recordingId: meta.id, url: meta.url, mode: meta.mode, viewport: meta.viewport,
    exportedAt: new Date().toISOString(),
    screens: [],
  };
  await new Promise((resolve, reject) => {
    const output = fs.createWriteStream(tmp);
    const zip = new ZipArchive({ zlib: { level: 0 } }); // WebP is already compressed
    output.on('close', resolve); output.on('error', reject);
    zip.on('error', reject);
    zip.pipe(output);
    files.forEach((s, i) => {
      const ext = path.extname(s.file) || '.webp';
      const name = `${String(i + 1).padStart(2, '0')}-${slug(s.baseName || s.name)}${ext}`;
      manifest.screens.push({ file: name, name: s.baseName || s.name, timeMs: s.timeMs, url: s.url || null, action: s.action || null, width: s.width || null, height: s.height || null });
      zip.file(path.join(recordingDir, s.file), { name });
    });
    zip.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
    zip.finalize();
  });
  await fsp.rename(tmp, out);
  return { path: out, sizeBytes: fs.statSync(out).size, count: files.length };
}
