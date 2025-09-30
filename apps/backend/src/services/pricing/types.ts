import type { Token } from '../../db/schema';

export type PricingProviderKey = 'exchangeRate' | 'coinGecko' | 'finnhub' | 'googleSheets';

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
