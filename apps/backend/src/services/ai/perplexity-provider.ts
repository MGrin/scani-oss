import type {
  AIProviderConfig,
  AIProviderResponse,
  ParsedPortfolio,
  PerplexityResponse,
  RawHolding,
} from './types';
import { AIProvider, AIProviderError } from './types';

export class PerplexityProvider extends AIProvider {
  constructor(config: AIProviderConfig) {
    super({
      ...config,
      name: 'Perplexity',
      baseUrl: config.baseUrl || 'https://api.perplexity.ai',
      visionModel: config.visionModel || 'llama-3.2-90b-vision-instruct',
      maxTokens: config.maxTokens || 4000,
      temperature: config.temperature || 0.1,
    });
  }

  isConfigured(): boolean {
    return !!this.config.apiKey;
  }

  async parseScreenshot(
    imageBase64: string,
    options?: {
      accountType?: string;
      expectedCurrency?: string;
      context?: string;
    }
  ): Promise<AIProviderResponse> {
    if (!this.isConfigured()) {
      throw new AIProviderError(
        'Perplexity API key not configured',
        'Perplexity',
        'MISSING_CONFIG'
      );
    }

    const systemPrompt = this.buildSystemPrompt(options);
    const userPrompt = this.buildUserPrompt(options);

    try {
      const startTime = Date.now();

      const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.config.visionModel,
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            {
              role: 'user',
              content: [
                {
                  type: 'text',
                  text: userPrompt,
                },
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/jpeg;base64,${imageBase64}`,
                  },
                },
              ],
            },
          ],
          max_tokens: this.config.maxTokens,
          temperature: this.config.temperature,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new AIProviderError(
          `Perplexity API error: ${response.status} ${response.statusText}`,
          'Perplexity',
          'API_ERROR',
          errorData
        );
      }

      const data = (await response.json()) as PerplexityResponse;
      const processingTime = Date.now() - startTime;

      if (!data.choices?.[0]?.message?.content) {
        throw new AIProviderError('No content in Perplexity response', 'Perplexity', 'NO_CONTENT');
      }

      // Perplexity might not return pure JSON, so we need to extract it
      const content = data.choices[0].message.content;
      let parsedContent: unknown;

      try {
        // Try to find JSON in the response
        const jsonMatch = content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsedContent = JSON.parse(jsonMatch[0]);
        } else {
          parsedContent = JSON.parse(content);
        }
      } catch (error) {
        throw new AIProviderError(
          'Failed to parse Perplexity JSON response',
          'Perplexity',
          'INVALID_JSON',
          error
        );
      }

      const portfolio = this.validateAndNormalizePortfolio(parsedContent);

      return {
        portfolio,
        metadata: {
          model: this.config.visionModel,
          tokensUsed: data.usage?.total_tokens,
          processingTime,
          provider: 'Perplexity',
        },
      };
    } catch (error) {
      if (error instanceof AIProviderError) {
        throw error;
      }

      throw new AIProviderError(
        `Perplexity request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'Perplexity',
        'REQUEST_FAILED',
        error
      );
    }
  }

  private buildSystemPrompt(options?: {
    accountType?: string;
    expectedCurrency?: string;
    context?: string;
  }): string {
    return `You are an expert financial data extraction assistant. Analyze portfolio screenshots and extract holdings data as JSON.

EXTRACTION RULES:
1. Only extract clearly visible holdings/positions
2. Be conservative with confidence scores
3. Look for: symbols, quantities, balances, market values
4. Common formats: Stocks (AAPL), Crypto (BTC), Fiat (USD)
5. Ignore pending/unavailable balances
6. Return valid JSON only

${options?.accountType ? `Account type: ${options.accountType}` : ''}
${options?.expectedCurrency ? `Expected currency: ${options.expectedCurrency}` : ''}
${options?.context ? `Context: ${options.context}` : ''}

Required JSON format:
{
  "holdings": [{"symbol": "AAPL", "name": "Apple Inc.", "balance": "150.50", "confidence": 0.95, "notes": "Stock position"}],
  "overallConfidence": 0.90,
  "context": "Description of screenshot",
  "detectedCurrency": "USD"
}`;
  }

  private buildUserPrompt(_options?: {
    accountType?: string;
    expectedCurrency?: string;
    context?: string;
  }): string {
    return `Extract all holdings from this portfolio screenshot. Return only the JSON structure specified in the system prompt.`;
  }

  private validateAndNormalizePortfolio(data: unknown): ParsedPortfolio {
    if (!data || typeof data !== 'object') {
      throw new AIProviderError(
        'Invalid portfolio data structure',
        'Perplexity',
        'VALIDATION_ERROR'
      );
    }

    const portfolioData = data as Record<string, unknown>;
    const holdings = Array.isArray(portfolioData.holdings) ? portfolioData.holdings : [];

    const validatedHoldings = holdings
      .filter(
        (holding: unknown): holding is RawHolding => holding !== null && typeof holding === 'object'
      )
      .map((holding: RawHolding) => ({
        symbol: String(holding.symbol || '')
          .toUpperCase()
          .trim(),
        name: holding.name ? String(holding.name).trim() : undefined,
        balance: String(holding.balance || '0').trim(),
        confidence: Math.min(Math.max(Number(holding.confidence) || 0, 0), 1),
        notes: holding.notes ? String(holding.notes).trim() : undefined,
      }))
      .filter((holding) => holding.symbol && holding.balance && holding.balance !== '0');

    return {
      holdings: validatedHoldings,
      overallConfidence: Math.min(Math.max(Number(portfolioData.overallConfidence) || 0, 0), 1),
      context: portfolioData.context ? String(portfolioData.context).trim() : undefined,
      detectedCurrency: portfolioData.detectedCurrency
        ? String(portfolioData.detectedCurrency).toUpperCase().trim()
        : undefined,
    };
  }
}
