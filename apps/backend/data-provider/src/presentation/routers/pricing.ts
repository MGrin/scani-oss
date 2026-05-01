/**
 * Pricing router — data-provider's outbound surface to CoinGecko /
 * DeFiLlama / Frankfurter / Finnhub. Every primary provider is owned
 * by the `@scani/providers` registry built in
 * `apps/backend/data-provider/src/index.ts`. This router dispatches
 * by `providerKey` and returns `PriceQuote` shapes 1:1 with
 * `CloudProviderClient`.
 *
 * Google Sheets stays out of this router: per-user sheet config is
 * backend-side DB state. Backend constructs and registers
 * GoogleSheetsProvider directly via `@scani/providers-google-sheets`.
 */

import { createComponentLogger } from '@scani/logging';
import type {
  CurrentPriceProvider,
  HistoricalPriceProvider,
} from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import type { ProviderContext } from '@scani/providers/core/types';
import { TRPCError } from '@trpc/server';
import { Container } from 'typedi';
import { z } from 'zod';
import { bearerProcedure, router } from '../trpc';

const log = createComponentLogger('data-provider:pricing');

const tokenSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  typeId: z.string(),
  decimals: z.number(),
  iconUrl: z.string().nullable(),
  providerMetadata: z.unknown(),
  isScamProbability: z.number(),
  isActive: z.boolean(),
  marketSegment: z.string().nullable().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

const priceQuoteOut = z
  .object({
    tokenId: z.string(),
    baseTokenId: z.string(),
    price: z.string(),
    timestamp: z.coerce.date(),
    source: z.string(),
  })
  .nullable();

function findCurrentPricer(providerKey: string): CurrentPriceProvider {
  const provider = Container.get(ProviderRegistry)
    .getAllCurrentPricers()
    .find((p) => p.providerKey === providerKey);
  if (!provider) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `data-provider has no registered current-pricer for key '${providerKey}'`,
    });
  }
  return provider;
}

function findHistoricalPricer(providerKey: string): HistoricalPriceProvider {
  const provider = Container.get(ProviderRegistry)
    .getAllHistoricalPricers()
    .find((p) => p.providerKey === providerKey);
  if (!provider) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `data-provider has no registered historical-pricer for key '${providerKey}'`,
    });
  }
  return provider;
}

