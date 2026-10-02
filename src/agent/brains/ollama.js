// Local Ollama brain (free, offline). Uses a text model; asks for JSON.
import { SYSTEM_PROMPT, buildUserMessage, parseDecision } from './prompt.js';

const HOST = process.env.OLLAMA_HOST?.replace(/\/$/, '') || 'http://localhost:11434';
const PREFERRED = [/qwen2\.5-coder:14b/i, /qwen2\.5-coder-tools/i, /qwen3:(14|8|32)b/i, /llama3\.[1-3]:(8|70)b/i, /qwen2\.5:(14|7|32)b/i, /gemma3:(12|27)b/i, /mistral/i, /gemma3:4b/i];
const TOO_SMALL = /:(0\.\d|1|1\.\d|2|2\.\d|3)b\b/i;

export async function probeOllama({ timeoutMs = 1500 } = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(`${HOST}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return { available: false, models: [], host: HOST };
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    return { available: models.length > 0, models, host: HOST, defaultModel: pickModel(models) };
  } catch {
    return { available: false, models: [], host: HOST };
  }
}

export function pickModel(models) {
  if (process.env.MOTVIN_OLLAMA_MODEL && models.includes(process.env.MOTVIN_OLLAMA_MODEL)) return process.env.MOTVIN_OLLAMA_MODEL;
  for (const re of PREFERRED) { const m = models.find((n) => re.test(n)); if (m) return m; }
  return models.find((n) => !TOO_SMALL.test(n)) || models[0] || null;
}

export function createOllamaBrain({ model } = {}) {
  let resolvedModel = model || null;
  return {
    id: 'ollama',
    label: `Ollama${resolvedModel ? ` · ${resolvedModel}` : ''}`,
    get model() { return resolvedModel; },
    async init() {
      const info = await probeOllama();
      if (!info.available) throw new Error(`Ollama is not reachable at ${HOST}.`);
      if (!resolvedModel || !info.models.includes(resolvedModel)) resolvedModel = info.defaultModel;
      if (!resolvedModel) throw new Error('Ollama has no models installed. Run e.g. `ollama pull qwen2.5-coder:14b`.');
      this.label = `Ollama · ${resolvedModel}`;
    },
    async decide(ctx) {
      const body = {
        model: resolvedModel,
        stream: false,
        format: 'json',
        options: { temperature: 0.2, num_predict: 200 },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserMessage(ctx) },
        ],
      };
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 90000);
      try {
        const res = await fetch(`${HOST}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
        if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const data = await res.json();
        const text = data.message?.content || '';
        const decision = parseDecision(text, ctx.candidates);
        if (!decision) throw new Error(`Ollama reply was not a usable decision: ${text.slice(0, 120)}`);
        return decision;
      } finally { clearTimeout(t); }
    },
  };
}
