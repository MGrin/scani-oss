import type { Token } from '@scani/db/schema';
import type { ProviderPriceResult, TokenWithProvider } from '../types';

export interface ProviderExecutionContext {
  baseCurrency: Token;
  timestamp: Date;
}

export type ConvertPriceFn = (
  price: string,
  fromCurrency: string,
  toCurrency: string,
  timestamp: Date
) => Promise<string>;

export type CreateFailureResultFn = (
  tokenId: string,
  timestamp: Date,
  providerName: string,
  error: unknown,
  options?: {
    response?: Response;
    dataEmpty?: boolean;
  }
) => ProviderPriceResult;

export interface PricingProvider {
  readonly key: string;
  fetchPrices(
    tokens: TokenWithProvider[],
    context: ProviderExecutionContext
  ): Promise<ProviderPriceResult[]>;
}
