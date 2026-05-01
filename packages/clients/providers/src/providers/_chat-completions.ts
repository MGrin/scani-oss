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
 * errors.
 */

import { type CustomLogger, createComponentLogger } from '@scani/logging';
import type { AIInferenceProvider, Capability } from '../core/capabilities';
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
}

interface ChatCompletionsResponse {
  choices: Array<{ message: { content: string } }>;
  usage?: { total_tokens?: number };
}

export class ChatCompletionsProvider implements AIInferenceProvider {
  readonly providerKey: string;
  readonly capabilities: readonly Capability[] = ['ai-inference'];

  protected readonly logger: CustomLogger;

  constructor(protected readonly config: ChatCompletionsConfig) {
    this.providerKey = config.providerKey;
    this.logger = createComponentLogger(`provider:${config.providerKey}`);
  }

  isConfigured(): boolean {
    return Boolean(this.config.apiKey);
  }

  async parseScreenshot(input: {
    imageBase64: string;
    mimeType: string;
    hint?: string;
  }): Promise<unknown> {
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

  async parseDocumentText(text: string, hint?: string): Promise<unknown> {
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
  ): Promise<string> {
    if (!this.isConfigured()) {
      throw new Error(`${this.config.providerKey}: apiKey not configured`);
    }
    const body = {
      model: this.config.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: opts?.maxTokens ?? this.config.maxTokens ?? 1000,
      temperature: opts?.temperature ?? this.config.temperature ?? 0.7,
    };
    const data = await this.callRaw(body);
    return data.choices?.[0]?.message?.content ?? '';
  }

  // ============================================================
  // Internals
  // ============================================================

  /** Returns the parsed JSON content of the assistant's first choice. */
  private async callJson(body: unknown): Promise<unknown> {
    const data = await this.callRaw(body);
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(`${this.config.providerKey}: no content in response`);
    }
    try {
      return JSON.parse(content);
    } catch (err) {
      throw new Error(
        `${this.config.providerKey}: failed to parse JSON response (${err instanceof Error ? err.message : err})`
      );
    }
  }

  /** Returns the raw `ChatCompletionsResponse`. */
  private async callRaw(body: unknown): Promise<ChatCompletionsResponse> {
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
  }
}

function buildSystemPrompt(): string {
  return `You are a financial data extraction expert. Extract every position the
account holder owns from screenshots or document text. Return JSON in this exact shape:

{
  "holdings": [
    { "symbol": "<ticker>", "name": "<full name>", "balance": "<decimal string>", "confidence": <0-1> }
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
