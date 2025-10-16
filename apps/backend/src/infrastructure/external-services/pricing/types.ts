import type { Token } from '../../../domain/entities';

export type PricingProviderKey =
  | 'exchangeRate'
  | 'coinGecko'
  | 'defiLlama'
  | 'finnhub'
  | 'googleSheets';

export interface ProviderPriceResult {
  tokenId: string;
  price: string;
  timestamp: Date;
  source: string;
}

export interface TokenWithProvider {
  token: Token;
  provider: PricingProviderKey;
  providerTokenId?: string;
}
