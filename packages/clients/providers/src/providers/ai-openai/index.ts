/**
 * `OpenAIProvider` — OpenAI vision + chat completions.
 *
 * One model for both roles: `gpt-5.6-luna`. It is newer and cheaper than
 * the `gpt-4o-mini` / `gpt-4o` pair it replaces — $0.20/$1.20 per 1M
 * against gpt-4o's $2.50/$10.00 on the vision path — and a single id
 * removes the question of which tier a given call lands on. Endpoint:
 * `/v1/chat/completions`. Auth: Bearer from `OPENAI_API_KEY`.
 *
 * Model ids verified against this account's own `/v1/models` on
 * 2026-08-11 rather than taken from docs, and image input was confirmed
 * with a live call — the previous pair was chosen from an assumption
 * about PDF support that turned out to be false in production.
 *
 * Pre-refactor source:
 * `packages/ai-providers/src/openai-provider.ts`. The shared
 * `ChatCompletionsProvider` base owns the prompt construction +
 * JSON validation; this file is just the OpenAI-specific config.
 */

import type { ProviderFactory } from '../../core/boot';
import { ChatCompletionsProvider } from '../_chat-completions';

// gpt-5.6-luna's published per-1M-token rate (2026-08-11). One model
// now serves text and vision, so this is the exact rate rather than a
// blend straddling two tiers.
const OPENAI_PRICING = {
  promptUsdPerMillion: 0.2,
  completionUsdPerMillion: 1.2,
};

export class OpenAIProvider extends ChatCompletionsProvider {
  constructor(apiKey: string) {
    super({
      providerKey: 'ai-openai',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-5.6-luna',
      visionModel: 'gpt-5.6-luna',
      apiKey,
      maxTokens: 4000,
      // gpt-5.6-luna renamed the token cap and accepts only the default
      // temperature; both were verified against the live API before this
      // model was adopted, and both reject the request outright.
      tokenLimitParam: 'max_completion_tokens',
      supportsTemperature: false,
      // Verified against the live API 2026-08-11 with the scanned invoice
      // that `invalid_image_format` had been rejecting: as a `file` part
      // gpt-5.6-luna reads the PDF and returns the right total.
      supportsPdfFileInput: true,
      temperature: 0.1,
      rateLimitPerMinute: 30,
      pricing: OPENAI_PRICING,
    });
  }
}

export const aiOpenAIFactory: ProviderFactory = async (deps) => {
  const apiKey = deps.env.OPENAI_API_KEY ?? '';
  deps.reportCredentialStatus({
    provider: 'openai',
    envVar: 'OPENAI_API_KEY',
    keyed: apiKey !== '',
    degradedBehaviour: 'throws on every call, so screenshot and document parsing fail',
  });
  return new OpenAIProvider(apiKey);
};
