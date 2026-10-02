// Central configuration for Motvin Web Recorder.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..');

export const PORT = Number(process.env.MOTVIN_RECORDER_PORT || 4010);
export const RECORDINGS_DIR = path.resolve(
  process.env.MOTVIN_RECORDINGS_DIR || path.join(PROJECT_ROOT, 'recordings'),
);
export const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
/** Profile used by "My Chrome" mode. Sign in once and the session persists between recordings. */
export const CHROME_PROFILE_DIR = path.resolve(process.env.MOTVIN_CHROME_PROFILE || path.join(PROJECT_ROOT, 'browser-profile'));

/** Viewport presets shown in the UI. `mobile` switches on touch + mobile UA emulation. */
export const VIEWPORT_PRESETS = [
  { id: 'desktop-1440', label: 'Desktop', width: 1440, height: 900, kind: 'desktop' },
  { id: 'desktop-1280', label: 'Desktop', width: 1280, height: 800, kind: 'desktop' },
  { id: 'mobile-390', label: 'Mobile', width: 390, height: 844, kind: 'mobile' },
  { id: 'mobile-393', label: 'Mobile', width: 393, height: 852, kind: 'mobile' },
  { id: 'tablet-768', label: 'Tablet', width: 768, height: 1024, kind: 'tablet' },
];

export const RECORDING_DEFAULTS = {
  fps: Number(process.env.MOTVIN_RECORD_FPS || 30),
  videoScale: 2, // pixel density of the high-resolution MP4 (the WebM is always exactly the viewport size)
  maxVideoPixels: 8_500_000, // cap so real-time encoding keeps up (2880×1800 = 5.2 MP)
  jpegQuality: 95,
  previewFps: 3,
};

export const AI_DEFAULTS = {
  maxMinutes: 4,
  maxScreens: 25,
  maxSteps: 60,
  maxRevisits: 2,
  stableTimeoutMs: 8000,
  backend: 'auto',
};

export const SCREEN_DEFAULTS = {
  scale: 2, // 2× pixel density for the saved screens (the video itself is always exactly the viewport size)
  webpQuality: 95,
};

export const ANALYSIS_DEFAULTS = {
  intervalSeconds: 0.3,
  analysisWidth: 480,
};

export const VIEWPORT_LIMITS = { min: 240, max: 3840 };
