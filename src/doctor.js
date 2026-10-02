// `npm run doctor` — checks that the pieces the recorder needs are in place.
import { chromium } from 'playwright';
import { findFfmpeg } from './recording/ffmpeg.js';
import { describeBackends } from './agent/brains/index.js';
import { RECORDINGS_DIR } from './config.js';

const ff = findFfmpeg();
console.log(ff.available ? `✔ ffmpeg: ${ff.path} (${ff.source})` : `✖ ffmpeg missing — ${ff.installHint}`);
try {
  const b = await chromium.launch({ headless: true });
  console.log(`✔ Chromium ${b.version()} launches`);
  await b.close();
} catch (err) {
  console.log(`✖ Chromium cannot launch: ${String(err.message).split('\n')[0]}\n  Run: npx playwright install chromium`);
}
const ai = await describeBackends();
for (const b of ai.backends) console.log(`${b.available ? '✔' : '·'} AI backend ${b.label}: ${b.detail}`);
console.log(`  auto will use: ${ai.auto}`);
console.log(`✔ recordings folder: ${RECORDINGS_DIR}`);
