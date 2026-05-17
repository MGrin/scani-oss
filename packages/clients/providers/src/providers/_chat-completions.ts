/**
 * Shared base for OpenAI-compatible `/chat/completions` providers.
 * Currently only OpenAI extends this; the shape is generic so any
 * future OpenAI-API-compatible vendor can subclass with a config
 * change rather than a re-implementation.
 *
 * Methods exposed via the `AIInferenceProvider` capability:
 *  - `parseScreenshot({ imageBase64, mimeType, hint })` →
 *    multimodal request with the image and a JSON-shaped prompt.
 *  - `parseDocumentText(text, hint)` → text-only completion with the
 *    same JSON-output contract.
 *  - `completeText(prompt, opts)` → generic completion, returns the
 *    raw text.
 *
 * Failure handling: every method throws on transport / 4xx / 5xx
 * errors. Every successful response is paced through an outflow
 * rate-limiter (per-providerKey) so a runaway batch can't pin upstream
 * to its 429-budget; usage tokens are parsed off the response and
 * returned alongside the parsed data so the data-provider's usage
 * middleware can attribute upstream cost back to the calling tenant.
 */

import { type CustomLogger, createComponentLogger } from '@scani/logging';
import { createOutflowLimiter, getSharedRedis, type OutflowRateLimiter } from '@scani/rate-limiter';
import type { AIInferenceProvider, AIResult, AIUsage, Capability } from '../core/capabilities';
import { fetchWithTimeout } from '../core/utils/fetch';

export interface ChatCompletionsConfig {
  providerKey: string;
  baseUrl: string;
  model: string;
  /** Vision-capable model. When undefined the provider declines image
      input by throwing — let the AIRouter fall through to a vision
      provider. */
  visionModel?: string;
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
  /** Per-minute upstream call budget for this provider key. Defaults
      to a conservative 20/min. Override via factory if you have a
      higher OpenAI tier. */
  rateLimitPerMinute?: number;
  /** Pricing table for `upstreamCostUsd` calculation. USD per 1M
      tokens. Optional — when absent, `usage.upstreamCostUsd` is left
      unset and the dashboard applies its fallback rate. */
  pricing?: {
    promptUsdPerMillion: number;
    completionUsdPerMillion: number;
  };
}

interface ChatCompletionsResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

const DEFAULT_RATE_LIMIT_PER_MINUTE = 20;

export class ChatCompletionsProvider implements AIInferenceProvider {
  readonly providerKey: string;
  readonly capabilities: readonly Capability[] = ['ai-inference'];

  protected readonly logger: CustomLogger;
  private readonly limiter: OutflowRateLimiter;

