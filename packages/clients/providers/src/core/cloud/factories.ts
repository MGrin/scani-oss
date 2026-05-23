// Cloud-mode factory helpers. Apps booting in cloud mode pass these to
// `buildProviderRegistry({ mode: 'cloud', providers: [...] })` to register
// capability proxies that forward every call to the data-provider via the
// injected `CloudProviderClient`.
//
// Direct mode never imports this file — the bundler tree-shakes it.

import type { ProviderFactory } from '../boot';
import { CloudAIProvider } from './cloud-ai';
import { CloudBalanceFetcher } from './cloud-balance-fetcher';
import { CloudCurrentPricer } from './cloud-current-pricer';
import { CloudHistoricalPricer } from './cloud-historical-pricer';
import { CloudTokenEnricher } from './cloud-token-enricher';
import { CloudTransactionsFetcher } from './cloud-transactions-fetcher';

function requireCloudClient(deps: { cloudClient: unknown }, providerKey: string) {
  if (!deps.cloudClient) {
    throw new Error(
      `Cloud-mode factory for '${providerKey}' requires a cloudClient — pass one to buildProviderRegistry({ mode: 'cloud', cloudClient }).`
    );
  }
  return deps.cloudClient;
}

export function makeCloudCurrentPricerFactory(providerKey: string): ProviderFactory {
  return async (deps) => {
    const client = requireCloudClient(deps, providerKey);
    // biome-ignore lint/suspicious/noExplicitAny: deps.cloudClient is the contract type CloudProviderClient
    return new CloudCurrentPricer(providerKey, client as any);
  };
}

export function makeCloudHistoricalPricerFactory(providerKey: string): ProviderFactory {
  return async (deps) => {
    const client = requireCloudClient(deps, providerKey);
    // biome-ignore lint/suspicious/noExplicitAny: see above
    return new CloudHistoricalPricer(providerKey, client as any);
  };
}

export function makeCloudBalanceFetcherFactory(
  providerKey: string,
  supportedInstitutionCodes: readonly string[]
): ProviderFactory {
  return async (deps) => {
    const client = requireCloudClient(deps, providerKey);
    // biome-ignore lint/suspicious/noExplicitAny: see above
    return new CloudBalanceFetcher(providerKey, supportedInstitutionCodes, client as any);
  };
}

export function makeCloudTransactionsFetcherFactory(
  providerKey: string,
  supportedInstitutionCodes: readonly string[]
): ProviderFactory {
  return async (deps) => {
    const client = requireCloudClient(deps, providerKey);
    // biome-ignore lint/suspicious/noExplicitAny: see above
    return new CloudTransactionsFetcher(providerKey, supportedInstitutionCodes, client as any);
  };
}

export function makeCloudTokenEnricherFactory(providerKey: string): ProviderFactory {
  return async (deps) => {
    const client = requireCloudClient(deps, providerKey);
    // biome-ignore lint/suspicious/noExplicitAny: see above
    return new CloudTokenEnricher(providerKey, client as any);
  };
}

export function makeCloudAIProviderFactory(providerKey: string): ProviderFactory {
  return async (deps) => {
    const client = requireCloudClient(deps, providerKey);
    // biome-ignore lint/suspicious/noExplicitAny: see above
    return new CloudAIProvider(providerKey, client as any);
  };
}
