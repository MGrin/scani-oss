/**
 * `OpenAIProvider` — OpenAI vision + chat completions.
 *
 * Vision model: `gpt-4o`. Text-only fallback: same model (good
 * enough for the JSON-shaped extraction tasks). Endpoint:
 * `/v1/chat/completions`. Auth: Bearer API key from
 * `OPENAI_API_KEY`.
 *
 * Pre-refactor source:
 * `packages/ai-providers/src/openai-provider.ts`. The shared
 * `ChatCompletionsProvider` base owns the prompt construction +
 * JSON validation; this file is just the OpenAI-specific config.
 */

import type { ProviderFactory } from '../../core/boot';
import { ChatCompletionsProvider } from '../_chat-completions';

// Reflects OpenAI's published per-1M-token pricing for the models used
// here (gpt-4o-mini for text, gpt-4o for vision). The blended rate
// straddles both; for the dashboard a single per-call cost estimate is
// good enough — token-level refinement can come later.
const OPENAI_PRICING = {
  promptUsdPerMillion: 0.15,
  completionUsdPerMillion: 0.6,
};

export class OpenAIProvider extends ChatCompletionsProvider {
  constructor(apiKey: string) {
    super({
      providerKey: 'ai-openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      visionModel: 'gpt-4o',
      apiKey,
      maxTokens: 4000,
      temperature: 0.1,
      rateLimitPerMinute: 30,
      pricing: OPENAI_PRICING,
    });
  }
}

export const aiOpenAIFactory: ProviderFactory = async (deps) => {
  const apiKey = deps.env.OPENAI_API_KEY ?? '';
  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.warn('OpenAIProvider: OPENAI_API_KEY not set; provider will throw on every call');
  }
  return new OpenAIProvider(apiKey);
};
