import { afterEach, expect, test } from 'bun:test';
import type { ProviderFactoryDeps } from '@scani/providers/core/boot';
import type { CredentialValidator, CurrentPriceProvider } from '@scani/providers/core/capabilities';
import { fromCloudAsset } from '@scani/providers/core/cloud-contract';
import type { CloudClient } from '../../src/client';
import { loadCloudClientConfig, resetCloudClientConfig } from '../../src/config';
import { personalProviderFactories, platformProviderFactories } from '../../src/providers';
import { resetCloudClient, setCloudClient } from '../../src/runtime';

afterEach(() => {
  resetCloudClientConfig();
  resetCloudClient();
});
const deps = {} as ProviderFactoryDeps;
function configure(tier: '1' | '2') {
  resetCloudClientConfig();
  loadCloudClientConfig({
    NODE_ENV: 'test',
    SCANI_DEPLOYMENT_TIER: tier,
    SCANI_CLOUD_URL: 'https://cloud.example',
    SCANI_CLOUD_API_KEY: 'one-cloud-key-only',
  });
}
test('Tier 2 never constructs direct platform factories; Tier 1 keeps them', async () => {
  const direct = async () => {
    throw new Error('direct provider constructed');
  };
  configure('1');
  expect(platformProviderFactories([direct])).toEqual([direct]);
  configure('2');
  setCloudClient({} as CloudClient);
  const factories = platformProviderFactories([direct]);
  const providers = await factories[0]?.(deps);
  expect(Array.isArray(providers)).toBe(true);
});
test('personal exchange credentials remain local while public exchange pricing goes to cloud', async () => {
  configure('2');
  let validated = false;
  setCloudClient({
    processing: { v1: { prices: { mutate: async () => [] } } },
  } as unknown as CloudClient);
  const direct = async () => ({
    providerKey: 'kraken',
    capabilities: ['current-price', 'credential-validator'],
    canPrice: () => true,
    fetchCurrentPrice: async () => {
      throw new Error('direct price egress');
    },
    validateCredentials: async () => {
      validated = true;
      return { valid: true };
    },
  });
  const factory = personalProviderFactories([direct])[0];
  const provider = (await factory?.(deps)) as CurrentPriceProvider & CredentialValidator;
  const asset = fromCloudAsset({ id: 'usd', symbol: 'USD', name: 'USD', typeId: 'fiat' });
  expect(await provider.fetchCurrentPrice(asset, { baseCurrency: asset })).toBeNull();
  await provider.validateCredentials({ apiSecret: 'local-only' }, 'kraken');
  expect(validated).toBe(true);
});

test('Kraken retains optional range absence so historical backfill uses daily lookups', async () => {
  configure('2');
  setCloudClient({} as CloudClient);
  const direct = async () => ({
    providerKey: 'kraken',
    capabilities: ['current-price', 'historical-price'],
    canPrice: () => true,
    fetchCurrentPrice: async () => null,
    fetchHistoricalPrice: async () => null,
  });
  const factory = personalProviderFactories([direct])[0];
  const provider = (await factory?.(deps)) as {
    providerKey: string;
    fetchHistoricalPrice?: unknown;
    fetchHistoricalRange?: unknown;
  };
  expect(provider.fetchHistoricalPrice).toBeFunction();
  expect(provider.fetchHistoricalRange).toBeUndefined();
});
// SC-1586: the cloud refuses Yahoo to customer keys, so a Tier 2 install
// must not register a pricer that every run would see refused.
test('Tier 2 registers no cloud pricer for a Scani-only provider', async () => {
  configure('2');
  setCloudClient({} as CloudClient);
  const providers = (await platformProviderFactories([])[0]?.(deps)) as { providerKey: string }[];
  const keys = providers.map((p) => p.providerKey);
  expect(keys).toContain('finnhub');
  expect(keys).not.toContain('yahoo-finance');
});
