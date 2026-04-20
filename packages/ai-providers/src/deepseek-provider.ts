import type {
  AIProviderConfig,
  AIProviderResponse,
  DeepSeekResponse,
  ParsedPortfolio,
  RawHolding,
} from './types';
import { AIProvider, AIProviderError } from './types';

export class DeepSeekProvider extends AIProvider {
  constructor(config: AIProviderConfig) {
    super({
      ...config,
      name: 'DeepSeek',
      baseUrl: config.baseUrl || 'https://api.deepseek.com/v1',
      visionModel: config.visionModel || 'deepseek-vl',
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
      mimeType?: string;
    }
  ): Promise<AIProviderResponse> {
    if (!this.isConfigured()) {
      throw new AIProviderError('DeepSeek API key not configured', 'DeepSeek', 'MISSING_CONFIG');
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
                    url: `data:${options?.mimeType || 'image/jpeg'};base64,${imageBase64}`,
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
          `DeepSeek API error: ${response.status} ${response.statusText}`,
          'DeepSeek',
          'API_ERROR',
          errorData
        );
      }

      const data = (await response.json()) as DeepSeekResponse;
      const processingTime = Date.now() - startTime;

      if (!data.choices?.[0]?.message?.content) {
        throw new AIProviderError('No content in DeepSeek response', 'DeepSeek', 'NO_CONTENT');
      }

      let parsedContent: unknown;
      try {
        const content = data.choices[0].message.content;
        // DeepSeek might wrap JSON in markdown code blocks
        const jsonMatch =
          content.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || content.match(/(\{[\s\S]*\})/);

        if (jsonMatch?.[1]) {
          parsedContent = JSON.parse(jsonMatch[1]);
        } else {
          parsedContent = JSON.parse(content);
        }
      } catch (error) {
        throw new AIProviderError(
          'Failed to parse DeepSeek JSON response',
          'DeepSeek',
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
          provider: 'DeepSeek',
        },
      };
    } catch (error) {
      if (error instanceof AIProviderError) {
        throw error;
      }

      throw new AIProviderError(
        `DeepSeek request failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        'DeepSeek',
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
    return `You are a financial data extraction expert. Your task is to analyze portfolio screenshots and extract holding information as structured JSON data.

INSTRUCTIONS:
- Extract only clearly visible holdings/positions and cash or currency balances
- Use conservative confidence scores (0-1)
- Review all sections (tables, summaries, cash lists, currency selectors)
- Ignore unavailable, pending, or duplicated balances
- Return ONLY valid JSON in the specified format

ADDITIONAL GUIDANCE:
- MULTI-CURRENCY LISTS: Convert rows like "Indonesian Rupiah 7.324.280,51" or "USD 2,535.99" into holdings using the ISO code (IDR, USD) as the symbol. Keep the descriptive label as the name.
- CASH BALANCES: Include entries such as "CAD Cash" or "USD Cash" when they show non-zero amounts, using the currency code as the symbol.
- TABLE INTERPRETATION: For tables with columns such as Instrument/Symbol and Position/Quantity, use the ticker or instrument as the symbol and the numeric quantity or balance as the holding balance.
- NUMBER NORMALIZATION: Remove thousand separators and convert decimal commas to '.' (e.g., "7.324.280,51" -> "7324280.51").
- NOTES: Capture helpful context in the notes field when necessary (e.g., "From currency selector list").
- DETECTED CURRENCY: Provide a detectedCurrency value when a dominant valuation currency is obvious; otherwise omit it.

${options?.accountType ? `Account context: ${options.accountType}` : ''}
${options?.expectedCurrency ? `Primary currency: ${options.expectedCurrency}` : ''}
${options?.context ? `Additional info: ${options.context}` : ''}

JSON Response Format:
{
  "holdings": [
    {
      "symbol": "AAPL",
      "name": "Apple Inc.",
      "balance": "150.50",
      "confidence": 0.95,
      "notes": "Clear position visible"
    }
  ],
  "overallConfidence": 0.90,
  "context": "Screenshot description",
  "detectedCurrency": "USD"
}`;
  }

  private buildUserPrompt(_options?: {
    accountType?: string;
    expectedCurrency?: string;
    context?: string;
  }): string {
    return `Analyze the screenshot carefully and extract every visible holding, including currency balances and cash sections. Normalize numbers (remove thousand separators, convert decimal commas to '.') and return the exact JSON structure described in the system prompt with conservative confidence scores.`;
  }

  private validateAndNormalizePortfolio(data: unknown): ParsedPortfolio {
    if (!data || typeof data !== 'object') {
      throw new AIProviderError('Invalid portfolio data structure', 'DeepSeek', 'VALIDATION_ERROR');
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
