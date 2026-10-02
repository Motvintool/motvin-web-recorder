// Brain registry: resolves "auto" to the best available backend and reports availability to the UI.
import { heuristicBrain } from './heuristic.js';
import { createOllamaBrain, probeOllama } from './ollama.js';
import { createAnthropicBrain, anthropicConfigured } from './anthropic.js';

export async function describeBackends() {
  const ollama = await probeOllama();
  const anthropic = { available: anthropicConfigured(), model: process.env.MOTVIN_ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-5-5' };
  const auto = anthropic.available ? 'anthropic' : ollama.available ? 'ollama' : 'heuristic';
  return {
    auto,
    backends: [
      { id: 'anthropic', label: 'Claude', available: anthropic.available, detail: anthropic.available ? anthropic.model : 'Set ANTHROPIC_API_KEY to enable' },
      { id: 'ollama', label: 'Ollama (local)', available: ollama.available, detail: ollama.available ? ollama.defaultModel : `Not running at ${ollama.host}`, models: ollama.models },
      { id: 'heuristic', label: 'Built-in planner', available: true, detail: 'No model needed' },
    ],
  };
}

/** @returns {Promise<{brain: object, fallback: object}>} */
export async function resolveBrain({ backend = 'auto', model } = {}) {
  let id = backend;
  if (id === 'auto') {
    if (anthropicConfigured()) id = 'anthropic';
    else if ((await probeOllama()).available) id = 'ollama';
    else id = 'heuristic';
  }
  let brain;
  if (id === 'anthropic') brain = createAnthropicBrain(model ? { model } : {});
  else if (id === 'ollama') brain = createOllamaBrain({ model });
  else brain = heuristicBrain;
  if (brain.init) await brain.init();
  return { brain, fallback: heuristicBrain };
}
