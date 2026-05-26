import { createComponentLogger } from '@scani/logging';
import type { AIInferenceProvider, AIUsage } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { loadEnv } from '../../config/env';
import type { UsageContext } from '../../usage/middleware';
import { bearerProcedure, router } from '../trpc';

/**
 * Forward token usage + computed upstream cost from the AI provider into
 * the per-request `cloud_usage_events` row via the usage middleware.
 * No-op when the provider didn't report usage (older endpoints / errors).
 */
function annotateUsage(
  ctx: { usage: UsageContext },
  providerKey: string,
  usage: AIUsage | undefined
): void {
  if (!usage) {
    ctx.usage.annotate({ provider: providerKey });
    return;
  }
  ctx.usage.annotate({
    provider: providerKey,
    tokensIn: usage.tokensIn,
    tokensOut: usage.tokensOut,
    upstreamCostUsd: usage.upstreamCostUsd,
  });
}

/**
 * AI router — owns every outbound call to OpenAI / Perplexity /
 * DeepSeek.
 *
 * Dispatch goes through the in-process `ProviderRegistry`. The boot
 * wiring in `apps/data-provider/src/index.ts` registers
 * `aiOpenAIFactory`, `aiPerplexityFactory`, `aiDeepseekFactory` via
 * `buildProviderRegistry({ mode: 'direct', ... })`, so the registry
 * holds whichever providers have credentials configured.
 *
 * This file no longer constructs any provider directly; the
 * tRPC procedures iterate `getAIProviders()` as a fallback chain.
 */

const log = createComponentLogger('data-provider:ai');

function getProviders(): readonly AIInferenceProvider[] {
  try {
    return Container.get(ProviderRegistry).getAIProviders();
  } catch {
    return [];
  }
}

function selectProviders(forceProvider?: string): readonly AIInferenceProvider[] {
  const all = getProviders();
  if (!forceProvider) return all;
  const found = all.find((p) => p.providerKey === forceProvider);
  return found ? [found] : [];
}

function buildHint(opts: {
  accountType?: string;
  expectedCurrency?: string;
  context?: string;
}): string | undefined {
  const lines: string[] = [];
  if (opts.accountType) lines.push(`Account type: ${opts.accountType}`);
  if (opts.expectedCurrency) lines.push(`Expected currency: ${opts.expectedCurrency}`);
  if (opts.context) lines.push(`Context: ${opts.context}`);
  return lines.length > 0 ? lines.join('\n') : undefined;
}

interface ParsedHolding {
  symbol: string;
  name?: string;
  balance: string;
  confidence: number;
  notes?: string;
}
interface ParsedPortfolio {
  holdings: ParsedHolding[];
  overallConfidence: number;
  context?: string;
  detectedCurrency?: string;
}

/**
 * Coerce an arbitrary AI response into a `ParsedPortfolio`. Same
 * defensive normalization as the domain-side `AIRouter.normalizePortfolio`
 * — half-good responses still surface what they can.
 */
function normalizePortfolio(raw: unknown): ParsedPortfolio {
  if (!raw || typeof raw !== 'object') {
    return { holdings: [], overallConfidence: 0 };
  }
  const obj = raw as Record<string, unknown>;
  const holdings: ParsedHolding[] = [];
  const rawHoldings = Array.isArray(obj.holdings) ? obj.holdings : [];
  for (const h of rawHoldings) {
    if (!h || typeof h !== 'object') continue;
    const hh = h as Record<string, unknown>;
    const symbol = typeof hh.symbol === 'string' ? hh.symbol : '';
    const balance = typeof hh.balance === 'string' ? hh.balance : String(hh.balance ?? '0');
    if (!symbol) continue;
    holdings.push({
      symbol,
      name: typeof hh.name === 'string' ? hh.name : undefined,
      balance,
      confidence:
        typeof hh.confidence === 'number'
          ? hh.confidence
          : typeof hh.confidence === 'string'
            ? Number.parseFloat(hh.confidence) || 0
            : 0.5,
      notes: typeof hh.notes === 'string' ? hh.notes : undefined,
    });
  }
  return {
    holdings,
    overallConfidence:
      typeof obj.overallConfidence === 'number'
        ? obj.overallConfidence
        : holdings.length > 0
          ? 0.7
          : 0,
    context: typeof obj.context === 'string' ? obj.context : undefined,
    detectedCurrency: typeof obj.detectedCurrency === 'string' ? obj.detectedCurrency : undefined,
  };
}

const providerSchema = z.string().optional();

