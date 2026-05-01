/**
 * `DeepSeekProvider` — DeepSeek V3.
 *
 * Endpoint: `https://api.deepseek.com/v1/chat/completions`. Auth:
 * Bearer API key from `DEEPSEEK_API_KEY`.
 *
 * Vision: `deepseek-vl2` is the vision-capable model; `deepseek-chat`
 * for general completions. We expose vision when configured but the
 * AIRouter typically keeps DeepSeek as the budget fallback after
 * OpenAI + Perplexity.
 *
 * Pre-refactor source:
 * `packages/ai-providers/src/deepseek-provider.ts`.
 */

import type { ProviderFactory } from '../../core/boot';
import { ChatCompletionsProvider } from '../_chat-completions';

export class DeepSeekProvider extends ChatCompletionsProvider {
  constructor(apiKey: string) {
    super({
      providerKey: 'ai-deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      // DeepSeek's vision model lives at a different path on most
      // SaaS deployments; prefer the chat model for now and let
      // OpenAI/Perplexity handle screenshots in the fallback chain.
      apiKey,
      maxTokens: 4000,
      temperature: 0.1,
    });
  }
}

export const aiDeepseekFactory: ProviderFactory = async (deps) => {
  const apiKey = deps.env.DEEPSEEK_API_KEY ?? '';
  if (!apiKey) {
    // eslint-disable-next-line no-console
    console.warn('DeepSeekProvider: DEEPSEEK_API_KEY not set; provider will throw on every call');
  }
  return new DeepSeekProvider(apiKey);
};
