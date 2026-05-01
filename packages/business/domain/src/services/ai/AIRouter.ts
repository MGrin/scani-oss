/**
 * `AIRouter` — facade over `ProviderRegistry`'s AI provider list.
 * The domain layer talks to the registry-backed providers through
 * this single entry point.
 *
 * Behaviour:
 *  - `parseScreenshot()` / `parseDocumentText()` walk the AI provider
 *    list as a fallback chain — first one that returns a non-empty
 *    result wins; others are tried on throw.
 *  - `completeText()` does the same for free-form completions.
 *  - `hasAvailableProvider()` returns true if any registered provider
 *    is configured.
 *  - `getAvailableProviders()` returns the provider keys in order so
 *    the liveness endpoint can show what's wired.
 *
 * The registry is queried lazily on every call so providers wired up
 * after the router was constructed are visible (matches the
 * `Container.get` semantics elsewhere in the domain layer).
 */

import { type CustomLogger, createComponentLogger } from '@scani/logging';
import type { AIInferenceProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { Container, Service } from 'typedi';

export interface ParsedHolding {
  symbol: string;
  name?: string;
  balance: string;
  confidence: number;
  notes?: string;
}

export interface ParsedPortfolio {
  holdings: ParsedHolding[];
  overallConfidence: number;
  context?: string;
  detectedCurrency?: string;
}

export interface AIProviderResponse {
  portfolio: ParsedPortfolio;
  metadata?: {
    model?: string;
    tokensUsed?: number;
    processingTime?: number;
    provider?: string;
    [key: string]: unknown;
  };
}

// Shape `CsvColumnDetectionService` expects from `completeText`.
export interface CompleteTextResult {
  content: string;
  provider: string;
  model?: string;
}

export interface CompleteTextOptions {
  maxTokens?: number;
  temperature?: number;
  jsonMode?: boolean;
  fallbackProviders?: boolean;
}

export interface ParseScreenshotOptions {
  provider?: string;
  accountType?: string;
  expectedCurrency?: string;
  context?: string;
  minConfidence?: number;
  mimeType?: string;
  fallbackProviders?: boolean;
}

export interface ParseDocumentTextOptions {
  provider?: string;
  accountType?: string;
  expectedCurrency?: string;
  context?: string;
}

@Service()
export class AIRouter {
  private readonly logger: CustomLogger;

  constructor() {
    this.logger = createComponentLogger('ai-router');
  }

  /**
   * Snapshot of registered AI providers. Resolved on each call so a
   * registry that gets populated after boot still sees its full set
   * — same semantics as `Container.get` elsewhere in domain code.
   */
  private getProviders(): readonly AIInferenceProvider[] {
    try {
      const registry = Container.get(ProviderRegistry);
      return registry.getAIProviders();
    } catch (err) {
      this.logger.warn(
        { err: err instanceof Error ? err.message : err },
        'ProviderRegistry not available; AIRouter has no providers'
      );
      return [];
    }
  }

  hasAvailableProvider(): boolean {
    return this.getProviders().length > 0;
  }

  getAvailableProviders(): Array<{ providerKey: string }> {
    return this.getProviders().map((p) => ({ providerKey: p.providerKey }));
  }

  getStatus(): {
    availableProviders: Array<{ providerKey: string }>;
    hasAvailableProvider: boolean;
  } {
    return {
      availableProviders: this.getAvailableProviders(),
      hasAvailableProvider: this.hasAvailableProvider(),
    };
  }

  /**
   * Vision parsing with fallback. Each provider returns the parsed
   * JSON object directly (the `AIInferenceProvider.parseScreenshot`
   * shape); we re-shape it into the `AIProviderResponse`
   * `{ portfolio, metadata }` consumers expect.
   *
   * `opts.provider` filters the chain to a specific providerKey when
   * the caller wants forced provider selection (debugging UI).
   */
  async parseScreenshot(
    imageBase64: string,
    opts: ParseScreenshotOptions = {}
  ): Promise<AIProviderResponse> {
    const providers = this.selectProviders(opts.provider);
    if (providers.length === 0) {
      throw new Error('AIRouter: no AI providers available for screenshot parsing');
    }
    const mimeType = opts.mimeType ?? 'image/jpeg';
    const hint = this.buildHint(opts);

    let lastError: Error | null = null;
    for (const provider of providers) {
      const start = Date.now();
      try {
        const raw = await provider.parseScreenshot({
          imageBase64,
          mimeType,
          hint,
        });
        const portfolio = normalizePortfolio(raw);
        return {
          portfolio,
          metadata: {
            provider: provider.providerKey,
            processingTime: Date.now() - start,
          },
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(
          { provider: provider.providerKey, err: lastError.message },
          'AI provider failed parseScreenshot; trying next'
        );
      }
    }
    throw lastError ?? new Error('AIRouter: every provider failed parseScreenshot');
  }

  async parseDocumentText(
    text: string,
    opts: ParseDocumentTextOptions = {}
  ): Promise<AIProviderResponse> {
    const providers = this.selectProviders(opts.provider);
    if (providers.length === 0) {
      throw new Error('AIRouter: no AI providers available for document parsing');
    }
    const hint = this.buildHint(opts);

    let lastError: Error | null = null;
    for (const provider of providers) {
      if (!provider.parseDocumentText) continue;
      const start = Date.now();
      try {
        const raw = await provider.parseDocumentText(text, hint);
        const portfolio = normalizePortfolio(raw);
        return {
          portfolio,
          metadata: {
            provider: provider.providerKey,
            processingTime: Date.now() - start,
          },
        };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(
          { provider: provider.providerKey, err: lastError.message },
          'AI provider failed parseDocumentText; trying next'
        );
      }
    }
    throw lastError ?? new Error('AIRouter: every provider failed parseDocumentText');
  }

  /**
   * Free-form completion. The `jsonMode` option is informational
   * only — the underlying providers always set
   * `response_format: json_object` for parse* calls and don't expose
   * a separate flag for `completeText`. Callers that need JSON output
   * should use `parseDocumentText` instead.
   */
  async completeText(prompt: string, opts: CompleteTextOptions = {}): Promise<CompleteTextResult> {
    const providers = this.getProviders();
    if (providers.length === 0) {
      throw new Error('AIRouter: no AI providers available for text completion');
    }
    let lastError: Error | null = null;
    for (const provider of providers) {
      if (!provider.completeText) continue;
      try {
        const content = await provider.completeText(prompt, {
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
        });
        return { content, provider: provider.providerKey };
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn(
          { provider: provider.providerKey, err: lastError.message },
          'AI provider failed completeText; trying next'
        );
      }
    }
    throw lastError ?? new Error('AIRouter: every provider failed completeText');
  }

  // ============================================================
  // Internals
  // ============================================================

  private selectProviders(forceProvider?: string): readonly AIInferenceProvider[] {
    const all = this.getProviders();
    if (!forceProvider) return all;
    // Tolerant match: callers (job payloads, debug UI) historically
    // pass the short provider name like `openai`, but during the
    // providers refactor every AI provider got an `ai-` namespace
    // prefix on its providerKey (`openai` → `ai-openai`) to disambiguate
    // from chain/exchange providers. Accept both forms so old job
    // payloads still route correctly without a producer-side migration.
    const normalized = forceProvider.startsWith('ai-') ? forceProvider : `ai-${forceProvider}`;
    const found = all.find((p) => p.providerKey === forceProvider || p.providerKey === normalized);
    if (found) return [found];
    // No exact match — fall back to the full list with a warning
    // rather than failing silently. `forceProvider` is a debug hint,
    // not a hard gate; an unknown name shouldn't kill the request.
    this.logger.warn(
      { forceProvider, available: all.map((p) => p.providerKey) },
      'AIRouter: forced provider not found; falling back to full provider list'
    );
    return all;
  }

  private buildHint(opts: {
    accountType?: string;
    expectedCurrency?: string;
    context?: string;
  }): string {
    const lines: string[] = [];
    if (opts.accountType) lines.push(`Account type: ${opts.accountType}`);
    if (opts.expectedCurrency) lines.push(`Expected currency: ${opts.expectedCurrency}`);
    if (opts.context) lines.push(`Context: ${opts.context}`);
    return lines.join('\n');
  }
}

/**
 * Coerce an arbitrary AI response into a `ParsedPortfolio`. The new
 * provider contract returns `unknown` (the parsed JSON), but in
 * practice every provider returns roughly the same shape; we
 * defensively tolerate missing fields so a half-good response still
 * surfaces what it can.
 */
function normalizePortfolio(raw: unknown): ParsedPortfolio {
  if (!raw || typeof raw !== 'object') {
    return { holdings: [], overallConfidence: 0 };
  }
  const obj = raw as Record<string, unknown>;
  const holdings: ParsedHolding[] = [];
  const rawHoldings = Array.isArray(obj.holdings) ? obj.holdings : [];
  for (const h of rawHoldings) {
    if (!h || typeof h !== 'object') continue;
    const hh = h as Record<string, unknown>;
    const symbol = typeof hh.symbol === 'string' ? hh.symbol : '';
    const balance = typeof hh.balance === 'string' ? hh.balance : String(hh.balance ?? '0');
    if (!symbol) continue;
    holdings.push({
      symbol,
      name: typeof hh.name === 'string' ? hh.name : undefined,
      balance,
      confidence:
        typeof hh.confidence === 'number'
          ? hh.confidence
          : typeof hh.confidence === 'string'
            ? Number.parseFloat(hh.confidence) || 0
            : 0.5,
      notes: typeof hh.notes === 'string' ? hh.notes : undefined,
    });
  }
  return {
    holdings,
    overallConfidence:
      typeof obj.overallConfidence === 'number'
        ? obj.overallConfidence
        : holdings.length > 0
          ? 0.7
          : 0,
    context: typeof obj.context === 'string' ? obj.context : undefined,
    detectedCurrency: typeof obj.detectedCurrency === 'string' ? obj.detectedCurrency : undefined,
  };
}