export const pricingRouter = router({
  fetchCurrentPrice: bearerProcedure
    .input(
      z.object({
        providerKey: z.string(),
        token: tokenSchema,
        baseCurrency: tokenSchema,
        timestamp: z.coerce.date().optional(),
      })
    )
    .mutation(async ({ input }): Promise<z.infer<typeof priceQuoteOut>> => {
      const provider = findCurrentPricer(input.providerKey);
      const token = input.token as unknown as Parameters<
        CurrentPriceProvider['fetchCurrentPrice']
      >[0];
      const ctx: ProviderContext = {
        baseCurrency: input.baseCurrency as unknown as ProviderContext['baseCurrency'],
        timestamp: input.timestamp,
      };
      try {
        return await provider.fetchCurrentPrice(token, ctx);
      } catch (err) {
        log.warn(
          { providerKey: input.providerKey, tokenId: input.token.id, err },
          'fetchCurrentPrice failed'
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  fetchCurrentPrices: bearerProcedure
    .input(
      z.object({
        providerKey: z.string(),
        tokens: z.array(tokenSchema),
        baseCurrency: tokenSchema,
        timestamp: z.coerce.date().optional(),
      })
    )
    .mutation(
      async ({
        input,
      }): Promise<
        Array<{ tokenId: string; quote: NonNullable<z.infer<typeof priceQuoteOut>> }>
      > => {
        const provider = findCurrentPricer(input.providerKey);
        const tokens = input.tokens as unknown as Parameters<
          CurrentPriceProvider['fetchCurrentPrice']
        >[0][];
        const ctx: ProviderContext = {
          baseCurrency: input.baseCurrency as unknown as ProviderContext['baseCurrency'],
          timestamp: input.timestamp,
        };

        // Provider may implement the batch hint or not. Fall back to
        // per-token loop when absent so the wire shape is uniform.
        if (typeof provider.fetchCurrentPrices === 'function') {
          const map = await provider.fetchCurrentPrices(tokens, ctx);
          return Array.from(map.entries()).map(([tokenId, quote]) => ({ tokenId, quote }));
        }
        const out: Array<{
          tokenId: string;
          quote: NonNullable<z.infer<typeof priceQuoteOut>>;
        }> = [];
        for (const t of tokens) {
          try {
            const q = await provider.fetchCurrentPrice(t, ctx);
            if (q) out.push({ tokenId: t.id, quote: q });
          } catch (err) {
            log.warn(
              { providerKey: input.providerKey, tokenId: t.id, err },
              'fetchCurrentPrice (batch fallback) failed for token; skipping'
            );
          }
        }
        return out;
      }
    ),

  fetchHistoricalPrice: bearerProcedure
    .input(
      z.object({
        providerKey: z.string(),
        token: tokenSchema,
        at: z.coerce.date(),
        baseCurrency: tokenSchema,
      })
    )
    .mutation(async ({ input }): Promise<z.infer<typeof priceQuoteOut>> => {
      const provider = findHistoricalPricer(input.providerKey);
      const token = input.token as unknown as Parameters<
        HistoricalPriceProvider['fetchHistoricalPrice']
      >[0];
      const ctx: ProviderContext = {
        baseCurrency: input.baseCurrency as unknown as ProviderContext['baseCurrency'],
        timestamp: input.at,
      };
      try {
        return await provider.fetchHistoricalPrice(token, input.at, ctx);
      } catch (err) {
        log.warn(
          { providerKey: input.providerKey, tokenId: input.token.id, at: input.at, err },
          'fetchHistoricalPrice failed'
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  fetchHistoricalRange: bearerProcedure
    .input(
      z.object({
        providerKey: z.string(),
        token: tokenSchema,
        from: z.coerce.date(),
        to: z.coerce.date(),
        baseCurrency: tokenSchema,
      })
    )
    .mutation(async ({ input }): Promise<NonNullable<z.infer<typeof priceQuoteOut>>[]> => {
      const provider = findHistoricalPricer(input.providerKey);
      if (typeof provider.fetchHistoricalRange !== 'function') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `provider '${input.providerKey}' does not implement fetchHistoricalRange`,
        });
      }
      const token = input.token as unknown as Parameters<
        HistoricalPriceProvider['fetchHistoricalPrice']
      >[0];
      const ctx: ProviderContext = {
        baseCurrency: input.baseCurrency as unknown as ProviderContext['baseCurrency'],
      };
      try {
        return await provider.fetchHistoricalRange(token, input.from, input.to, ctx);
      } catch (err) {
        log.warn(
          {
            providerKey: input.providerKey,
            tokenId: input.token.id,
            from: input.from,
            to: input.to,
            err,
          },
          'fetchHistoricalRange failed'
        );
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  /**
   * ExchangeRate-API currency conversion. Frankfurter could power this
   * via fetchHistoricalPrice in principle, but exchangerate-api.com's
   * free tier is the right tool for one-rate live lookups.
   */
  convertRate: bearerProcedure
    .input(
      z.object({
        fromCurrency: z.string(),
        toCurrency: z.string(),
      })
    )
    .query(async ({ input }): Promise<{ rate: string }> => {
      if (input.fromCurrency === input.toCurrency) return { rate: '1' };
      try {
        // `/v4/latest/{base}` — without `/latest/` the endpoint 404s.
        const url = `https://api.exchangerate-api.com/v4/latest/${input.fromCurrency}`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`ExchangeRate-API ${res.status}`);
        const data = (await res.json()) as { rates?: Record<string, number> };
        const rate = data.rates?.[input.toCurrency];
        if (!rate) throw new Error(`no rate ${input.fromCurrency}->${input.toCurrency}`);
        return { rate: rate.toString() };
      } catch (err) {
        log.warn(
          { err, fromCurrency: input.fromCurrency, toCurrency: input.toCurrency },
          'convertRate failed'
        );
        return { rate: '0' };
      }
    }),
});
