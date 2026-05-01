/**
 * `CloudTokenEnricher` — `TokenIdentityProvider` proxy. Forwards the
 * partial-token probe to the data-provider so the heavy concrete
 * directory (CoinGecko, DeFiLlama, etc.) stays out of the
 * backend/worker bundle.
 *
 * `listSupportedTokens()` is intentionally absent — it's a nightly
 * cron-only entry point; the cron lives in the same process as the
 * direct-mode registry, so cloud-mode never needs the proxy version.
 * If a use case appears (admin UI, debug tool), add a passthrough
 * method here.
 */

import type { NewToken, TokenMetadata } from '@scani/db/schema';
import type { Capability, TokenIdentityProvider } from '../capabilities';
import type { CloudProviderClient } from './cloud-client';

export class CloudTokenEnricher implements TokenIdentityProvider {
  readonly capabilities: readonly Capability[] = ['token-identity'];

  constructor(
    readonly providerKey: string,
    private readonly client: CloudProviderClient
  ) {}

  async enrichTokenIdentity(
    partial: Partial<NewToken>,
    opts?: { force?: boolean }
  ): Promise<Partial<TokenMetadata> | null> {
    return this.client.enrichTokenIdentity({
      providerKey: this.providerKey,
      partial,
      force: opts?.force,
    });
  }
}
