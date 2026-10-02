// Minimal EBML/WebM header reader: duration + pixel dimensions, without ffprobe.
import fs from 'node:fs';

const IDS = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Duration: 0x4489,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  Video: 0xe0,
  PixelWidth: 0xb0,
  PixelHeight: 0xba,
  CodecID: 0x86,
  Cluster: 0x1f43b675,
  Cues: 0x1c53bb6b,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
};

function readVint(buf, pos, keepMarker) {
  if (pos >= buf.length) return null;
  const first = buf[pos];
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
  if (len > 8 || pos + len > buf.length) return null;
  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < len; i++) value = value * 256 + buf[pos + i];
  const unknown = !keepMarker && value === Math.pow(2, 7 * len) - 1;
  return { value, length: len, unknown };
}

function readUInt(buf, pos, len) {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[pos + i];
  return v;
}

function readFloat(buf, pos, len) {
  if (len === 4) return buf.readFloatBE(pos);
  if (len === 8) return buf.readDoubleBE(pos);
  return NaN;
}

/**
 * Reads container info from a WebM file. Falls back to scanning cluster timecodes
 * when the header carries no Duration (e.g. an interrupted write).
 */
export function readWebmInfo(filePath) {
  const info = { width: null, height: null, durationMs: null, codec: null, sizeBytes: null };
  let buf;
  try {
    const stat = fs.statSync(filePath);
    info.sizeBytes = stat.size;
    const fd = fs.openSync(filePath, 'r');
    const headLen = Math.min(stat.size, 2 * 1024 * 1024);
    buf = Buffer.alloc(headLen);
    fs.readSync(fd, buf, 0, headLen, 0);
    fs.closeSync(fd);
  } catch {
    return info;
  }
  let timecodeScale = 1000000;
  let lastClusterTimecode = null;
  const walk = (start, end, depth) => {
    let pos = start;
    while (pos < end) {
      const id = readVint(buf, pos, true);
      if (!id) return;
      const size = readVint(buf, pos + id.length, false);
      if (!size) return;
      const dataStart = pos + id.length + size.length;
      const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);
      switch (id.value) {
        case IDS.Segment:
        case IDS.Info:
        case IDS.Tracks:
        case IDS.TrackEntry:
        case IDS.Video:
          walk(dataStart, dataEnd, depth + 1);
          break;
        case IDS.TimecodeScale:
          timecodeScale = readUInt(buf, dataStart, size.value);
          break;
        case IDS.Duration:
          info.durationMs = (readFloat(buf, dataStart, size.value) * timecodeScale) / 1e6;
          break;
        case IDS.PixelWidth:
          info.width = readUInt(buf, dataStart, size.value);
          break;
        case IDS.PixelHeight:
          info.height = readUInt(buf, dataStart, size.value);
          break;
        case IDS.CodecID:
          info.codec = buf.toString('ascii', dataStart, dataEnd);
          break;
        case IDS.Cluster: {
          // Only read the cluster timecode; skip blocks.
          const tc = readVint(buf, dataStart, true);
          if (tc && tc.value === IDS.Timecode) {
            const tsz = readVint(buf, dataStart + tc.length, false);
            if (tsz) lastClusterTimecode = readUInt(buf, dataStart + tc.length + tsz.length, tsz.value);
          }
          break;
        }
        default:
          break;
      }
      if (size.unknown) return;
      pos = dataEnd;
      if (dataEnd >= buf.length) return;
    }
  };
  walk(0, buf.length, 0);
  if (info.durationMs == null) {
    // An unfinished file (crash, killed server) has no Duration in its header: hop through the clusters to the end.
    const scanned = scanLastTimecode(filePath);
    const tc = scanned ?? lastClusterTimecode;
    if (tc != null) { info.durationMs = (tc * timecodeScale) / 1e6; info.durationEstimated = true; }
  }
  if (info.durationMs != null) info.durationMs = Math.round(info.durationMs);
  return info;
}

/** Walks Cluster elements across the whole file and returns the latest block timecode (in timecode-scale units). */
function scanLastTimecode(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(64);
    let pos = 0; let last = null;
    // Find the first Cluster by scanning forward over top-level + Segment children.
    const readAt = (offset, len) => { const b = Buffer.alloc(len); const n = fs.readSync(fd, b, 0, len, offset); return b.subarray(0, n); };
    // Skip EBML header
    let h = readAt(0, 64); let id = readVint(h, 0, true); let sz = readVint(h, id.length, false);
    pos = id.length + sz.length + sz.value;
    h = readAt(pos, 64); id = readVint(h, 0, true); sz = readVint(h, id.length, false);
    if (!id || id.value !== IDS.Segment) return null;
    pos += id.length + sz.length; // Segment payload start (size is unknown for unfinished files)
    while (pos < size) {
      h = readAt(pos, 32); id = readVint(h, 0, true); if (!id) break; sz = readVint(h, id.length, false); if (!sz) break;
      const dataStart = pos + id.length + sz.length;
      const dataEnd = sz.unknown ? size : Math.min(size, dataStart + sz.value);
      if (id.value === IDS.Cluster) {
        const body = readAt(dataStart, Math.min(dataEnd - dataStart, 4 * 1024 * 1024));
        let bp = 0; let base = 0; let maxRel = 0;
        while (bp < body.length) {
          const cid = readVint(body, bp, true); if (!cid) break; const csz = readVint(body, bp + cid.length, false); if (!csz) break;
          const cs = bp + cid.length + csz.length; const ce = cs + (csz.unknown ? body.length : csz.value);
          if (cid.value === IDS.Timecode) base = readUInt(body, cs, csz.value);
          else if (cid.value === IDS.SimpleBlock && cs + 3 <= body.length) { const tr = readVint(body, cs, false); if (tr) maxRel = Math.max(maxRel, body.readInt16BE(cs + tr.length)); }
          else if (cid.value === IDS.BlockGroup) { /* skip */ }
          if (ce <= bp) break; bp = ce;
        }
        last = base + maxRel;
      }
      if (sz.unknown) break;
      pos = dataEnd;
    }
    return last;
  } catch { return null; } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* noop */ } }
}
