// Claude brain via the official SDK. Enabled when ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN is set.
import { SYSTEM_PROMPT, buildUserMessage, parseDecision } from './prompt.js';

const DEFAULT_MODEL = process.env.MOTVIN_ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-5-5';

export function anthropicConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function createAnthropicBrain({ model = DEFAULT_MODEL } = {}) {
  let client = null;
  let useFallbacks = true;
  return {
    id: 'anthropic',
    label: `Claude · ${model}`,
    model,
    async init() {
      if (!anthropicConfigured()) throw new Error('No Anthropic credentials. Set ANTHROPIC_API_KEY (or run `ant auth login`).');
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      client = new Anthropic({ timeout: 60_000, maxRetries: 1 });
    },
    async decide(ctx) {
      const messages = [{ role: 'user', content: buildUserMessage(ctx) }];
      const base = { model, max_tokens: 400, system: SYSTEM_PROMPT, messages, output_config: { effort: 'low' } };
      let response;
      try {
        response = useFallbacks
          ? await client.beta.messages.create({ ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
          : await client.messages.create(base);
      } catch (err) {
        // Proxies / older gateways may reject the fallback fields or effort; retry plainly once.
        if (err?.status === 400 && useFallbacks) {
          useFallbacks = false;
          const { output_config, ...plain } = base;
          response = await client.messages.create(plain);
        } else throw err;
      }
      if (response.stop_reason === 'refusal') throw new Error('Claude declined this step (safety refusal).');
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      const decision = parseDecision(text, ctx.candidates);
      if (!decision) throw new Error(`Claude reply was not a usable decision: ${text.slice(0, 120)}`);
      return decision;
    },
  };
}
