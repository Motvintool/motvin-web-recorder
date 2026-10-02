# Motvin Web Recorder

Local tool that records web applications **viewport-only** (no tabs, address bar, window frame,
desktop or cursor) for the Motvin Inspirations project, either by hand or with an AI explorer,
and turns the recording into clean, deduplicated screens.

```
URL → viewport → Manual | AI Agent → Chromium opens → viewport is recorded → WebM saved locally
                                                   → frames → duplicates / loading removed → clean screens
```

## Setup

Requirements: Node.js 20 or newer, macOS / Linux / Windows.

```bash
cd motvin-web-recorder
npm install
npx playwright install chromium ffmpeg
npm run doctor        # optional: checks Chromium, ffmpeg and AI backends
```

`npx playwright install` downloads Playwright's own Chromium build and its small ffmpeg build
(used to encode the WebM and to extract frames). Nothing else is downloaded. If you already
have a system `ffmpeg` it is used instead.

## Run

```bash
npm start
```

Open <http://localhost:4010>. Set `MOTVIN_RECORDER_PORT` to change the port and
`MOTVIN_RECORDINGS_DIR` to store recordings somewhere else (default: `./recordings`).

## The interface

- **Left rail, in order:** 1 Website (URL and viewport), 2 How should it record? (Manual or AI Agent), then optional
  *Quality & browser* and *AI settings*. Your choices are remembered.
- **Big live preview:** the page exactly as it is recorded. You can click, scroll and type inside it. A coloured ring shows
  the state: red while recording, amber when paused, indigo while the AI explores.
- **Control dock on the preview:** the only place you start, pause, resume and stop. Manual: *Start recording* → *Pause / Stop*.
  AI: *Pause AI / Stop AI*. **Stop stays locked for the first 3 seconds** (and the server refuses a Stop in the first 1.5 s), so a
  stray double-click can never end a recording the moment it starts.
- **Pages captured strip:** fills in live as you navigate (or as the AI discovers screens), so you can see the whole flow is being
  recorded. *Activity* opens the full log.
- **Recordings gallery:** video thumbnails, **View** (video, flow and screens in one place), **Export** (MP4 or WebP ZIP), and a
  menu for *Show in folder*, *Extract screens* and *Delete*.

## Using it

1. Enter a website URL and pick a viewport (1440×900, 1280×800, 390×844, 393×852, 768×1024 or custom).
   Mobile presets emulate touch and a mobile user agent.
2. Choose a mode:
   - **Manual** – "I control the application". *Open browser* launches Chromium at the exact viewport.
     Press *Start Recording*, interact with the site in the Chromium window (or through the live preview
     in the UI, which forwards clicks, scrolls and keys), *Pause* / *Resume* as needed, then *Stop*.
     Pausing never reloads or resets the page; the recorded clock simply stops, so the result is one
     continuous video with the paused time removed.
   - **AI Agent** – "AI explores the application". *Start AI Exploration* opens the site, starts recording
     automatically, and lets the agent explore like a UX researcher: it waits for the UI to settle,
     reads the page, picks meaningful actions (navigation, search, tabs, menus, dialogs, dropdowns,
     scrolling, back), names what it is doing ("Searching for icons", "Opening the details") and stops
     when the limits are reached or nothing new is reachable. *Pause AI* hands the browser to you
     (sign in, dismiss something) and *Resume AI* continues from the current page. Recording stops
     and the frame pipeline runs when the agent finishes.
3. Each recording appears under **Recordings** with filename, duration, resolution, file size, date and
   location. *Extract clean screens* (automatic after AI runs) samples the video, groups identical frames,
   drops loading / transition / blank / half-rendered frames, merges revisits of the same screen, and
   saves one full-resolution PNG per clean screen. *View* shows the video, the flow and the screens;
   *Open folder* reveals the files.

### Video quality

While recording, the browser's frames are encoded two ways at the same time:

- **`recording.webm`** – exactly the viewport size (e.g. 1440 × 900). Used for analysis and as a safe master.
- **`recording.live.mp4`** – H.264 at **2× pixel density** by default (e.g. 2880 × 1800, 30 fps), encoded live straight from
  the browser's frames, so there is no second quality loss. Choose 1×, 2× or 3× under *Video quality*; very large viewports
  are limited automatically (about 8.5 megapixels) so recording stays smooth. The page is rendered at that density,
  so text and icons are genuinely sharper, not upscaled.

Exporting the MP4 just re-wraps `recording.live.mp4` (instant, lossless). Recordings made before this existed are converted
from the WebM instead.

### How the screens are chosen

