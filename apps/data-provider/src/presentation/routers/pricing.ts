import { createComponentLogger } from '@scani/logging';
import type {
  ConvertPriceFn,
  CreateFailureResultFn,
  PricingProvider,
  PricingProviderKey,
  ProviderExecutionContext,
  ProviderPriceResult,
  TokenWithProvider,
} from '@scani/pricing-providers';
import {
  CoinGeckoProvider,
  DeFiLlamaProvider,
  ExchangeRateProvider,
  FinnhubProvider,
  fetchWithTimeout,
  PROVIDER_CONFIGS,
  RateLimiter,
} from '@scani/pricing-providers';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { bearerProcedure, router } from '../trpc';

/**
 * Pricing router — owns every outbound call to CoinGecko / Finnhub /
 * DeFiLlama / ExchangeRate-API / Google Sheets.
 *
 * Design notes:
 * - One tRPC procedure per primary provider. The domain's `PricingService`
 *   (in `@scani/domain`) already groups tokens by provider key *before*
 *   calling `fetchPrices`, so there's no dispatch logic to move here.
 * - Global rate-limiter buckets + circuit-breaker state stay close to the
 *   actual HTTP call: one place in the topology, not N backend replicas.
 * - Google Sheets provider requires DB access (it reads the user's sheet
 *   configuration) — moving it is phase-5-scope (storage) rather than a
 *   one-liner here. Today the backend still calls Google Sheets directly;
 *   this router only exposes the four primary providers.
 */

const log = createComponentLogger('data-provider:pricing');

// ── Rate-limit buckets. These were previously declared at module scope
// inside PricingService (packages/domain). Same namespaces, so the
// Redis keyspace is unchanged — a zero-data-migration move.
const RATE_LIMITERS = {
  finnhub: new RateLimiter(50, 60 * 1000, { namespace: 'finnhub' }),
  // CoinGecko Demo/Public API: ~30 calls/min, we use a safety margin of 25.
  coinGecko: new RateLimiter(25, 60 * 1000, { namespace: 'coingecko' }),
  // DeFiLlama free tier: 5 calls/sec.
  defiLlama: new RateLimiter(5, 1000, { namespace: 'defillama' }),
  exchangeRate: new RateLimiter(2, 60 * 1000, { namespace: 'exchangerate' }),
};

// Minimal failure-result shape. The domain's PricingService has richer
// failure classification (tier limitation, retryable error, empty response,
// …) that stays in the domain — this router returns a flat failure and
// lets the client decide whether to retry. This matches the "stateless at
// the app layer" contract in the architecture plan.
const createFailureResult: CreateFailureResultFn = (tokenId, timestamp, providerName, error) => {
  const message = error instanceof Error ? error.message : String(error);
  return {
    tokenId,
    price: '0',
    timestamp,
    source: `${providerName}_failure:${message.slice(0, 120)}`,
  };
};

// Currency conversion for providers that price in a non-base currency
// (mostly Finnhub for non-USD stocks). Data-provider owns its own
// in-memory cache of rates; cold-start is a single ExchangeRate-API hit.
// A full DB-backed cache like the domain's is overkill here since the
// process is long-lived and the set of currency pairs is tiny.
const RATE_CACHE = new Map<string, { rate: string; expiresAt: number }>();
const RATE_TTL_MS = 10 * 60 * 1000;

async function convertPrice(
  price: string,
  fromCurrency: string,
  toCurrency: string,
  _timestamp: Date
): Promise<string> {
  if (fromCurrency === toCurrency || price === '0') return price;
  const key = `${fromCurrency.toUpperCase()}->${toCurrency.toUpperCase()}`;
  const now = Date.now();
  const cached = RATE_CACHE.get(key);
  if (cached && cached.expiresAt > now) {
    return (Number(price) * Number(cached.rate)).toString();
  }
  try {
    const url = `${PROVIDER_CONFIGS.exchangeRate.baseUrl}/${fromCurrency}`;
    await RATE_LIMITERS.exchangeRate.execute(async () => {});
    const res = await fetchWithTimeout(url);
    if (!res.ok) throw new Error(`ExchangeRate-API ${res.status}`);
    const data = (await res.json()) as { rates?: Record<string, number> };
    const rate = data.rates?.[toCurrency];
    if (!rate) throw new Error(`no rate ${fromCurrency}->${toCurrency}`);
    RATE_CACHE.set(key, { rate: rate.toString(), expiresAt: now + RATE_TTL_MS });
    return (Number(price) * rate).toString();
  } catch (err) {
    log.warn({ err, fromCurrency, toCurrency }, 'Failed to convert price');
    return '0';
  }
}

