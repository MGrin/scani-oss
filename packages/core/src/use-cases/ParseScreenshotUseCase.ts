import Container, { Service } from 'typedi';
import { AIService } from '../services/AIService';
import { createComponentLogger } from '../utils/logger';
import type { EnrichedParsedHolding } from './EnrichHoldingsUseCase';
import { EnrichHoldingsUseCase } from './EnrichHoldingsUseCase';

const logger = createComponentLogger('use-case:parse-screenshot');

export type { EnrichedParsedHolding };

export interface ParseScreenshotInput {
  imageBase64: string;
  mimeType?: string;
  provider?: 'openai' | 'perplexity' | 'deepseek';
  accountType?: string;
  expectedCurrency?: string;
  context?: string;
  minConfidence?: number;
  accountId?: string;
  userId: string;
}

export interface ParseScreenshotResult {
  holdings: EnrichedParsedHolding[];
  overallConfidence: number;
  context?: string;
  detectedCurrency?: string;
}

/**
 * Use case for parsing screenshots and enriching holdings with database token IDs
 */
@Service()
export class ParseScreenshotUseCase {
  private readonly aiService = Container.get(AIService);
  private readonly enrichHoldingsUseCase = Container.get(EnrichHoldingsUseCase);

  async execute(input: ParseScreenshotInput): Promise<ParseScreenshotResult> {
    logger.info(
      {
        provider: input.provider,
        accountType: input.accountType,
        expectedCurrency: input.expectedCurrency,
        accountId: input.accountId,
        userId: input.userId,
      },
      'Starting screenshot parsing and token enrichment'
    );

    // Parse screenshot using AI service
    const portfolio = await this.aiService.parseScreenshot(input.imageBase64, {
      provider: input.provider,
      accountType: input.accountType,
      expectedCurrency: input.expectedCurrency,
      context: input.context,
      minConfidence: input.minConfidence,
      mimeType: input.mimeType,
    });

    logger.info(
      {
        holdingsCount: portfolio.holdings.length,
        overallConfidence: portfolio.overallConfidence,
      },
      'AI parsing completed, enriching with token and holding data'
    );

    // Enrich holdings with token IDs and existing holding IDs
    const enrichedHoldings = await this.enrichHoldingsUseCase.execute({
      holdings: portfolio.holdings,
      accountId: input.accountId,
      userId: input.userId,
    });

    const result: ParseScreenshotResult = {
      holdings: enrichedHoldings,
      overallConfidence: portfolio.overallConfidence,
      context: portfolio.context,
      detectedCurrency: portfolio.detectedCurrency,
    };

    logger.info(
      {
        enrichedHoldingsCount: enrichedHoldings.length,
        holdingsWithTokenId: enrichedHoldings.filter((h) => h.tokenId).length,
        holdingsWithHoldingId: enrichedHoldings.filter((h) => h.holdingId).length,
      },
      'Screenshot parsing and enrichment completed'
    );

    return result;
  }
}