While you record, the browser takes a sharp capture every time the page settles (it paints, then stops changing). Those
captures are the candidate screens. Only things that are not a screen of their own are dropped: blank frames, loading
placeholders, a state the page was still loading (the same URL settling again with no click, key or scroll in between), and exact
repeats. Everything else is kept, including **small changes on the same page**: a field filled in, an error message, a menu or
dialog opening. That is what makes a sign-in flow, which is mostly typing on one URL, come through as separate screens, named by
what you did (for example "Sign in", "Sign in · typing", "Sign in · after click", "Dashboard"). The analysis keeps a log of every
keep-or-drop decision and why (`stats.selectionLog` in `analysis.json`).

If the browser is open but nothing is happening in the page being recorded for 15 seconds, the preview shows a warning with a
**Show the browser** button, in case you are working in a different window or tab.

### Manual recording across tabs

If a link opens a **new tab**, the recording follows it, and keeps following whichever tab you use (it watches your real
mouse, keyboard and scroll activity). Closing a tab returns to the previous one. Sign-in pop-ups from Google, Microsoft, Apple
and similar providers are followed too (so a login flow is recorded end to end); turn off *Record sign-in windows too* to skip
them. Passwords always show as dots, and you can Pause at any time.

*Stop* saves the recording and **keeps the browser open** so you can record again or close it yourself. Stopping a recording
shorter than 5 seconds asks for confirmation.

### If something goes wrong

Progress is saved every few seconds. If the recorder stops unexpectedly (crash, killed server, closed laptop), the next time
the server starts it recovers the recording up to that moment (marked *Interrupted*); it can be viewed, processed and exported
like any other. Stopping the server normally (Ctrl+C) saves the current recording and closes the browser.

### Export: Video or Screens

Every recording has an **Export** menu:

- **Video · MP4** – the high-resolution H.264 video (see *Video quality*), ready for QuickTime, browsers, Figma and editors.
  The MP4 is cached as `recording.mp4`.
  Encoding uses the `ffmpeg-static` package that `npm install` adds to this project (ffmpeg 6.0 with libx264),
  or a system ffmpeg with libx264 if you prefer (`brew install ffmpeg`, `FFMPEG_PATH` to point at one).
  Playwright's own ffmpeg can only write WebM, which is why a second build is needed.
- **Screens · WebP** – a ZIP of the clean screens (`01-home.webp`, `02-search-results.webp`, …) plus a
  `manifest.json` with names, times, URLs and sizes. If the recording has not been processed yet, the clean
  screens are extracted first.

The download starts by itself when the export is ready.

### Browser: Chromium or My Chrome (Google sign-in)

Google refuses sign-in in automated browsers ("This browser or app may not be secure"). Playwright's
built-in Chromium reports itself as automated, so it is blocked. Choose **My Chrome** under *Browser*:
the recorder starts your installed Google Chrome as an ordinary window with its own saved profile
(`browser-profile/`, git-ignored) and only attaches to it to record the page. Sign in once, in Manual mode,
*before* pressing Start Recording; the session is remembered for later recordings. Pop-ups (such as the
Google account chooser) stay open in Manual mode. Set `CHROME_PATH` if Chrome is installed elsewhere.
The recorder never types credentials for you and the AI never signs in.

### Saved screens

Screens are saved as **WebP (quality 95)**. While recording, the browser takes a sharp capture every time
the page settles (paints, then stops changing). Those captures, not the compressed video, become the final
screens, at 1×, 2× (default) or 3× the viewport size. The video itself is always exactly the viewport size.
A screen shown for roughly half a second or more is captured, so quick navigation in Manual mode is not
missed. If no capture matches (rare), the screen is taken from the video frame instead and the analysis
marks it `video-frame`.

### AI brains

The agent's decisions come from one of three interchangeable backends (chosen in the UI, default *Auto*):

| Backend | When it is used | Notes |
|---|---|---|
| Anthropic API (Claude) | `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` set | Model from `ANTHROPIC_MODEL` or `MOTVIN_ANTHROPIC_MODEL` (default `claude-opus-5-5`). Server-side refusal fallbacks are enabled. |
| Ollama (local) | Ollama running on `localhost:11434` | Picks the largest capable text model (`MOTVIN_OLLAMA_MODEL` to force one). Free and offline. |
| Built-in planner | Always available | Deterministic UX-researcher heuristics. Also the shortlist and fallback for the two model backends. |

The agent never bypasses sign-in, CAPTCHA, one-time codes or paywalls. When it reaches one it records the
screen, marks the path as blocked and leaves it. Only record sites you own or are permitted to test.

### Output

