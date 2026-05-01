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
