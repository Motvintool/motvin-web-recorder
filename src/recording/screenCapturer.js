// Captures sharp WebP screenshots straight from the browser at settled moments.
// These are the source for the final clean screens: no video compression, optional 2× pixel density.
// Capturing does not touch the page's layout and never appears in the recorded video.
import fsp from 'node:fs/promises';
import path from 'node:path';

export class ScreenCapturer {
  /**
   * @param {{cdp: import('playwright').CDPSession, dir: string, width: number, height: number, scale?: number, quality?: number, max?: number}} opts
   */
  constructor({ cdp, dir, width, height, scale = 2, quality = 95, max = 400 }) {
    this.getCdp = typeof cdp === 'function' ? cdp : () => cdp; this.dir = dir; this.width = width; this.height = height;
    this.scale = scale; this.quality = quality; this.max = max;
    this.count = 0;
    this.native = null; // pixels per CSS pixel the browser captures at without a clip (2 on Retina displays)
    this.queue = Promise.resolve();
    this.errors = 0;
  }

  /** Queues a capture; resolves with {file, width, height, scale} or null. Captures run one at a time. */
  capture() {
    const job = this.queue.then(() => this._capture()).catch(() => null);
    this.queue = job.then(() => {});
    return job;
  }

  async drain() { await this.queue; }

  /** The browser captures at the host display's density; measure it once so 1×/2×/3× mean what they say. */
  async _calibrate() {
    const { data } = await this.getCdp().send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    const sharp = (await import('sharp')).default;
    const m = await sharp(Buffer.from(data, 'base64')).metadata();
    this.native = Math.max(1, (m.width || this.width) / this.width);
  }

  async _capture() {
    if (this.count >= this.max) return null;
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      if (this.native == null) await this._calibrate();
      // The browser only grabs the pixels (fast PNG, ~3x quicker than encoding WebP in-process, which stalls the page);
      // the WebP is encoded here, off the page's process, from the lossless source.
      const params = { format: 'png', optimizeForSpeed: true, fromSurface: true, captureBeyondViewport: false };
      const factor = this.scale / this.native;
      if (Math.abs(factor - 1) > 0.01) params.clip = { x: 0, y: 0, width: this.width, height: this.height, scale: factor };
      const { data } = await this.getCdp().send('Page.captureScreenshot', params);
      const name = `cap-${String(++this.count).padStart(4, '0')}.webp`;
      const sharp = (await import('sharp')).default;
      await sharp(Buffer.from(data, 'base64')).webp({ quality: this.quality }).toFile(path.join(this.dir, name));
      return { file: `captures/${name}`, width: Math.round(this.width * this.scale), height: Math.round(this.height * this.scale), scale: this.scale };
    } catch (err) {
      this.errors++;
      return null;
    }
  }
}