  constructor(protected readonly config: ChatCompletionsConfig) {
    this.providerKey = config.providerKey;
    this.logger = createComponentLogger(`provider:${config.providerKey}`);
    // Redis-backed when the host app initialised the shared client
    // (api / worker / data-provider), in-memory in tests / OSS without
    // Redis. Namespace per providerKey so OpenAI ≠ Perplexity ≠ DeepSeek
    // budgets stay independent.
    this.limiter = createOutflowLimiter({
      maxRequests: config.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE,
      windowMs: 60_000,
      redis: getSharedRedis(),
      namespace: `ai:${config.providerKey}`,
    });
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async parseScreenshot(input: {
    imageBase64: string;
    mimeType: string;
    hint?: string;
  }): Promise<AIResult<unknown>> {
    if (!this.isConfigured()) {
      throw new Error(`${this.config.providerKey}: apiKey not configured`);
    }
    if (!this.config.visionModel) {
      throw new Error(`${this.config.providerKey}: vision not supported by configured model`);
    }
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(input.hint);
    const body = {
      model: this.config.visionModel,
      messages: [
        { role: 'system', content: systemPrompt },
        {
          role: 'user',
          content: [
            { type: 'text', text: userPrompt },
            {
              type: 'image_url',
              image_url: {
                url: `data:${input.mimeType || 'image/jpeg'};base64,${input.imageBase64}`,
                detail: 'high',
              },
            },
          ],
        },
      ],
      max_tokens: this.config.maxTokens ?? 4000,
      temperature: this.config.temperature ?? 0.1,
      response_format: { type: 'json_object' },
    };
    return this.callJson(body);
  }

  async parseDocumentText(text: string, hint?: string): Promise<AIResult<unknown>> {
    if (!this.isConfigured()) {
      throw new Error(`${this.config.providerKey}: apiKey not configured`);
    }
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(hint, text);
    const body = {
      model: this.config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: this.config.maxTokens ?? 4000,
      temperature: this.config.temperature ?? 0.1,
      response_format: { type: 'json_object' },
    };
    return this.callJson(body);
  }

  async completeText(
    prompt: string,
    opts?: { temperature?: number; maxTokens?: number }
  ): Promise<AIResult<string>> {
    if (!this.isConfigured()) {
      throw new Error(`${this.config.providerKey}: apiKey not configured`);
    }
    const body = {
      model: this.config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: opts?.maxTokens ?? this.config.maxTokens ?? 1000,
      temperature: opts?.temperature ?? this.config.temperature ?? 0.7,
    };
    const { data, usage } = await this.callRaw(body);
    return {
      data: data.choices?.[0]?.message?.content ?? '',
      usage,
    };
  }

  // ============================================================
  // Internals
  // ============================================================

  /** Returns the parsed JSON content of the assistant's first choice. */
  private async callJson(body: unknown): Promise<AIResult<unknown>> {
    const { data, usage } = await this.callRaw(body);
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`${this.config.providerKey}: no content in response`);
    }
    try {
      return { data: JSON.parse(content), usage };
    } catch (err) {
      throw new Error(
        `${this.config.providerKey}: failed to parse JSON response (${err instanceof Error ? err.message : err})`
      );
    }
  }

  /** Returns the raw `ChatCompletionsResponse` and parsed token usage. */
  private async callRaw(
    body: unknown
  ): Promise<{ data: ChatCompletionsResponse; usage?: AIUsage }> {
    const data = await this.limiter.execute(async () => {
      const response = await fetchWithTimeout(
        `${this.config.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        },
        30000,
        0
      );
      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(
          `${this.config.providerKey} HTTP ${response.status}: ${errorBody.slice(0, 300)}`
        );
      }
      return (await response.json()) as ChatCompletionsResponse;
    });
    return { data, usage: this.extractUsage(data) };
  }

  private extractUsage(data: ChatCompletionsResponse): AIUsage | undefined {
    const u = data.usage;
    if (!u) return undefined;
    const tokensIn = typeof u.prompt_tokens === 'number' ? u.prompt_tokens : 0;
    const tokensOut = typeof u.completion_tokens === 'number' ? u.completion_tokens : 0;
    const totalTokens = typeof u.total_tokens === 'number' ? u.total_tokens : tokensIn + tokensOut;
    let upstreamCostUsd: number | undefined;
    if (this.config.pricing) {
      upstreamCostUsd =
        (tokensIn * this.config.pricing.promptUsdPerMillion) / 1_000_000 +
        (tokensOut * this.config.pricing.completionUsdPerMillion) / 1_000_000;
    }
    return { tokensIn, tokensOut, totalTokens, upstreamCostUsd };
  }
}

function buildSystemPrompt(): string {
  return `You are a financial data extraction expert. Extract every position the
account holder owns from screenshots or document text. Return JSON in this exact shape:

{
  "holdings": [
    { "symbol": "<ticker>", "name": "<full name>", "assetType": "<fiat|crypto|stock>", "balance": "<decimal string>", "confidence": <0-1> }
  ],
  "overallConfidence": <0-1>,
  "detectedCurrency": "<ISO currency code>"
}

A "holding" is anything with a balance the user owns. This includes:
  • crypto tokens (BTC, ETH, USDC, …)
  • stocks / ETFs (AAPL, VTI, …)
  • fiat cash balances on bank, brokerage, or wallet statements (USD, EUR, GBP, …) —
    use the ISO currency code as both symbol and (if no other name is given) name.
    For a savings/checking statement with a single currency, the holding's balance is
    the closing balance shown on the statement.

Classify every holding with "assetType", based on what the screenshot actually shows:
  • "fiat"   — a cash or currency balance (a "Cash", "Available balance", "Buying
               power" or account-balance line). A 3-letter ISO-4217 currency code
               (USD, EUR, GBP, CHF, JPY, …) shown as a cash/account balance is ALWAYS
               "fiat" — never a stock, even though some currency codes also exist as
               equity tickers.
  • "crypto" — a cryptocurrency or token (including stablecoins like USDT, USDC).
  • "stock"  — a publicly traded stock, ETF, fund, or other equity/commodity.
When genuinely unsure, pick the most likely type and lower "confidence".

Always return at least one holding when the document clearly shows an account balance.
Be conservative with confidence — when in doubt, lower it. Use Decimal.js-safe string
representation for balance (no scientific notation, no thousands separators).`;
}

function buildUserPrompt(hint?: string, text?: string): string {
  const lines: string[] = [];
  lines.push('Extract every visible token holding from the input.');
  if (hint) lines.push(`Hint: ${hint}`);
  if (text) lines.push(`Document text:\n${text.slice(0, 32000)}`);
  return lines.join('\n\n');
}
