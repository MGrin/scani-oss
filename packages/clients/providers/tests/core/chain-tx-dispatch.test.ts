/**
 * SC-364. Wiring a chain into the transaction pipeline takes three
 * agreeing parts: a source tag for the chain id, a coordinator branch
 * mapping that tag to an institution code, and a registered provider
 * that claims the code for `transactions`. The first two are asserted
 * in `@scani/domain`; this is the third.
 *
 * It matters because the failure is not a skip. A code no provider
 * claims reaches `TransactionRouter.hasProviderFor` and comes back
 * false, and the account's nightly job then fails with `no-ingester`
 * rather than quietly doing nothing.
 */

import { describe, expect, test } from 'bun:test';
import type { ProviderFactory, ProviderFactoryDeps } from '../../src/core/boot';
import { CredentialPool } from '../../src/core/credential-pool';
import { RateLimiterRegistry } from '../../src/core/rate-limiter-registry';
import { ProviderRegistry } from '../../src/core/registry';
import { bitcoinFactory } from '../../src/providers/bitcoin';
import { solanaFactory } from '../../src/providers/solana';
import { tonFactory } from '../../src/providers/ton';
import { tronFactory } from '../../src/providers/tron';

// Institution code → the factory the worker boots for it
// (apps/backend/worker/src/index.ts). The codes are the source tags
// `sourceForChainId` answers with for the non-EVM sentinels.
const NON_EVM_CHAIN_PROVIDERS: ReadonlyArray<[string, ProviderFactory]> = [
  ['bitcoin', bitcoinFactory],
  ['solana', solanaFactory],
  ['tron', tronFactory],
  ['ton', tonFactory],
];

async function registerFresh(factory: ProviderFactory): Promise<ProviderRegistry> {
  // Fresh registry + limiter registry per case: the limiter registry
  // fails loud on a duplicate namespace, and the shared container's
  // registry is other suites' state.
  const registry = new ProviderRegistry();
  const deps: ProviderFactoryDeps = {
    mode: 'direct',
    redis: null,
    env: {},
    rateLimiterRegistry: new RateLimiterRegistry(),
    credentialPool: new CredentialPool(),
    cloudClient: null,
  };
  const result = await factory(deps);
  for (const instance of Array.isArray(result) ? result : [result]) {
    registry.register(instance);
  }
  return registry;
}

describe('non-EVM chains dispatch to a transactions provider', () => {
  for (const [institutionCode, factory] of NON_EVM_CHAIN_PROVIDERS) {
    test(`${institutionCode} has a registered transactions fetcher`, async () => {
      const registry = await registerFresh(factory);
      const fetcher = registry.getTransactionsFetcher(institutionCode);
      expect(fetcher).not.toBeNull();
      expect(fetcher?.canFetchTransactions(institutionCode)).toBe(true);
      expect(typeof fetcher?.fetchTransactions).toBe('function');
    });

    test(`${institutionCode} does not claim another chain's code`, async () => {
      const registry = await registerFresh(factory);
      const other = institutionCode === 'bitcoin' ? 'ton' : 'bitcoin';
      expect(registry.getTransactionsFetcher(other)).toBeNull();
    });
  }
});
