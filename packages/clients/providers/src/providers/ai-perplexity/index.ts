/**
 * `PerplexityProvider` — Perplexity Sonar.
 *
 * Endpoint: `https://api.perplexity.ai/chat/completions`. Auth:
 * Bearer API key from `PERPLEXITY_API_KEY`.
 *
 * Vision: `sonar-pro` supports image inputs in OpenAI-compatible
 * `image_url` format; `sonar` does not. We default to `sonar-pro`
 * for both text and vision.
 *
 * Pre-refactor source:
 * `packages/ai-providers/src/perplexity-provider.ts`.
 */

import type { ProviderFactory } from '../../core/boot';
import { ChatCompletionsProvider } from '../_chat-completions';

export class PerplexityProvider extends ChatCompletionsProvider {
  constructor(apiKey: string) {
    super({
      providerKey: 'ai-perplexity',
      baseUrl: 'https://api.perplexity.ai',
      model: 'sonar',
      visionModel: 'sonar-pro',
      apiKey,
      maxTokens: 4000,
      temperature: 0.1,
    });
  }
}

export const aiPerplexityFactory: ProviderFactory = async (deps) => {
  const apiKey = deps.env.PERPLEXITY_API_KEY ?? '';
  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.warn(
      'PerplexityProvider: PERPLEXITY_API_KEY not set; provider will throw on every call'
    );
  }
  return new PerplexityProvider(apiKey);
};
