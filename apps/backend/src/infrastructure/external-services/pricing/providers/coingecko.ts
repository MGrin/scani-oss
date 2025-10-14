import { config } from '../../../../config/pricing';
import { PROVIDER_CONFIGS } from '../provider-config';
import type { ProviderPriceResult, TokenWithProvider } from '../types';
import type { RateLimiter } from '../utils';
import { fetchWithTimeout } from '../utils';
import type {
  ConvertPriceFn,
  CreateFailureResultFn,
  PricingProvider,
  ProviderExecutionContext,
} from './base';

interface CoinGeckoPriceResponse {
  [coinId: string]: {
    [currency: string]: number;
  };
}

interface CoinGeckoProviderDependencies {
  rateLimiter: RateLimiter;
  convertPrice: ConvertPriceFn;
  createFailureResult: CreateFailureResultFn;
}

export class CoinGeckoProvider implements PricingProvider {
  readonly key = 'coinGecko';

  constructor(private readonly deps: CoinGeckoProviderDependencies) {}

  async fetchPrices(
    tokens: TokenWithProvider[],
    { baseCurrency, timestamp }: ProviderExecutionContext
  ): Promise<ProviderPriceResult[]> {
    if (tokens.length === 0) {
      return [];
    }

    const { rateLimiter, convertPrice, createFailureResult } = this.deps;
    const coinIds = tokens
      .map(({ providerTokenId, token }) => providerTokenId || token.symbol.toLowerCase())
      .filter(Boolean)
      .join(',');

    if (!coinIds) {
      throw new Error('No valid CoinGecko IDs found for tokens');
    }

    const baseCurrencyLower = baseCurrency.symbol.toLowerCase();
    let apiCurrency = baseCurrencyLower;
    let needsConversion = false;
    let data: CoinGeckoPriceResponse | undefined;
    let response: Response | undefined;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.coinGecko.apiKey) {
      headers['x-cg-pro-api-key'] = config.coinGecko.apiKey;
    }

    try {
      response = await rateLimiter.execute(async () => {
        const url = `${PROVIDER_CONFIGS.coinGecko.baseUrl}/simple/price?ids=${coinIds}&vs_currencies=${apiCurrency}`;
        return await fetchWithTimeout(url, { headers });
      });

      if (!response.ok) {
        throw new Error(`CoinGecko API responded with ${response.status}: ${response.statusText}`);
      }

      data = (await response.json()) as CoinGeckoPriceResponse;

      const hasDataInBaseCurrency = tokens.some(({ providerTokenId, token }) => {
        const coinId = providerTokenId || token.symbol.toLowerCase();
        return data && data[coinId]?.[apiCurrency] !== undefined;
      });

      if (!hasDataInBaseCurrency && baseCurrencyLower !== 'usd') {
        apiCurrency = 'usd';
        needsConversion = true;
        response = await rateLimiter.execute(async () => {
          const url = `${PROVIDER_CONFIGS.coinGecko.baseUrl}/simple/price?ids=${coinIds}&vs_currencies=${apiCurrency}`;
          return await fetchWithTimeout(url, { headers });
        });

        if (!response.ok) {
          throw new Error(
            `CoinGecko API responded with ${response.status}: ${response.statusText}`
          );
        }

        data = (await response.json()) as CoinGeckoPriceResponse;
      }
    } catch (error) {
      return this.handleFailure(tokens, timestamp, createFailureResult, error, response);
    }

    if (!data) {
      return this.handleFailure(
        tokens,
        timestamp,
        createFailureResult,
        new Error('No data'),
        response
      );
    }

    const results: ProviderPriceResult[] = [];

    for (const { token, providerTokenId } of tokens) {
      const coinId = providerTokenId || token.symbol.toLowerCase();
      const priceData = data[coinId];
      const priceValue = priceData?.[apiCurrency];

      if (priceValue === undefined || priceValue === null) {
        try {
          results.push(
            createFailureResult(
              token.id,
              timestamp,
              PROVIDER_CONFIGS.coinGecko.name,
              new Error('No price data available for token'),
              { response, dataEmpty: true }
            )
          );
        } catch {
          // ignore non-cacheable failures
        }
        continue;
      }

      let finalPrice = priceValue.toString();

      if (needsConversion) {
        finalPrice = await convertPrice(
          finalPrice,
          'USD',
          baseCurrency.symbol.toUpperCase(),
          timestamp
        );

        if (finalPrice === '0') {
          results.push({
            tokenId: token.id,
            price: '0',
            timestamp,
            source: `${PROVIDER_CONFIGS.coinGecko.name}_conversion_failed`,
          });
          continue;
        }
      }

      results.push({
        tokenId: token.id,
        price: finalPrice,
        timestamp,
        source: PROVIDER_CONFIGS.coinGecko.name,
      });
    }

    return results;
  }

  private handleFailure(
    tokens: TokenWithProvider[],
    timestamp: Date,
    createFailureResult: CreateFailureResultFn,
    error: unknown,
    response?: Response
  ): ProviderPriceResult[] {
    const results: ProviderPriceResult[] = [];
    for (const { token } of tokens) {
      try {
        results.push(
          createFailureResult(token.id, timestamp, PROVIDER_CONFIGS.coinGecko.name, error, {
            response,
            dataEmpty: false,
          })
        );
      } catch {
        // skip non-cacheable errors
      }
    }
    return results;
  }
}
