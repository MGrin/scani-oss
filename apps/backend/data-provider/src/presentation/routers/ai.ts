import { createComponentLogger } from '@scani/logging';
import type { AIInferenceProvider, AIUsage } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
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

// Published response schemas (SC-108). `raw` stays `z.unknown()`
// deliberately: with a caller-supplied `systemPrompt` the model's own
// schema governs that field, so this service cannot describe it.
const parsedPortfolioSchema = z.object({
  holdings: z.array(
    z.object({
      symbol: z.string(),
      name: z.string().optional(),
      balance: z.string(),
      confidence: z.number(),
      notes: z.string().optional(),
    })
  ),
  overallConfidence: z.number(),
  context: z.string().optional(),
  detectedCurrency: z.string().optional(),
});

const aiParseOutput = z.object({
  portfolio: parsedPortfolioSchema.optional(),
  raw: z.unknown().optional(),
  metadata: z.object({ provider: z.string(), processingTime: z.number() }),
});

/**
 * A caller-supplied `systemPrompt` REPLACES the provider's default
 * extraction schema, so its own schema — not the holdings one — governs
 * the response. Normalizing that through `normalizePortfolio` would
 * return `{holdings: []}` for a perfectly good invoice: valid JSON,
 * billed, zero rows, no error. So the two cases return DIFFERENT keys:
 *
 *   no systemPrompt → `{ portfolio, metadata }`  (unchanged, real callers)
 *   systemPrompt    → `{ raw, metadata }`        (the model's own shape)
 *
 * Distinct keys rather than a reused one so a client that asked for raw
 * and got `portfolio` back can tell it is talking to a data-provider too
 * old to honour the field, instead of silently reading zero results.
 */
const systemPromptSchema = z.string().optional();

function aiResponse(
  raw: unknown,
  systemPrompt: string | undefined,
  metadata: { provider: string; processingTime: number }
): { portfolio?: ParsedPortfolio; raw?: unknown; metadata: typeof metadata } {
  return systemPrompt ? { raw, metadata } : { portfolio: normalizePortfolio(raw), metadata };
}

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
            systemPrompt: systemPromptSchema,
          })
          .optional(),
      })
    )
    .output(aiParseOutput)
    .mutation(async ({ input, ctx }) => {
      // Test-only stub. Returns a fixed holdings payload so e2e tests don't
      // depend on the real AI provider (cost, flakiness, network). Reads
      // process.env directly so unauthed tRPC paths (which bail at the
      // bearer-procedure middleware before reaching this body) don't
      // trip the full data-provider env-schema validation. The var is
      // still validated + refused in production by config/env.ts at boot.
      //
      // Skipped when the caller replaced the system prompt: the stub only
      // knows the holdings shape, and answering an invoice prompt with
      // holdings is the exact silent-wrong-schema failure this route now
      // exists to prevent. Without a real provider registered the call
      // then fails loudly instead.
      if (process.env.STUB_AI === '1' && !input.options?.systemPrompt) {
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
            systemPrompt: opts.systemPrompt,
          });
          annotateUsage(ctx, provider.providerKey, result.usage);
          return aiResponse(result.data, opts.systemPrompt, {
            provider: provider.providerKey,
            processingTime: Date.now() - start,
          });
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
            systemPrompt: systemPromptSchema,
          })
          .optional(),
      })
    )
    .output(aiParseOutput)
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
          const result = await provider.parseDocumentText(input.text, hint, opts.systemPrompt);
          annotateUsage(ctx, provider.providerKey, result.usage);
          return aiResponse(result.data, opts.systemPrompt, {
            provider: provider.providerKey,
            processingTime: Date.now() - start,
          });
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
    .output(z.object({ content: z.string(), provider: z.string() }))
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
    .output(
      z.object({
        availableProviders: z.array(
          z.object({ providerKey: z.string(), supportsPdfFileInput: z.boolean() })
        ),
        hasAvailableProvider: z.boolean(),
        routeCapabilities: z.object({ systemPrompt: z.boolean() }),
      })
    )
    .query(() => {
      const providers = getProviders();
      return {
        availableProviders: providers.map((p) => ({
          providerKey: p.providerKey,
          // Relayed from the provider's own declaration so a cloud-mode
          // client can refuse a PDF locally instead of paying for a
          // request the upstream endpoint answers with
          // `invalid_image_format`.
          supportsPdfFileInput: p.supportsPdfFileInput === true,
        })),
        hasAvailableProvider: providers.length > 0,
        // Route-level capabilities, so a cloud client can tell a
        // data-provider that honours `systemPrompt` from one that would
        // silently normalize its response into the holdings shape. An
        // older deployment omits the whole block; absent means "no".
        routeCapabilities: { systemPrompt: true },
      };
    }),
});
