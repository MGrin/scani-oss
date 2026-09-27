import type { ProviderFactory } from '@scani/providers/core/boot';
import {
  isCurrentPriceProvider,
  isHistoricalPriceProvider,
} from '@scani/providers/core/capabilities';
import { cloudPricingProviderSchema } from '@scani/providers/core/cloud-contract';
import { loadCloudClientConfig } from '../config';
import { getCloudClient } from '../runtime';
import { CloudAIProvider, CloudIdentityProvider, CloudPricingProvider } from './platform';
import { CloudWalletProvider } from './wallet';

export function platformProviderFactories(
  direct: readonly ProviderFactory[]
): readonly ProviderFactory[] {
  if (loadCloudClientConfig().SCANI_DEPLOYMENT_TIER !== '2') return direct;
  return [
    async () => {
      const client = getCloudClient();
      if (!client) throw new Error('Tier 2 requires Scani Cloud credentials');
      return [
        ...cloudPricingProviderSchema.options
          .filter((key) => key !== 'kraken')
          .map((key) => new CloudPricingProvider(client, key)),
        ...['coingecko', 'defillama', 'finnhub'].map(
          (key) => new CloudIdentityProvider(client, key)
        ),
        ...(['etherscan', 'bitcoin', 'solana', 'tron', 'ton'] as const).map(
          (key) => new CloudWalletProvider(client, key)
        ),
        new CloudAIProvider(client),
      ];
    },
  ];
}

// Credentialed exchange operations stay local; their public price methods use
// the same cloud budget as other market data in Tier 2.
export function personalProviderFactories(
  direct: readonly ProviderFactory[]
): readonly ProviderFactory[] {
  if (loadCloudClientConfig().SCANI_DEPLOYMENT_TIER !== '2') return direct;
  return direct.map((factory) => async (deps) => {
    const client = getCloudClient();
    if (!client) throw new Error('Tier 2 requires Scani Cloud credentials');
    const result = await factory(deps);
    const instances = Array.isArray(result) ? result : [result];
    for (const provider of instances) {
      if (!isCurrentPriceProvider(provider)) continue;
      const key = cloudPricingProviderSchema.parse(provider.providerKey);
      const remote = new CloudPricingProvider(client, key);
      provider.fetchCurrentPrice = remote.fetchCurrentPrice.bind(remote);
      provider.fetchCurrentPrices = remote.fetchCurrentPrices.bind(remote);
      if (isHistoricalPriceProvider(provider)) {
        provider.fetchHistoricalPrice = remote.fetchHistoricalPrice.bind(remote);
        provider.fetchHistoricalRange = remote.fetchHistoricalRange?.bind(remote);
      }
    }
    return result;
  });
}
