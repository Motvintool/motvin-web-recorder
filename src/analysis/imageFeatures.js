// Per-frame visual features used by duplicate / loading / clean-frame detection.
import sharp from 'sharp';

export const THUMB_W = 48;
export const EDGE_W = 160;
export const DETAIL_W = 96;
export const FINE_W = 320;

/** Loads one frame and computes its features. */
export async function computeFeatures(filePath) {
  // Decode once. Large browser captures (e.g. 4320 px wide) are first brought down to 640 px; every feature is
  // derived from that single greyscale buffer, which is much faster than decoding the file four times.
  const src = sharp(filePath, { sequentialRead: true }).greyscale();
  const meta = await sharp(filePath).metadata();
  const baseW = Math.min(640, meta.width);
  const base = await src.resize(baseW, null, { fit: 'inside' }).raw().toBuffer({ resolveWithObject: true });
  const raw = () => sharp(base.data, { raw: { width: base.info.width, height: base.info.height, channels: 1 } });
  const aspect = meta.height / meta.width;
  const thumbH = Math.max(8, Math.round(THUMB_W * aspect));
  const edgeH = Math.max(8, Math.round(EDGE_W * aspect));
  const detailH = Math.max(8, Math.round(DETAIL_W * aspect));
  const fineW = Math.min(FINE_W, base.info.width); const fineH = Math.max(8, Math.round(fineW * aspect));
  const [thumb, edgeBuf, hashBuf, detail, fine] = await Promise.all([
    raw().resize(THUMB_W, thumbH, { fit: 'fill' }).raw().toBuffer(),
    raw().resize(EDGE_W, edgeH, { fit: 'fill' }).raw().toBuffer(),
    raw().resize(9, 8, { fit: 'fill' }).raw().toBuffer(),
    raw().resize(DETAIL_W, detailH, { fit: 'fill' }).raw().toBuffer(),
    raw().resize(fineW, fineH, { fit: 'fill' }).raw().toBuffer(),
  ]);
  const stats = basicStats(thumb);
  const edge = edgeEnergy(edgeBuf, EDGE_W, edgeH);
  const dhash = dHash(hashBuf, 9, 8);
  const ink = inkMask(thumb, stats.mode);
  const pale = paleFraction(thumb);
  const headerSig = regionMean(thumb, THUMB_W, thumbH, 0, 0.12);
  const blankRows = blankRowFraction(ink, THUMB_W, thumbH);
  return {
    width: meta.width, height: meta.height, thumbW: THUMB_W, thumbH,
    thumb, detail, fine, edge, dhash, ink, inkCount: ink.reduce((a, b) => a + b, 0),
    mean: stats.mean, std: stats.std, mode: stats.mode, pale, headerSig, blankRows,
    blank: stats.std < 6 && (stats.mean > 238 || stats.mean < 18),
    flat: stats.std < 10,
  };
}

function basicStats(buf) {
  let sum = 0; let sq = 0; const hist = new Uint32Array(256);
  for (let i = 0; i < buf.length; i++) { const v = buf[i]; sum += v; sq += v * v; hist[v]++; }
  const n = buf.length || 1;
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sq / n - mean * mean));
  let mode = 0; for (let i = 1; i < 256; i++) if (hist[i] > hist[mode]) mode = i;
  return { mean, std, mode };
}

function edgeEnergy(buf, w, h) {
  let e = 0; let n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const gx = buf[i + 1] - buf[i - 1];
    const gy = buf[i + w] - buf[i - w];
    e += Math.abs(gx) + Math.abs(gy); n++;
  }
  return n ? e / n : 0; // average gradient magnitude, ~0 for blank, 20-60 for dense UI
}

function dHash(buf, w, h) {
  const bits = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w - 1; x++) bits.push(buf[y * w + x] > buf[y * w + x + 1] ? 1 : 0);
  return bits; // 64 bits
}

export function hamming(a, b) { let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++; return d; }

export function meanAbsDiff(a, b) {
  if (a.length !== b.length) return 255;
  let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/** Fraction of pixels that changed by more than `tol` between two thumbs. */
export function changedFraction(a, b, tol = 24) {
  if (a.length !== b.length) return 1;
  let c = 0; for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > tol) c++;
  return c / a.length;
}

/** Bounding box (normalised) of changed pixels; used to recognise spinners (small, local change). */
export function changedBox(a, b, w, h, tol = 24) {
  let minX = w, minY = h, maxX = -1, maxY = -1, count = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (Math.abs(a[i] - b[i]) > tol) { count++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  if (count === 0) return null;
  return { x: minX / w, y: minY / h, w: (maxX - minX + 1) / w, h: (maxY - minY + 1) / h, area: ((maxX - minX + 1) * (maxY - minY + 1)) / (w * h), count: count / (w * h) };
}

function inkMask(buf, background) {
  const mask = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) mask[i] = Math.abs(buf[i] - background) > 40 ? 1 : 0;
  return mask;
}

/** Agreement of "ink" (content pixels) in place: intersection / union. 1 = same layout. */
export function inkMatch(a, b) {
  if (a.length !== b.length) return 0;
  let inter = 0; let union = 0;
  for (let i = 0; i < a.length; i++) { if (a[i] & b[i]) inter++; if (a[i] | b[i]) union++; }
  if (union === 0) return 1;
  return inter / union;
}

/** Fraction of thumbnail rows (below the header band) that carry almost no content pixels. */
function blankRowFraction(ink, w, h) {
  const y0 = Math.floor(h * 0.12);
  let blank = 0; let rows = 0;
  for (let y = y0; y < h; y++) {
    let n = 0; for (let x = 0; x < w; x++) n += ink[y * w + x];
    rows++; if (n <= Math.max(1, w * 0.02)) blank++;
  }
  return rows ? blank / rows : 0;
}

function paleFraction(buf) {
  let n = 0; for (let i = 0; i < buf.length; i++) if (buf[i] >= 200 && buf[i] <= 246) n++;
  return n / buf.length;
}

function regionMean(buf, w, h, fromFrac, toFrac) {
  const y0 = Math.floor(h * fromFrac); const y1 = Math.max(y0 + 1, Math.floor(h * toFrac));
  let s = 0; let n = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < w; x++) { s += buf[y * w + x]; n++; }
  return n ? s / n : 0;
}