export const aiRouter = router({
  parseScreenshot: bearerProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/trpc/ai.parseScreenshot',
        tags: ['ai'],
        summary: 'Parse a base64-encoded screenshot into a portfolio shape',
        protect: true,
      },
    })
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
    .output(z.unknown())
    .mutation(async ({ input, ctx }) => {
      // Test-only stub. Returns a fixed holdings payload so e2e tests don't
      // depend on the real AI provider (cost, flakiness, network). The env
      // var is refused in production by the schema in config/env.ts.
      if (loadEnv().STUB_AI === '1') {
        return {
          portfolio: {
            holdings: [
              { symbol: 'BTC', name: 'Bitcoin', balance: '0.5', confidence: 0.95 },
              { symbol: 'ETH', name: 'Ethereum', balance: '10', confidence: 0.92 },
              { symbol: 'USD', name: 'US Dollar', balance: '5000', confidence: 1.0 },
            ],
            overallConfidence: 0.94,
            context: 'stub',
            detectedCurrency: 'USD',
          },
          metadata: {
            provider: 'stub',
            processingTime: 0,
          },
        };
      }
      const opts = input.options ?? {};
      const providers = selectProviders(opts.provider);
      if (providers.length === 0) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'No AI providers available',
        });
      }
      const hint = buildHint(opts);
      const mimeType = opts.mimeType ?? 'image/jpeg';
      let lastError: Error | null = null;
      for (const provider of providers) {
        const start = Date.now();
        try {
          const result = await provider.parseScreenshot({
            imageBase64: input.imageBase64,
            mimeType,
            hint,
          });
          annotateUsage(ctx, provider.providerKey, result.usage);
          return {
            portfolio: normalizePortfolio(result.data),
            metadata: {
              provider: provider.providerKey,
              processingTime: Date.now() - start,
            },
          };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          log.warn(
            { provider: provider.providerKey, err: lastError.message },
            'AI provider failed parseScreenshot; trying next'
          );
        }
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: lastError?.message ?? 'AI parse failed',
      });
    }),

  parseDocumentText: bearerProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/trpc/ai.parseDocumentText',
        tags: ['ai'],
        summary: 'Parse unstructured document text into a portfolio shape',
        protect: true,
      },
    })
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
    .output(z.unknown())
    .mutation(async ({ input, ctx }) => {
      const opts = input.options ?? {};
      const providers = selectProviders(opts.provider);
      if (providers.length === 0) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'No AI providers available',
        });
      }
      const hint = buildHint(opts);
      let lastError: Error | null = null;
      for (const provider of providers) {
        if (!provider.parseDocumentText) continue;
        const start = Date.now();
        try {
          const result = await provider.parseDocumentText(input.text, hint);
          annotateUsage(ctx, provider.providerKey, result.usage);
          return {
            portfolio: normalizePortfolio(result.data),
            metadata: {
              provider: provider.providerKey,
              processingTime: Date.now() - start,
            },
          };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          log.warn(
            { provider: provider.providerKey, err: lastError.message },
            'AI provider failed parseDocumentText; trying next'
          );
        }
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: lastError?.message ?? 'AI parse failed',
      });
    }),

  completeText: bearerProcedure
    .meta({
      openapi: {
        method: 'POST',
        path: '/trpc/ai.completeText',
        tags: ['ai'],
        summary: 'Free-form LLM text completion via the configured AI provider',
        protect: true,
      },
    })
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
    .output(z.unknown())
    .mutation(async ({ input, ctx }) => {
      const opts = input.options ?? {};
      const providers = selectProviders(opts.provider);
      if (providers.length === 0) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'No AI providers available',
        });
      }
      let lastError: Error | null = null;
      for (const provider of providers) {
        if (!provider.completeText) continue;
        try {
          const result = await provider.completeText(input.prompt, {
            maxTokens: opts.maxTokens,
            temperature: opts.temperature,
          });
          annotateUsage(ctx, provider.providerKey, result.usage);
          return { content: result.data, provider: provider.providerKey };
        } catch (err) {
          lastError = err instanceof Error ? err : new Error(String(err));
          log.warn(
            { provider: provider.providerKey, err: lastError.message },
            'AI provider failed completeText; trying next'
          );
        }
      }
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: lastError?.message ?? 'AI completion failed',
      });
    }),

  status: bearerProcedure
    .meta({
      openapi: {
        method: 'GET',
        path: '/trpc/ai.status',
        tags: ['ai'],
        summary: 'Report which AI providers are currently available',
        protect: true,
      },
    })
    .input(z.void())
    .output(z.unknown())
    .query(() => {
      const providers = getProviders();
      return {
        availableProviders: providers.map((p) => ({ providerKey: p.providerKey })),
        hasAvailableProvider: providers.length > 0,
      };
    }),
});
