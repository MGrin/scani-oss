import { Container, Service } from 'typedi';
import { BaseService } from '../BaseService';
import { TokenValidationService } from '../tokens/TokenValidationService';
import { AIRouter, type ParsedHolding, type ParsedPortfolio } from './AIRouter';

// AI-driven screenshot → portfolio extraction. Image → LLM →
// validate-each-holding → confidence filter.
@Service()
export class ScreenshotParsingService extends BaseService {
  private readonly aiRouter = Container.get(AIRouter);
  private readonly tokenValidationService = Container.get(TokenValidationService);

  constructor() {
    super('ScreenshotParsingService');
  }

  /**
   * Parse a screenshot to extract portfolio holdings using AI.
   *
   * @param imageBase64 - Base64 encoded image data
   * @param options - Parsing options
   * @returns Validated and cleaned portfolio data
   */
  async parseScreenshot(
    imageBase64: string,
    options?: {
      provider?: 'openai';
      accountType?: string;
      expectedCurrency?: string;
      context?: string;
      minConfidence?: number;
      mimeType?: string;
    }
  ): Promise<ParsedPortfolio> {
    try {
      this.logInfo('Starting screenshot parsing', {
        provider: options?.provider || 'default',
        accountType: options?.accountType,
        expectedCurrency: options?.expectedCurrency,
        mimeType: options?.mimeType,
      });

      if (!this.aiRouter.hasAvailableProvider()) {
        throw new Error(
          'No AI providers are configured. Please set up API keys for OpenAI, Perplexity, or DeepSeek.'
        );
      }

      const aiResponse = await this.aiRouter.parseScreenshot(imageBase64, {
        provider: options?.provider,
        accountType: options?.accountType,
        expectedCurrency: options?.expectedCurrency,
        context: options?.context,
        mimeType: options?.mimeType,
        fallbackProviders: true,
      });

      this.logInfo('AI parsing completed', {
        holdingsCount: aiResponse.portfolio.holdings.length,
        overallConfidence: aiResponse.portfolio.overallConfidence,
        provider: aiResponse.metadata?.provider,
        processingTime: aiResponse.metadata?.processingTime,
      });

      const validatedPortfolio = await this.validateAndFilterPortfolio(
        aiResponse.portfolio,
        options?.minConfidence ?? 0.5
      );

      this.logInfo('Portfolio validation completed', {
        originalHoldings: aiResponse.portfolio.holdings.length,
        validatedHoldings: validatedPortfolio.holdings.length,
        filteredCount: aiResponse.portfolio.holdings.length - validatedPortfolio.holdings.length,
      });

      return validatedPortfolio;
    } catch (error) {
      throw this.handleError(error, 'parseScreenshot');
    }
  }

  /**
   * Plain-text variant for PDFs (text extracted upstream with pdf-parse).
   * Goes through the same validation/filter pipeline as `parseScreenshot`
   * so the downstream enrichment code path is identical.
   */
  async parseDocumentText(
    text: string,
    options?: {
      provider?: 'openai';
      accountType?: string;
      expectedCurrency?: string;
      context?: string;
      minConfidence?: number;
    }
  ): Promise<ParsedPortfolio> {
    try {
      this.logInfo('Starting document-text parsing', {
        provider: options?.provider || 'default',
        accountType: options?.accountType,
        expectedCurrency: options?.expectedCurrency,
        textLength: text.length,
      });

      if (!this.aiRouter.hasAvailableProvider()) {
        throw new Error(
          'No AI providers are configured. Please set up API keys for OpenAI, Perplexity, or DeepSeek.'
        );
      }

      const aiResponse = await this.aiRouter.parseDocumentText(text, {
        provider: options?.provider,
        accountType: options?.accountType,
        expectedCurrency: options?.expectedCurrency,
        context: options?.context,
      });

      const validatedPortfolio = await this.validateAndFilterPortfolio(
        aiResponse.portfolio,
        options?.minConfidence ?? 0.5
      );

      return validatedPortfolio;
    } catch (error) {
      throw this.handleError(error, 'parseDocumentText');
    }
  }

  /**
   * Validate and filter portfolio holdings.
   *
   * @param portfolio - Raw portfolio from AI parsing
   * @param minConfidence - Minimum confidence threshold
   * @returns Filtered and validated portfolio
   */
  private async validateAndFilterPortfolio(
    portfolio: ParsedPortfolio,
    minConfidence: number
  ): Promise<ParsedPortfolio> {
    const validatedHoldings = await Promise.all(
      portfolio.holdings.map(async (holding: ParsedHolding) => {
        if (holding.confidence < minConfidence) {
          this.logDebug('Filtering low confidence holding', {
            symbol: holding.symbol,
            confidence: holding.confidence,
            minConfidence,
          });
          return null;
        }

        try {
          const validationResult = await this.tokenValidationService.validateToken(holding.symbol);
          if (!validationResult.isValid) {
            this.logInfo('Token validation failed - returning holding for user decision', {
              symbol: holding.symbol,
              error: validationResult.error,
            });
            return holding;
          }
          return {
            ...holding,
            name: validationResult.metadata?.name || holding.name,
            symbol: validationResult.metadata?.symbol || holding.symbol,
          };
        } catch (error) {
          this.logWarning('Token validation error - returning holding for user decision', {
            symbol: holding.symbol,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
          return holding;
        }
      })
    );

    const filteredHoldings = validatedHoldings.filter(
      (holding): holding is NonNullable<typeof holding> => holding !== null
    );

    return {
      ...portfolio,
      holdings: filteredHoldings,
      overallConfidence: filteredHoldings.length > 0 ? portfolio.overallConfidence : 0,
    };
  }
}