const convertPriceBound: ConvertPriceFn = convertPrice;

const PROVIDERS: Record<Exclude<PricingProviderKey, 'googleSheets'>, PricingProvider> = {
  exchangeRate: new ExchangeRateProvider({ createFailureResult }),
  coinGecko: new CoinGeckoProvider({
    rateLimiter: RATE_LIMITERS.coinGecko,
    convertPrice: convertPriceBound,
    createFailureResult,
  }),
  defiLlama: new DeFiLlamaProvider({
    rateLimiter: RATE_LIMITERS.defiLlama,
    convertPrice: convertPriceBound,
    createFailureResult,
  }),
  finnhub: new FinnhubProvider({
    rateLimiter: RATE_LIMITERS.finnhub,
    convertPrice: convertPriceBound,
    createFailureResult,
    logger: createComponentLogger('data-provider:pricing:finnhub'),
  }),
};

// Zod-mirror of `TokenWithProvider` — narrow enough to avoid leaking db
// schema into the wire, wide enough to drive provider dispatch.
const tokenSchema = z.object({
  id: z.string(),
  symbol: z.string(),
  name: z.string(),
  typeId: z.string(),
  decimals: z.number(),
  iconUrl: z.string().nullable(),
  providerMetadata: z.string().nullable(),
  isScamProbability: z.number(),
  isActive: z.boolean(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

const tokenWithProviderSchema = z.object({
  token: tokenSchema,
  provider: z.enum(['exchangeRate', 'coinGecko', 'defiLlama', 'finnhub', 'googleSheets']),
  providerTokenId: z.string().optional(),
});

const contextSchema = z.object({
  baseCurrency: tokenSchema,
  timestamp: z.coerce.date(),
});

const fetchPricesInputSchema = z.object({
  providerKey: z.enum(['exchangeRate', 'coinGecko', 'defiLlama', 'finnhub']),
  tokens: z.array(tokenWithProviderSchema),
  context: contextSchema,
});

export const pricingRouter = router({
  fetchPrices: bearerProcedure
    .input(fetchPricesInputSchema)
    .mutation(async ({ input }): Promise<ProviderPriceResult[]> => {
      const provider = PROVIDERS[input.providerKey];
      if (!provider) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Unknown provider: ${input.providerKey}`,
        });
      }

      // Cast through unknown because our zod-validated shape is structurally
      // compatible with the domain `Token` / `TokenWithProvider` types (same
      // fields) but zod's inferred types and drizzle's inferred types diverge
      // on nullable vs. `| null`.
      const tokens = input.tokens as unknown as TokenWithProvider[];
      const context: ProviderExecutionContext = {
        baseCurrency: input.context
          .baseCurrency as unknown as ProviderExecutionContext['baseCurrency'],
        timestamp: input.context.timestamp,
      };

      try {
        return await provider.fetchPrices(tokens, context);
      } catch (err) {
        log.error({ err, providerKey: input.providerKey }, 'Provider fetchPrices threw');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }),

  /** ExchangeRate-API currency conversion — reused by backend's in-memory cache. */
  convertRate: bearerProcedure
    .input(
      z.object({
        fromCurrency: z.string(),
        toCurrency: z.string(),
      })
    )
    .query(async ({ input }): Promise<{ rate: string }> => {
      const rate = await convertPrice('1', input.fromCurrency, input.toCurrency, new Date());
      return { rate };
    }),
});