```
recordings/<date>-<host>-<mode>/
  recording.webm     VP8 WebM, exactly the viewport size
  recording.live.mp4 H.264 at 2× density recorded live (fragmented; becomes recording.mp4 on export)
  metadata.json      url, viewport, duration, size, pauses, AI summary, file facts
  events.json        AI screens, steps (with human-readable intents) and observations with timestamps
  captures/          sharp WebP browser captures taken at settled moments (source of the final screens)
  frames/            sampled analysis frames (480px wide PNG, every 0.3 s)
  screens/           one WebP per clean screen (screen-01.webp, …)
  analysis.json      holds, classification (duplicate / loading / transition / blank / partial),
                     chosen screens, flow, and an `inspirations` hand-off block for Motvin Inspirations
```

## Architecture

```
src/
  server.js                    HTTP + WebSocket API, serves the UI and recordings
  config.js                    presets, defaults, folders
  browser/browserController.js Playwright Chromium: context, page, navigation, pop-up handling, remote input
  recording/screencastRecorder.js  CDP screencast → ffmpeg VP8/WebM with real pause/resume
  recording/settleMonitor.js   detects "page painted then went quiet" moments
  recording/screenCapturer.js  sharp WebP browser captures at those moments (1×/2×/3×)
  browser/chrome.js            finds installed Google Chrome for "My Chrome" mode
  recording/ffmpeg.js          finds system or Playwright-bundled ffmpeg (never downloads)
  manual/sessionManager.js     one session at a time: manual controls, AI start/pause/resume/stop, saving
  agent/agent.js               observe → understand → decide → act loop, limits, blocked paths
  agent/pageSnapshot.js        in-page extraction of interactive elements, headings, loading & access signals
  agent/stability.js           waits for a stable UI (DOM quiet, no repaints, no pending images, no spinners)
  agent/stateTracker.js        visited-state memory and loop detection
  agent/planner.js             heuristic UX-researcher planner + human-readable intents and screen names
  agent/blocked.js             access-control detection; actions that are never taken
  agent/brains/                heuristic, ollama, anthropic + registry
  analysis/frameExtractor.js   ffmpeg frame sampling (analysis size) and full-size extraction
  analysis/imageFeatures.js    thumbnails, dHash, edge energy, ink masks, blank/pale/skeleton metrics (sharp)
  analysis/duplicateDetector.js holds + revisit detection (ink-aware)
  analysis/loadingDetector.js  transition / loading / blank / partial classification
  analysis/frameSelector.js    cleanest representative frame per hold
  analysis/flowAnalyzer.js     names screens from the agent's observations and builds the flow
  analysis/pipeline.js         orchestrates video → frames → screens → analysis.json
  export/mp4.js                WebM → high-quality H.264 MP4 (finds an ffmpeg with libx264)
  export/screensZip.js         ZIP of clean WebP screens + manifest.json
  storage/recordingStore.js    recordings folder, metadata, listing, open-in-Finder
  storage/webmInfo.js          reads duration and dimensions from the WebM header (no ffprobe needed)
public/                        the UI (vanilla HTML/CSS/JS)
test/                          end-to-end scripts (run against a started server)
```

## Tests

With the server running (`npm start`):

```bash
node test/e2e-manual.mjs https://example.com
node test/e2e-ai.mjs https://books.toscrape.com heuristic 1.5 8 14
node test/e2e-manual-nav.mjs          # visits 8 pages quickly, expects 8 screens
node test/e2e-export.mjs <recordingId>   # MP4 + ZIP export and download
node test/e2e-tabs.mjs chromium|chrome   # new tab, same-tab navigation, tab close
node test/e2e-login.mjs chromium|chrome  # a one-page sign-in flow: empty form, typing, error, dashboard are separate screens
node test/e2e-glitch.mjs chromium|chrome  # a static page must give a static video (captures never disturb it)
node test/e2e-latepaint.mjs           # a page that finishes loading late gives ONE screen (the finished one)
node test/e2e-stopguard.mjs           # an immediate Stop is refused, a normal one saves
node test/e2e-crash.mjs               # SIGKILL the server mid-recording, restart, recover, export
node test/e2e-chrome.mjs              # My Chrome mode 
```

Both launch a real headed Chromium, record, and assert that the saved WebM has exactly the viewport
dimensions and that the container duration matches the recorded (non-paused) time.

## Troubleshooting

- **"ffmpeg was not found"** – run `npx playwright install ffmpeg` (bundled build) or install ffmpeg
  (`brew install ffmpeg`) and restart. `FFMPEG_PATH` can point at a specific binary.
- **"Could not launch Chromium"** – run `npx playwright install chromium`.
- **The Chromium window is cut off on a small display** – the recording is still exactly the viewport size;
  use the live preview in the UI to interact with the parts you cannot see.
- **The AI stops immediately with "requires sign-in"** – the start page is a login page. Use Manual mode,
  or start the AI, press *Pause AI*, sign in, then *Resume AI*.
