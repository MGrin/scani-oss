import Decimal from 'decimal.js';
import { PROVIDER_CONFIGS } from '../provider-config';
import type { ProviderPriceResult, TokenWithProvider } from '../types';
import { fetchWithTimeout } from '../utils';
import type { CreateFailureResultFn, PricingProvider, ProviderExecutionContext } from './base';

interface ExchangeRateApiResponse {
  base: string;
  date: string;
  time_last_updated: number;
  rates: Record<string, number>;
}

interface ExchangeRateProviderDependencies {
  createFailureResult: CreateFailureResultFn;
}

export class ExchangeRateProvider implements PricingProvider {
  readonly key = 'exchangeRate';

  constructor(private readonly deps: ExchangeRateProviderDependencies) {}

  async fetchPrices(
    tokens: TokenWithProvider[],
    { baseCurrency, timestamp }: ProviderExecutionContext
  ): Promise<ProviderPriceResult[]> {
    if (tokens.length === 0) {
      return [];
    }

    const { createFailureResult } = this.deps;
    const baseCurrencySymbol = baseCurrency.symbol.toUpperCase();
    const results: ProviderPriceResult[] = [];

    try {
      const url = `${PROVIDER_CONFIGS.exchangeRate.baseUrl}/${baseCurrencySymbol}`;
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        throw new Error(
          `ExchangeRate-API responded with ${response.status}: ${response.statusText}`
        );
      }

      const data = (await response.json()) as ExchangeRateApiResponse;

      if (!data.rates) {
        throw new Error('ExchangeRate-API returned no rates data');
      }

      for (const { token, providerTokenId } of tokens) {
        const symbol = (providerTokenId || token.symbol).toUpperCase();

        if (symbol === baseCurrencySymbol) {
          results.push({
            tokenId: token.id,
            price: '1.0',
            timestamp,
            source: PROVIDER_CONFIGS.exchangeRate.name,
          });
          continue;
        }

        if (data.rates[symbol]) {
          const rateFromBaseToToken = new Decimal(data.rates[symbol]);
          const priceInBaseCurrency = new Decimal(1).div(rateFromBaseToToken);

          results.push({
            tokenId: token.id,
            price: priceInBaseCurrency.toString(),
            timestamp,
            source: PROVIDER_CONFIGS.exchangeRate.name,
          });
          continue;
        }

        results.push(
          createFailureResult(
            token.id,
            timestamp,
            PROVIDER_CONFIGS.exchangeRate.name,
            new Error('Currency rate not available'),
            { response, dataEmpty: false }
          )
        );
      }
    } catch (error) {
      for (const { token } of tokens) {
        try {
          results.push(
            createFailureResult(token.id, timestamp, PROVIDER_CONFIGS.exchangeRate.name, error, {
              dataEmpty: false,
            })
          );
        } catch {
          // Non-cacheable errors are ignored so the caller can retry later
        }
      }
    }

    return results;
  }
}
