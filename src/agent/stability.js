// Waits until the page is visually and structurally stable: no network churn, no DOM changes
// between polls, no screencast frames arriving (the page is not repainting), no pending images,
// and no visible loading indicators. Gives up after a timeout and reports what was still moving.
import { digestPage } from './pageSnapshot.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {import('../recording/screencastRecorder.js').ScreencastRecorder} [opts.recorder]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.quietMs] consecutive quiet time required
 * @param {() => boolean} [opts.shouldAbort]
 */
export async function waitForStableUI(page, { recorder, timeoutMs = 8000, quietMs = 700, shouldAbort = () => false } = {}) {
  const started = Date.now();
  const result = { stable: false, waitedMs: 0, reason: '', loadingSeen: false };
  try { await page.waitForLoadState('domcontentloaded', { timeout: Math.min(5000, timeoutMs) }); } catch { /* keep going */ }
  // Network idle is a hint, not a requirement (analytics beacons never stop on some sites).
  await page.waitForLoadState('networkidle', { timeout: Math.min(2500, timeoutMs) }).catch(() => {});
  let prev = null;
  let quietSince = null;
  let loadingPersistSince = null;
  let structSince = null; // structure unchanged (animations may still repaint)
  while (Date.now() - started < timeoutMs) {
    if (shouldAbort()) { result.reason = 'aborted'; break; }
    let digest;
    try { digest = await digestPage(page); } catch (err) {
      if (/Execution context was destroyed|navigation/i.test(String(err.message))) { await sleep(200); prev = null; quietSince = null; continue; }
      throw err;
    }
    const structSame = prev && prev.nodes === digest.nodes && prev.visible === digest.visible && prev.url === digest.url && Math.abs(prev.textLength - digest.textLength) < 40;
    const domSame = structSame && prev.hash === digest.hash && prev.thash === digest.thash;
    if (structSame) { if (structSince == null) structSince = Date.now(); } else structSince = null;
    const paintQuiet = !recorder || recorder.lastFrameAt === 0 || Date.now() - recorder.lastFrameAt >= 400;
    const noPending = digest.pending === 0;
    const now = Date.now();
    if (domSame && paintQuiet && noPending) {
      if (quietSince == null) quietSince = now;
      if (now - quietSince >= quietMs) {
        // Final check: loading indicators / infinite animations on screen.
        const loading = await page.evaluate(`(() => {
          const vh = window.innerHeight;
          const sel = '[role="progressbar"],[aria-busy="true"],[class*="skeleton" i],[class*="spinner" i],[class*="shimmer" i],[class*="loading" i]:not(body):not(html)';
          let n = 0;
          for (const el of Array.from(document.querySelectorAll(sel)).slice(0, 80)) {
            const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
            if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > vh || cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
            n++;
          }
          return n;
        })()`).catch(() => 0);
        if (loading > 0) {
          result.loadingSeen = true;
          if (loadingPersistSince == null) loadingPersistSince = now;
          // A spinner that has been sitting there for 3s is probably decorative or a stuck loader.
          if (now - loadingPersistSince < 3000) { quietSince = null; await sleep(300); prev = digest; continue; }
          result.reason = 'persistent-loading-indicator';
        }
        result.stable = true;
        break;
      }
    } else {
      quietSince = null;
      // Pages with perpetual animations (carousels, cycling text, video) never go fully quiet:
      // accept them once the DOM structure has been unchanged for a while.
      if (structSince != null && Date.now() - structSince >= Math.max(1500, quietMs * 2) && digest.pending === 0 && Date.now() - started >= 2500) {
        result.stable = true; result.reason = 'animated-but-structurally-stable'; break;
      }
    }
    prev = digest;
    await sleep(220);
  }
  result.waitedMs = Date.now() - started;
  if (!result.stable && !result.reason) result.reason = 'timeout';
  return result;
}
