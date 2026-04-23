import { AIProviderManager, type AIProviderType } from '@scani/ai-providers';
import { createComponentLogger } from '@scani/logging';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { bearerProcedure, router } from '../trpc';

/**
 * AI router — owns every outbound call to OpenAI / Perplexity / DeepSeek.
 *
 * Shape mirrors `AIProviderManager`'s public surface so the backend-side
 * `CloudAIProviderManager` adapter can route calls 1:1 without juggling
 * parameter shapes.
 */

const log = createComponentLogger('data-provider:ai');

// Lazily built so boot never fails because one AI provider key is absent
// (the OSS install with no OPENAI_API_KEY still needs the rest of the
// data-provider surface up). The first call to `getManager()` either
// succeeds or throws a descriptive error that bubbles through tRPC.
let cachedManager: AIProviderManager | null = null;

function getManager(): AIProviderManager {
  if (cachedManager) return cachedManager;
  const defaultProvider =
    (process.env.AI_DEFAULT_PROVIDER as AIProviderType | undefined) || 'openai';
  cachedManager = new AIProviderManager({
    defaultProvider,
    providers: {
      openai: process.env.OPENAI_API_KEY
        ? {
            apiKey: process.env.OPENAI_API_KEY,
            model: process.env.OPENAI_VISION_MODEL || 'gpt-4o',
          }
        : undefined,
      perplexity: process.env.PERPLEXITY_API_KEY
        ? {
            apiKey: process.env.PERPLEXITY_API_KEY,
            model: process.env.PERPLEXITY_VISION_MODEL || 'llama-3.2-90b-vision-instruct',
          }
        : undefined,
      deepseek: process.env.DEEPSEEK_API_KEY
        ? {
            apiKey: process.env.DEEPSEEK_API_KEY,
            model: process.env.DEEPSEEK_VISION_MODEL || 'deepseek-vl',
          }
        : undefined,
    },
  });
  if (!cachedManager.hasAvailableProvider()) {
    log.warn({}, 'AI router booted with no configured providers (OSS dev install?)');
  }
  return cachedManager;
}

const providerSchema = z.enum(['openai', 'perplexity', 'deepseek']).optional();

export const aiRouter = router({
  parseScreenshot: bearerProcedure
    .input(
      z.object({
        imageBase64: z.string(),
        options: z
          .object({
            provider: providerSchema,
            accountType: z.string().optional(),
            expectedCurrency: z.string().optional(),
            context: z.string().optional(),
            mimeType: z.string().optional(),
            fallbackProviders: z.boolean().optional(),
          })
          .optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        return await getManager().parseScreenshot(input.imageBase64, input.options);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  parseDocumentText: bearerProcedure
    .input(
      z.object({
        text: z.string(),
        options: z
          .object({
            provider: providerSchema,
            accountType: z.string().optional(),
            expectedCurrency: z.string().optional(),
            context: z.string().optional(),
          })
          .optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        return await getManager().parseDocumentText(input.text, input.options);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  completeText: bearerProcedure
    .input(
      z.object({
        prompt: z.string(),
        options: z
          .object({
            provider: providerSchema,
            maxTokens: z.number().optional(),
            temperature: z.number().optional(),
            jsonMode: z.boolean().optional(),
            fallbackProviders: z.boolean().optional(),
          })
          .optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        return await getManager().completeText(input.prompt, input.options);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  status: bearerProcedure.query(() => {
    const m = getManager();
    return {
      availableProviders: m.getAvailableProviders(),
      hasAvailableProvider: m.hasAvailableProvider(),
    };
  }),
});
