import type { Logger } from 'pino';
import { config } from '../../../../config/pricing';
import { PROVIDER_CONFIGS } from '../provider-config';
import type { ProviderPriceResult, TokenWithProvider } from '../types';
import type { RateLimiter } from '../utils';
import { fetchWithTimeout, normalizeForFinnhubSymbol } from '../utils';
import type {
  ConvertPriceFn,
  CreateFailureResultFn,
  PricingProvider,
  ProviderExecutionContext,
} from './base';

interface FinnhubQuoteResponse {
  c: number;
  d: number;
  dp: number;
  h: number;
  l: number;
  o: number;
  pc: number;
  t: number;
}

type FinnhubLogger = Pick<Logger, 'debug' | 'warn' | 'error'>;

interface FinnhubProviderDependencies {
  rateLimiter: RateLimiter;
  convertPrice: ConvertPriceFn;
  createFailureResult: CreateFailureResultFn;
  logger: FinnhubLogger;
}

export class FinnhubProvider implements PricingProvider {
  readonly key = 'finnhub';

  constructor(private readonly deps: FinnhubProviderDependencies) {}

  async fetchPrices(
    tokens: TokenWithProvider[],
    { baseCurrency, timestamp }: ProviderExecutionContext
  ): Promise<ProviderPriceResult[]> {
    if (tokens.length === 0) {
      return [];
    }

    const { rateLimiter, convertPrice, createFailureResult } = this.deps;
    const baseCurrencyUpper = baseCurrency.symbol.toUpperCase();
    const needsConversion = baseCurrencyUpper !== 'USD';
    const results: ProviderPriceResult[] = [];

    const promises = tokens.map(async ({ token, providerTokenId }) => {
      const raw = providerTokenId || token.symbol;
      const symbol = normalizeForFinnhubSymbol(raw);

      try {
        const response = await rateLimiter.execute(async () => {
          const url = `${PROVIDER_CONFIGS.finnhub.baseUrl}/quote?symbol=${symbol}&token=${config.finnhub.apiKey}`;
          this.deps.logger.debug({ symbol, url }, 'Finnhub: Making rate-limited API request');
          return await fetchWithTimeout(url);
        });

        if (!response.ok) {
          return createFailureResult(
            token.id,
            timestamp,
            PROVIDER_CONFIGS.finnhub.name,
            new Error(`Finnhub API responded with ${response.status} for ${symbol}`),
            { response, dataEmpty: false }
          );
        }

        const data = (await response.json()) as FinnhubQuoteResponse;

        if (!data.c || data.c <= 0) {
          try {
            const metadata = JSON.parse(token.providerMetadata || '{}') as Record<string, unknown>;
            const exchangeInfo = metadata.exchangeInfo as
              | { exchange?: string; currency?: string }
              | undefined;
            const isUS =
              exchangeInfo?.exchange?.toUpperCase?.() === 'US' || exchangeInfo?.currency === 'USD';
            if (isUS) {
              this.deps.logger.warn(
                { symbol: token.symbol, normalized: symbol },
                'Finnhub returned no data for a US equity. This should not happen.'
              );
            }
          } catch {
            // ignore metadata parsing errors
          }

          return createFailureResult(
            token.id,
            timestamp,
            PROVIDER_CONFIGS.finnhub.name,
            new Error('No valid price data from Finnhub'),
            { response, dataEmpty: false }
          );
        }

        let finalPrice = data.c.toString();

        if (needsConversion) {
          finalPrice = await convertPrice(finalPrice, 'USD', baseCurrencyUpper, timestamp);

          if (finalPrice === '0') {
            return {
              tokenId: token.id,
              price: '0',
              timestamp,
              source: `${PROVIDER_CONFIGS.finnhub.name}_conversion_failed`,
            };
          }
        }

        return {
          tokenId: token.id,
          price: finalPrice,
          timestamp,
          source: PROVIDER_CONFIGS.finnhub.name,
        };
      } catch (error) {
        try {
          return createFailureResult(token.id, timestamp, PROVIDER_CONFIGS.finnhub.name, error, {
            dataEmpty: false,
          });
        } catch {
          throw error;
        }
      }
    });

    try {
      const fetchResults = await Promise.all(promises);
      results.push(...fetchResults);
    } catch (error) {
      this.deps.logger.error({ error, provider: 'finnhub' }, 'Finnhub API batch fetch failed');
      for (const { token } of tokens) {
        try {
          results.push(
            createFailureResult(token.id, timestamp, PROVIDER_CONFIGS.finnhub.name, error, {
              dataEmpty: false,
            })
          );
        } catch {
          // skip non-cacheable errors
        }
      }
    }

    return results;
  }
}
