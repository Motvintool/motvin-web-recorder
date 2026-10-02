// Shared prompt construction for the LLM brains.
export const SYSTEM_PROMPT = `You are a UX researcher exploring a web application to document its meaningful screens.
You are shown the current page (URL, headings, visible interactive elements) plus a numbered shortlist of possible next actions, the screens already discovered, and recent steps.
Your job: pick the ONE next action that most likely reveals a NEW meaningful screen or state (home, search, results, detail pages, forms, profile, settings, major feature areas, dialogs, empty states) and avoid loops.
Rules:
- Never pick actions that log out, delete, pay, purchase, subscribe, share, download or leave the site.
- Never try to bypass sign-in, CAPTCHA, one-time codes or paywalls.
- Prefer unexplored primary navigation and core flows (search → results → detail) over footer/legal links.
- If the current screen is exhausted, choose "back".
- Also give a short, human-readable description of what the action does from a user's perspective (e.g. "Searching for restaurants", "Opening restaurant details", "Managing account settings") and a short name for the current screen (e.g. "Search results", "Product detail", "Settings").
Respond with JSON only: {"action": "<candidate id>", "intent": "<description>", "screenName": "<name>"}`;

export function buildUserMessage(ctx) {
  const { snapshot, candidates, screens, recentSteps, limits, progress } = ctx;
  const lines = [];
  lines.push(`URL: ${snapshot.url}`);
  lines.push(`Title: ${snapshot.title}`);
  if (snapshot.h1) lines.push(`H1: ${snapshot.h1}`);
  if (snapshot.headings.length) lines.push(`Headings: ${snapshot.headings.slice(0, 8).map((h) => h.text).join(' | ')}`);
  if (snapshot.modal) lines.push(`A dialog is open: ${snapshot.modalTitle || '(untitled)'}`);
  lines.push(`Text excerpt: ${snapshot.textSample.slice(0, 500)}`);
  lines.push('');
  lines.push(`Discovered screens so far (${screens.length}): ${screens.slice(-12).map((s) => s.name).join(' → ') || 'none yet'}`);
  lines.push(`Progress: step ${progress.steps}/${limits.maxSteps}, screens ${progress.screens}/${limits.maxScreens}, ${Math.round(progress.elapsedMs / 1000)}s of ${limits.maxMinutes * 60}s`);
  if (recentSteps.length) lines.push(`Recent actions: ${recentSteps.slice(-6).map((s) => s.intent).join(' → ')}`);
  lines.push('');
  lines.push('Candidate actions (pick one id):');
  for (const c of candidates.slice(0, 28)) {
    const extra = c.href ? ` → ${shortUrl(c.href)}` : c.value ? ` (query: ${c.value})` : '';
    lines.push(`${c.id}: [${c.type}] ${c.label || c.intent}${extra}${c.score < -20 ? ' (already tried here)' : ''}`);
  }
  return lines.join('\n');
}

function shortUrl(u) { try { const x = new URL(u); return (x.pathname + x.search).slice(0, 60) || '/'; } catch { return u.slice(0, 60); } }

/** Extracts the first JSON object from model text (handles code fences, <tools> tags, prose). */
export function parseDecision(text, candidates) {
  if (!text) return null;
  const cleaned = String(text).replace(/```(?:json)?/gi, '').replace(/<\/?[a-z_]+>/gi, ' ');
  const start = cleaned.indexOf('{');
  if (start < 0) return null;
  for (let end = cleaned.lastIndexOf('}'); end > start; end = cleaned.lastIndexOf('}', end - 1)) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1));
      const id = String(obj.action ?? obj.candidateId ?? obj.id ?? '').trim();
      const cand = candidates.find((c) => c.id === id) || candidates.find((c) => c.id === `a${id}`);
      if (!cand) return null;
      return { candidateId: cand.id, intent: typeof obj.intent === 'string' && obj.intent.trim() ? obj.intent.trim().slice(0, 100) : cand.intent, screenName: typeof obj.screenName === 'string' ? obj.screenName.trim().slice(0, 60) : '' };
    } catch { /* try a shorter slice */ }
  }
  return null;
}
