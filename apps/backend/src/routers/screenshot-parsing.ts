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

const CreateHoldingsFromParsingSchema = z.object({
  /** Account ID */
  accountId: z.string().uuid('Invalid account ID'),
  /** Holdings to create from parsing results */
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
    })
  ),
  /** Options for creation */
  options: z
    .object({
      createMissingTokens: z.boolean().default(true),
      skipValidation: z.boolean().default(false),
    })
    .optional(),
});

const UpdateHoldingsFromParsingSchema = z.object({
  /** Account ID */
  accountId: z.string().uuid('Invalid account ID'),
  /** Holdings to update from parsing results */
  holdings: z.array(
    z.object({
      symbol: z.string().min(1, 'Symbol is required'),
      name: z.string().optional(),
      balance: z.string().min(1, 'Balance is required'),
      confidence: z.number().min(0).max(1),
      notes: z.string().optional(),
      tokenId: z.string().uuid('Token ID is required for updates'),
      tokenExists: z.boolean(),
    })
  ),
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

  // Create holdings from parsing results
  createHoldingsFromParsing: protectedProcedure
    .input(CreateHoldingsFromParsingSchema)
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      const parsingService = new ScreenshotParsingService();

      // Validate account belongs to user (will throw if not found)
      // This is done inside the service method

      try {
        // Map input holdings to the expected type
        const mappedHoldings = input.holdings.map((h) => ({
          ...h,
          errors: [] as string[],
          warnings: [] as string[],
        }));

        const result = await parsingService.createHoldingsFromParsing(
          userId,
          input.accountId,
          mappedHoldings,
          input.options
        );

        return {
          success: true,
          data: {
            created: result.created,
            errors: result.errors,
            summary: {
              totalProcessed: input.holdings.length,
              successfullyCreated: result.created.length,
              errors: result.errors.length,
            },
          },
        };
      } catch (error) {
        console.error('Holdings creation failed:', error);

        return {
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error occurred',
        };
      }
    }),

  // Update holdings from parsing results
  updateHoldingsFromParsing: protectedProcedure
    .input(UpdateHoldingsFromParsingSchema)
    .mutation(async ({ input, ctx }) => {
      const userId = getUserId(ctx);
      const parsingService = new ScreenshotParsingService();

      try {
        // Map input holdings to the expected type
        const mappedHoldings = input.holdings.map((h) => ({
          ...h,
          errors: [] as string[],
          warnings: [] as string[],
        }));

        const result = await parsingService.updateHoldingsFromParsing(
          userId,
          input.accountId,
          mappedHoldings
        );

        return {
          success: true,
          data: {
            updated: result.updated,
            errors: result.errors,
            summary: {
              totalProcessed: input.holdings.length,
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
        console.error('Holdings update failed:', error);

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
          errors: [] as string[],
          warnings: [] as string[],
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

  // Get available AI providers
  getAvailableProviders: protectedProcedure.query(async () => {
    const parsingService = new ScreenshotParsingService();

    return {
      available: parsingService.isAvailable(),
      providers: parsingService.getAvailableProviders(),
    };
  }),

  // Health check for screenshot parsing
  checkHealth: protectedProcedure.query(async () => {
    const parsingService = new ScreenshotParsingService();
    const providers = parsingService.getAvailableProviders();

    return {
      healthy: parsingService.isAvailable(),
      providers: providers.map((p) => ({
        name: p.name,
        configured: p.configured,
        isDefault: p.isDefault,
      })),
      recommendedProvider:
        providers.find((p) => p.configured && p.isDefault)?.name ||
        providers.find((p) => p.configured)?.name ||
        null,
    };
  }),
});
