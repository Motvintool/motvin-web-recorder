// Deterministic brain: takes the planner's top-ranked candidate. Always available, no model needed.
export const heuristicBrain = {
  id: 'heuristic',
  label: 'Built-in planner',
  async decide({ candidates }) {
    const best = candidates.find((c) => c.score > -30) || candidates[0] || null;
    if (!best) return null;
    return { candidateId: best.id, intent: best.intent, reasoning: 'highest heuristic score' };
  },
  async nameScreen({ fallback }) { return fallback; },
};
