/**
 * `AIStubProvider` — fixed-payload AI provider used by the e2e suite.
 *
 * Registered only when `STUB_AI === '1'` is in the env. Sits in front
 * of the real chain so `parseScreenshot` / `parseDocumentText` /
 * `completeText` all short-circuit to a deterministic response without
 * touching upstream APIs (no OpenAI key, no network, no cost).
 *
 * The payload mirrors the data-provider's `ai.parseScreenshot` stub
 * (`apps/backend/data-provider/src/presentation/routers/ai.ts`) so e2e
 * tests assert against the same shape regardless of which tier dispatch
 * mode (`direct` vs `cloud`) the worker is running in.
 *
 * Refusal in production: the worker reads `STUB_AI` directly from
 * `process.env`, but the data-provider's `loadEnv()` already rejects
 * `STUB_AI=1` when `NODE_ENV=production`. Both binaries inherit env
 * from the same compose file, so a misconfigured production deploy
 * would crash the data-provider at boot before the worker ever runs.
 */

import type { ProviderFactory } from '../../core/boot';
import type { AIInferenceProvider, AIResult, Capability } from '../../core/capabilities';

const STUB_PORTFOLIO = {
  holdings: [
    { symbol: 'BTC', name: 'Bitcoin', balance: '0.5', confidence: 0.95 },
    { symbol: 'ETH', name: 'Ethereum', balance: '10', confidence: 0.92 },
    { symbol: 'USD', name: 'US Dollar', balance: '5000', confidence: 1.0 },
  ],
  overallConfidence: 0.94,
  context: 'stub',
  detectedCurrency: 'USD',
} as const;

const STUB_USAGE = { tokensIn: 0, tokensOut: 0, totalTokens: 0, upstreamCostUsd: 0 } as const;

// Impersonates `ai-openai` so the AIRouter's "force specific provider"
// path (driven by `provider: 'openai'` in user-initiated screenshot
// jobs) picks the stub up by name. The registry registers the FIRST
// provider for a given key, so when `aiStubFactory` runs before
// `aiOpenAIFactory` (see api/worker boot) the stub wins.
const STUB_PROVIDER_KEY = 'ai-openai';

export class AIStubProvider implements AIInferenceProvider {
  readonly providerKey = STUB_PROVIDER_KEY;
  readonly capabilities: readonly Capability[] = ['ai-inference'];

  parseScreenshot(_input: {
    imageBase64: string;
    mimeType: string;
    hint?: string;
  }): Promise<AIResult<unknown>> {
    return Promise.resolve({ data: STUB_PORTFOLIO, usage: STUB_USAGE });
  }

  parseDocumentText(_text: string, _hint?: string): Promise<AIResult<unknown>> {
    return Promise.resolve({ data: STUB_PORTFOLIO, usage: STUB_USAGE });
  }

  completeText(
    _prompt: string,
    _opts?: { temperature?: number; maxTokens?: number }
  ): Promise<AIResult<string>> {
    return Promise.resolve({ data: '{}', usage: STUB_USAGE });
  }
}

export const aiStubFactory: ProviderFactory = async (_deps) => {
  return new AIStubProvider();
};
