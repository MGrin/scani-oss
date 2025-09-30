import { normalizeSymbol, normText, ProviderValidationInputSchema } from '@scani/shared';
import { z } from 'zod';
import { getUserId } from '../middleware/auth';
import { ScreenshotParsingService } from '../services/screenshot-parsing';
import { protectedProcedure, router } from '../trpc';
import { createComponentLogger } from '../utils/logger';

const screenshotParsingLogger = createComponentLogger('router:screenshot-parsing');

// Normalization and provider validation schemas are imported from shared

// Zod schemas with payload/size limits
const ParseScreenshotSchema = z.object({
  // Base64 image (no data: prefix); cap at ~10MB
  imageBase64: z.string().min(1).max(10_000_000),
  accountId: z.string().uuid('Invalid account ID'),
  expectedCurrency: z.string().max(10).optional(),
  context: z.string().max(2000).optional(),
});

const ProcessHoldingsFromParsingSchema = z.object({
  accountId: z.string().uuid('Invalid account ID'),
  holdings: z
    .array(
      z.object({
        symbol: z.string().min(1).max(40),
        name: z.string().max(100).optional(),
        balance: z.string().min(1).max(64),
        confidence: z.number().min(0).max(1),
        notes: z.string().max(1000).optional(),
        tokenId: z.string().uuid().optional(),
        tokenExists: z.boolean(),
        suggestedTokenType: z.string().max(40).optional(),
        errors: z.array(z.string().max(200)).max(50).optional(),
        warnings: z.array(z.string().max(200)).max(50).optional(),
        requiresUserSelection: z.boolean().optional(),
        providerValidation: ProviderValidationInputSchema.optional(),
      })
    )
    .max(200),
  options: z
    .object({
      createMissingTokens: z.boolean().default(true),
      skipValidation: z.boolean().default(false),
    })
    .optional(),
});

export const screenshotParsingRouter = router({
  // Parse screenshot to structured holdings using configured AI provider(s)
  parseScreenshot: protectedProcedure
    .input(ParseScreenshotSchema)
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      const parsingService = new ScreenshotParsingService();

      if (!parsingService.isAvailable()) {
        throw new Error('Screenshot parsing is not available - no AI providers configured');
      }

      // Light normalization of context fields
      const normalizedContext = normText(input.context, 2000);
      const expectedCurrency = normText(input.expectedCurrency, 10);

      try {
        const result = await parsingService.parseScreenshot(input.imageBase64, userId, {
          accountId: input.accountId,
          expectedCurrency: expectedCurrency,
          context: normalizedContext,
        });
        return { success: true, data: result };
      } catch (error) {
        screenshotParsingLogger.error(
          {
            userId,
            accountId: input.accountId,
            error: error instanceof Error ? { name: error.name, message: error.message } : error,
          },
          'Screenshot parsing failed'
        );
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error occurred',
        };
      }
    }),

  // Persist parsed holdings (create/update) with optional provider validations
  processHoldingsFromParsing: protectedProcedure
    .input(ProcessHoldingsFromParsingSchema)
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      const parsingService = new ScreenshotParsingService();

      try {
        // Normalize holdings defensively to reduce variance upstream
        const mappedHoldings = input.holdings.map((h) => ({
          ...h,
          symbol: normalizeSymbol(h.symbol),
          name: normText(h.name, 100),
          balance: h.balance.trim(),
          notes: normText(h.notes, 1000),
          errors: h.errors?.map((e) => normText(e, 200) || '').filter(Boolean) ?? [],
          warnings: h.warnings?.map((w) => normText(w, 200) || '').filter(Boolean) ?? [],
          requiresUserSelection: Boolean(h.requiresUserSelection),
          providerValidation: h.providerValidation
            ? {
                exactMatch: h.providerValidation.exactMatch
                  ? {
                      isValid: h.providerValidation.exactMatch.isValid,
                      metadata: h.providerValidation.exactMatch.metadata
                        ? {
                            symbol: normalizeSymbol(
                              h.providerValidation.exactMatch.metadata.symbol
                            ),
                            name:
                              normText(h.providerValidation.exactMatch.metadata.name, 100) || '',
                            type: h.providerValidation.exactMatch.metadata.type,
                            currency:
                              normText(h.providerValidation.exactMatch.metadata.currency, 10) ||
                              'USD',
                            exchange: normText(
                              h.providerValidation.exactMatch.metadata.exchange,
                              40
                            ),
                            description: normText(
                              h.providerValidation.exactMatch.metadata.description,
                              200
                            ),
                            provider: (h.providerValidation.exactMatch.metadata.provider ===
                            'coingecko'
                              ? 'coingecko'
                              : 'finnhub') as 'finnhub' | 'coingecko',
                            providerMetadata:
                              h.providerValidation.exactMatch.metadata.providerMetadata || {},
                          }
                        : undefined,
                      error: h.providerValidation.exactMatch.error,
                    }
                  : undefined,
                similarMatches: h.providerValidation.similarMatches?.slice(0, 50).map((sm) => ({
                  isValid: sm.isValid,
                  metadata: sm.metadata
                    ? {
                        symbol: normalizeSymbol(sm.metadata.symbol),
                        name: normText(sm.metadata.name, 100) || '',
                        type: sm.metadata.type,
                        currency: normText(sm.metadata.currency, 10) || 'USD',
                        exchange: normText(sm.metadata.exchange, 40),
                        description: normText(sm.metadata.description, 200),
                        provider: (sm.metadata.provider === 'coingecko'
                          ? 'coingecko'
                          : 'finnhub') as 'finnhub' | 'coingecko',
                        providerMetadata: sm.metadata.providerMetadata || {},
                      }
                    : undefined,
                  error: sm.error,
                })),
                noMatches: Boolean(h.providerValidation.noMatches),
              }
            : undefined,
        }));

        const result = await parsingService.processHoldingsFromParsing(
          userId,
          input.accountId,
          mappedHoldings,
          input.options
        );

        // Provide a compact summary for the client
        const summary = {
          totalProcessed: input.holdings.length,
          successfullyCreated: result.created.length,
          successfullyUpdated: result.updated.length,
          errors: result.errors.length,
        };

        return { success: true, data: { ...result, summary } };
      } catch (error) {
        screenshotParsingLogger.error(
          {
            userId,
            accountId: input.accountId,
            error: error instanceof Error ? { name: error.name, message: error.message } : error,
          },
          'Holdings processing failed'
        );
        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error occurred',
        };
      }
    }),
});
