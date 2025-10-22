import { Container, Service } from "typedi";
import { AIProviderManager } from "../../infrastructure/external-services/ai/provider-manager";
import type {
  ParsedHolding,
  ParsedPortfolio,
} from "../../infrastructure/external-services/ai/types";
import { BaseService } from "./BaseService";
import { TokenValidationService } from "./TokenValidationService";

/**
 * Service for AI-powered screenshot parsing and portfolio extraction
 *
 * Orchestrates AI providers to extract holdings from financial app screenshots,
 * validates extracted tokens, and provides cleaned portfolio data.
 */
@Service()
export class AIService extends BaseService {
  private readonly aiProviderManager: AIProviderManager;
  private readonly tokenValidationService = Container.get(
    TokenValidationService
  );

  constructor() {
    super("AIService");

    // Initialize AI provider manager with configuration from environment
    this.aiProviderManager = new AIProviderManager({
      defaultProvider:
        (process.env.AI_DEFAULT_PROVIDER as
          | "openai"
          | "perplexity"
          | "deepseek") || "openai",
      providers: {
        openai: process.env.OPENAI_API_KEY
          ? {
              apiKey: process.env.OPENAI_API_KEY,
              model: process.env.OPENAI_VISION_MODEL || "gpt-4o",
            }
          : undefined,
        perplexity: process.env.PERPLEXITY_API_KEY
          ? {
              apiKey: process.env.PERPLEXITY_API_KEY,
              model:
                process.env.PERPLEXITY_VISION_MODEL ||
                "llama-3.2-90b-vision-instruct",
            }
          : undefined,
        deepseek: process.env.DEEPSEEK_API_KEY
          ? {
              apiKey: process.env.DEEPSEEK_API_KEY,
              model: process.env.DEEPSEEK_VISION_MODEL || "deepseek-vl",
            }
          : undefined,
      },
    });
  }

  /**
   * Parse a screenshot to extract portfolio holdings using AI
   *
   * @param imageBase64 - Base64 encoded image data
   * @param options - Parsing options
   * @returns Validated and cleaned portfolio data
   */
  async parseScreenshot(
    imageBase64: string,
    options?: {
      provider?: "openai" | "perplexity" | "deepseek";
      accountType?: string;
      expectedCurrency?: string;
      context?: string;
      minConfidence?: number;
    }
  ): Promise<ParsedPortfolio> {
    try {
      this.logInfo("Starting screenshot parsing", {
        provider: options?.provider || "default",
        accountType: options?.accountType,
        expectedCurrency: options?.expectedCurrency,
      });

      // Check if any AI provider is available
      if (!this.aiProviderManager.hasAvailableProvider()) {
        throw new Error(
          "No AI providers are configured. Please set up API keys for OpenAI, Perplexity, or DeepSeek."
        );
      }

      // Parse screenshot using AI provider manager
      const aiResponse = await this.aiProviderManager.parseScreenshot(
        imageBase64,
        {
          provider: options?.provider,
          accountType: options?.accountType,
          expectedCurrency: options?.expectedCurrency,
          context: options?.context,
          fallbackProviders: true, // Always try fallbacks
        }
      );

      this.logInfo("AI parsing completed", {
        holdingsCount: aiResponse.portfolio.holdings.length,
        overallConfidence: aiResponse.portfolio.overallConfidence,
        provider: aiResponse.metadata?.provider,
        processingTime: aiResponse.metadata?.processingTime,
      });

      // Validate and filter holdings
      const validatedPortfolio = await this.validateAndFilterPortfolio(
        aiResponse.portfolio,
        options?.minConfidence ?? 0.5
      );

      this.logInfo("Portfolio validation completed", {
        originalHoldings: aiResponse.portfolio.holdings.length,
        validatedHoldings: validatedPortfolio.holdings.length,
        filteredCount:
          aiResponse.portfolio.holdings.length -
          validatedPortfolio.holdings.length,
      });

      return validatedPortfolio;
    } catch (error) {
      throw this.handleError(error, "parseScreenshot");
    }
  }

  /**
   * Get information about available AI providers
   */
  getProviderStatus() {
    return {
      availableProviders: this.aiProviderManager.getAvailableProviders(),
      hasAvailableProvider: this.aiProviderManager.hasAvailableProvider(),
    };
  }

  /**
   * Validate and filter portfolio holdings
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
        // Filter by confidence
        if (holding.confidence < minConfidence) {
          this.logDebug("Filtering low confidence holding", {
            symbol: holding.symbol,
            confidence: holding.confidence,
            minConfidence,
          });
          return null;
        }

        // Validate token exists in our system
        try {
          const validationResult =
            await this.tokenValidationService.validateToken(holding.symbol);

          if (!validationResult.isValid) {
            this.logWarning("Token validation failed", {
              symbol: holding.symbol,
              error: validationResult.error,
            });
            return null;
          }

          // Update holding with validated token info
          return {
            ...holding,
            name: validationResult.metadata?.name || holding.name,
            symbol: validationResult.metadata?.symbol || holding.symbol,
          };
        } catch (error) {
          this.logWarning("Token validation error", {
            symbol: holding.symbol,
            error: error instanceof Error ? error.message : "Unknown error",
          });
          return null;
        }
      })
    );

    // Filter out null holdings and return cleaned portfolio
    const filteredHoldings = validatedHoldings.filter(
      (holding): holding is NonNullable<typeof holding> => holding !== null
    );

    return {
      ...portfolio,
      holdings: filteredHoldings,
      overallConfidence:
        filteredHoldings.length > 0 ? portfolio.overallConfidence : 0,
    };
  }
}
