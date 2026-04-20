export interface ParsedHolding {
  /** Token symbol (e.g., 'AAPL', 'BTC', 'USD') */
  symbol: string;
  /** Token name if identifiable (e.g., 'Apple Inc.', 'Bitcoin') */
  name?: string;
  /** Balance amount as string for Decimal.js precision */
  balance: string;
  /** Confidence level 0-1 for this extraction */
  confidence: number;
  /** Additional notes or context from the AI */
  notes?: string;
}

export interface ParsedPortfolio {
  /** List of holdings found in the screenshot */
  holdings: ParsedHolding[];
  /** Overall confidence in the parsing results */
  overallConfidence: number;
  /** General context or notes about the screenshot */
  context?: string;
  /** Currency detected as primary in the screenshot */
  detectedCurrency?: string;
}

export interface AIProviderConfig {
  /** Provider name */
  name: string;
  /** API key for the provider */
  apiKey: string;
  /** Base URL for API calls */
  baseUrl: string;
  /** Model to use for vision tasks */
  visionModel: string;
  /** Maximum tokens for responses */
  maxTokens?: number;
  /** Temperature setting for creativity */
  temperature?: number;
}

export interface AIProviderResponse {
  /** Parsed portfolio data */
  portfolio: ParsedPortfolio;
  /** Provider-specific metadata */
  metadata?: {
    model: string;
    tokensUsed?: number;
    processingTime?: number;
    [key: string]: unknown;
  };
}

// Raw API response structures for type safety
export interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage?: {
    total_tokens?: number;
  };
}

export interface DeepSeekResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage?: {
    total_tokens?: number;
  };
}

export interface PerplexityResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage?: {
    total_tokens?: number;
  };
}

// Raw holding data before validation
export interface RawHolding {
  symbol?: unknown;
  name?: unknown;
  balance?: unknown;
  confidence?: unknown;
  notes?: unknown;
  [key: string]: unknown;
}

export abstract class AIProvider {
  protected config: AIProviderConfig;

  constructor(config: AIProviderConfig) {
    this.config = config;
  }

  /**
   * Parse a screenshot to extract portfolio holdings
   * @param imageBase64 - Base64 encoded image data
   * @param options - Additional parsing options
   */
  abstract parseScreenshot(
    imageBase64: string,
    options?: {
      accountType?: string;
      expectedCurrency?: string;
      context?: string;
      /** MIME type for the data (default: image/jpeg). Use application/pdf for PDF files. */
      mimeType?: string;
    }
  ): Promise<AIProviderResponse>;

  /**
   * Parse a plain-text document (e.g. PDF text extracted with pdf-parse)
   * to extract portfolio holdings.
   *
   * Default implementation returns `null` — not every provider supports
   * text-only extraction; the manager will skip providers that return
   * `null` and try the next one. Override on providers that can handle
   * text-only chat completions with a JSON response_format.
   */
  async parseDocumentText(
    _text: string,
    _options?: {
      accountType?: string;
      expectedCurrency?: string;
      context?: string;
    }
  ): Promise<AIProviderResponse | null> {
    return null;
  }

  /**
   * Check if the provider is properly configured
   */
  abstract isConfigured(): boolean;

  /**
   * Get provider-specific information
   */
  getProviderInfo() {
    return {
      name: this.config.name,
      model: this.config.visionModel,
      configured: this.isConfigured(),
    };
  }
}

export class AIProviderError extends Error {
  constructor(
    message: string,
    public provider: string,
    public code?: string,
    public details?: unknown
  ) {
    super(message);
    this.name = 'AIProviderError';
  }
}
