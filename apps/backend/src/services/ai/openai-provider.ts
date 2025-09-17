import type {
  AIProviderConfig,
  AIProviderResponse,
  OpenAIResponse,
  ParsedPortfolio,
  RawHolding,
} from './types';
import { AIProvider, AIProviderError } from './types';

export class OpenAIProvider extends AIProvider {
  constructor(config: AIProviderConfig) {
    super({
      ...config,
      name: 'OpenAI',
      baseUrl: config.baseUrl || 'https://api.openai.com/v1',
      visionModel: config.visionModel || 'gpt-4o',
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
      throw new AIProviderError('OpenAI API key not configured', 'OpenAI', 'MISSING_CONFIG');
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
                    detail: 'high',
                  },
                },
              ],
            },
          ],
          max_tokens: this.config.maxTokens,
          temperature: this.config.temperature,
          response_format: { type: 'json_object' },
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new AIProviderError(
          `OpenAI API error: ${response.status} ${response.statusText}`,
          'OpenAI',
          'API_ERROR',
          errorData
        );
      }

      const data = (await response.json()) as OpenAIResponse;
      const processingTime = Date.now() - startTime;

      if (!data.choices?.[0]?.message?.content) {
        throw new AIProviderError('No content in OpenAI response', 'OpenAI', 'NO_CONTENT');
      }

      let parsedContent: unknown;
      try {
        parsedContent = JSON.parse(data.choices[0].message.content);
      } catch (error) {
        throw new AIProviderError(
          'Failed to parse OpenAI JSON response',
          'OpenAI',
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
          provider: 'OpenAI',
        },
      };
    } catch (error) {
      if (error instanceof AIProviderError) {
        throw error;
      }

      throw new AIProviderError(
        `OpenAI request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'OpenAI',
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
    return `You are an expert financial data extraction assistant. Your task is to analyze screenshots of financial portfolios, trading accounts, or investment statements and extract structured holding information.

IMPORTANT GUIDELINES:
1. Extract ONLY holdings/positions that are clearly visible and readable
2. Be conservative - if you're not confident about a value, mark it with lower confidence
3. Common symbols: Stocks (AAPL, MSFT), Crypto (BTC, ETH), Fiat (USD, EUR, GBP)
4. Look for: Asset names/symbols, quantities, balances, market values
5. Ignore: Pending transactions, unavailable balances, margin requirements
6. If amounts are in different currencies, note the detected currency
7. Return ONLY valid JSON in the specified format

${
  options?.accountType
    ? `ACCOUNT CONTEXT: This appears to be a ${options.accountType} account.`
    : ''
}
${
  options?.expectedCurrency
    ? `EXPECTED CURRENCY: Values are likely in ${options.expectedCurrency}.`
    : ''
}
${options?.context ? `ADDITIONAL CONTEXT: ${options.context}` : ''}

RESPONSE FORMAT - Return valid JSON only:
{
  "holdings": [
    {
      "symbol": "AAPL",
      "name": "Apple Inc.",
      "balance": "150.50",
      "confidence": 0.95,
      "notes": "Clear stock position"
    }
  ],
  "overallConfidence": 0.90,
  "context": "Brokerage account screenshot showing 3 stock positions",
  "detectedCurrency": "USD"
}`;
  }

  private buildUserPrompt(_options?: {
    accountType?: string;
    expectedCurrency?: string;
    context?: string;
  }): string {
    return `Please analyze this financial portfolio screenshot and extract all visible holdings/positions. 

Look for:
- Stock symbols and quantities
- Cryptocurrency holdings  
- Cash balances
- Mutual funds, ETFs
- Any other investment positions

Extract the data into the JSON format specified in the system prompt. Be accurate and conservative with confidence scores.`;
  }

  private validateAndNormalizePortfolio(data: unknown): ParsedPortfolio {
    if (!data || typeof data !== 'object') {
      throw new AIProviderError('Invalid portfolio data structure', 'OpenAI', 'VALIDATION_ERROR');
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
