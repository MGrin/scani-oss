import { z } from 'zod';
import { getUserId } from '../middleware/auth';
import { ScreenshotParsingService } from '../services/screenshot-parsing';
import { protectedProcedure, router } from '../trpc';

// Zod schemas for validation
const ParseScreenshotSchema = z.object({
  /** Base64 encoded image data (without data: prefix) */
  imageBase64: z.string().min(1, 'Image data is required'),
  /** Account ID where holdings will be created/updated */
  accountId: z.string().uuid('Invalid account ID'),
  /** Expected currency in the screenshot */
  expectedCurrency: z.string().optional(),
  /** Additional context for AI parsing */
  context: z.string().optional(),
});

const ProcessHoldingsFromParsingSchema = z.object({
  /** Account ID */
  accountId: z.string().uuid('Invalid account ID'),
  /** Holdings to process from parsing results */
  holdings: z.array(
    z.object({
      symbol: z.string().min(1, 'Symbol is required'),
      name: z.string().optional(),
      balance: z.string().min(1, 'Balance is required'),
      confidence: z.number().min(0).max(1),
      notes: z.string().optional(),
      tokenId: z.string().uuid().optional(),
      tokenExists: z.boolean(),
      suggestedTokenType: z.string().optional(),
      errors: z.array(z.string()).optional(),
      warnings: z.array(z.string()).optional(),
      requiresUserSelection: z.boolean().optional(),
      providerValidation: z
        .object({
          exactMatch: z
            .object({
              isValid: z.boolean(),
              metadata: z
                .object({
                  symbol: z.string(),
                  name: z.string(),
                  type: z.string().optional(),
                  provider: z.string(),
                  currency: z.string().optional(),
                  exchange: z.string().optional(),
                  description: z.string().optional(),
                  providerMetadata: z.record(z.unknown()).optional(),
                })
                .optional(),
            })
            .optional(),
          similarMatches: z
            .array(
              z.object({
                isValid: z.boolean(),
                metadata: z
                  .object({
                    symbol: z.string(),
                    name: z.string(),
                    type: z.string().optional(),
                    provider: z.string(),
                    currency: z.string().optional(),
                    exchange: z.string().optional(),
                    description: z.string().optional(),
                    providerMetadata: z.record(z.unknown()).optional(),
                  })
                  .optional(),
              })
            )
            .optional(),
          noMatches: z.boolean().optional(),
        })
        .optional(),
    })
  ),
  /** Options for processing */
  options: z
    .object({
      createMissingTokens: z.boolean().default(true),
      skipValidation: z.boolean().default(false),
    })
    .optional(),
});

export const screenshotParsingRouter = router({
  // Parse screenshot and return structured data
  parseScreenshot: protectedProcedure
    .input(ParseScreenshotSchema)
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      const parsingService = new ScreenshotParsingService();

      // Check if service is available
      if (!parsingService.isAvailable()) {
        throw new Error('Screenshot parsing is not available - no AI providers configured');
      }

      try {
        const result = await parsingService.parseScreenshot(input.imageBase64, userId, {
          accountId: input.accountId,
          expectedCurrency: input.expectedCurrency,
          context: input.context,
        });

        return {
          success: true,
          data: result,
        };
      } catch (error) {
        console.error('Screenshot parsing failed:', error);

        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error occurred',
        };
      }
    }),

  // Process holdings from parsing results - automatically determines create vs update
  processHoldingsFromParsing: protectedProcedure
    .input(ProcessHoldingsFromParsingSchema)
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      const parsingService = new ScreenshotParsingService();

      try {
        // Map input holdings to the expected type
        const mappedHoldings = input.holdings.map((h) => ({
          ...h,
          errors: h.errors || [],
          warnings: h.warnings || [],
          requiresUserSelection: h.requiresUserSelection || false,
          providerValidation: h.providerValidation
            ? {
                exactMatch: h.providerValidation.exactMatch
                  ? {
                      isValid: h.providerValidation.exactMatch.isValid,
                      metadata: h.providerValidation.exactMatch.metadata
                        ? {
                            symbol: h.providerValidation.exactMatch.metadata.symbol,
                            name: h.providerValidation.exactMatch.metadata.name,
                            type: (h.providerValidation.exactMatch.metadata.type || 'Equity') as
                              | 'Equity'
                              | 'ETF'
                              | 'Mutual Fund'
                              | 'Bond'
                              | 'Commodity'
                              | 'Crypto',
                            currency: h.providerValidation.exactMatch.metadata.currency || 'USD',
                            exchange: h.providerValidation.exactMatch.metadata.exchange,
                            description: h.providerValidation.exactMatch.metadata.description,
                            provider: h.providerValidation.exactMatch.metadata.provider as
                              | 'finnhub'
                              | 'coingecko',
                            providerMetadata:
                              h.providerValidation.exactMatch.metadata.providerMetadata || {},
                          }
                        : undefined,
                    }
                  : undefined,
                similarMatches: h.providerValidation.similarMatches?.map((sm) => ({
                  isValid: sm.isValid,
                  metadata: sm.metadata
                    ? {
                        symbol: sm.metadata.symbol,
                        name: sm.metadata.name,
                        type: (sm.metadata.type || 'Equity') as
                          | 'Equity'
                          | 'ETF'
                          | 'Mutual Fund'
                          | 'Bond'
                          | 'Commodity'
                          | 'Crypto',
                        currency: sm.metadata.currency || 'USD',
                        exchange: sm.metadata.exchange,
                        description: sm.metadata.description,
                        provider: sm.metadata.provider as 'finnhub' | 'coingecko',
                        providerMetadata: sm.metadata.providerMetadata || {},
                      }
                    : undefined,
                })),
                noMatches: h.providerValidation.noMatches,
              }
            : undefined,
        }));

        const result = await parsingService.processHoldingsFromParsing(
          userId,
          input.accountId,
          mappedHoldings,
          input.options
        );

        return {
          success: true,
          data: {
            created: result.created,
            updated: result.updated,
            errors: result.errors,
            summary: {
              totalProcessed: input.holdings.length,
              successfullyCreated: result.created.length,
              successfullyUpdated: result.updated.length,
              errors: result.errors.length,
              totalChange: result.updated.reduce((sum, u) => {
                const change = parseFloat(u.change || '0');
                return sum + Math.abs(change);
              }, 0),
            },
          },
        };
      } catch (error) {
        console.error('Holdings processing failed:', error);

        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error occurred',
        };
      }
    }),
});
