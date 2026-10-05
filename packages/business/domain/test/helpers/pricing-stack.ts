import type { CurrentPriceProvider } from '@scani/providers/core/capabilities';
import { ProviderRegistry } from '@scani/providers/core/registry';
import { Container } from 'typedi';
import { CurrencyConverter } from '../../src/services/pricing/CurrencyConverter';
import { PricingProviderRouter } from '../../src/services/pricing/PricingProviderRouter';
import { PricingService } from '../../src/services/pricing/PricingService';

export interface PriceAsk {
  tokenId: string;
  baseId: string;
}

/**
 * Registers the real pricing stack over one provider, CoinGecko, which answers
 * 100 in whatever base it is asked and records each ask. The stack reads the
 * container when it is built, so call this after any stub it must see.
 */
export function pricingStack(): PriceAsk[] {
  const asks: PriceAsk[] = [];
  const coingecko: CurrentPriceProvider = {
    providerKey: 'coingecko',
    capabilities: ['current-price'],
    canPrice: () => true,
    fetchCurrentPrice: async (token, ctx) => {
      asks.push({ tokenId: token.id, baseId: ctx.baseCurrency.id });
      return {
        tokenId: token.id,
        baseTokenId: ctx.baseCurrency.id,
        price: '100',
        timestamp: ctx.timestamp ?? new Date(),
        source: 'coingecko',
      };
    },
  };
  const registry = new ProviderRegistry();
  registry.register(coingecko);
  Container.set(ProviderRegistry, registry);
  Container.set(PricingProviderRouter, new PricingProviderRouter());
  Container.set(CurrencyConverter, new CurrencyConverter());
  Container.set(PricingService, new PricingService());
  return asks;
}
