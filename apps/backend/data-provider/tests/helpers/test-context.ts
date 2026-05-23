// Helpers for tRPC router tests. Builds the minimal `DataProviderContext`
// each procedure expects, plus a stub-DI helper for swapping the
// process-global typedi container's `ProviderRegistry` per test.

import { ProviderRegistry } from '@scani/providers/core/registry';
import { Container } from 'typedi';
import { OSS_KEY_ID } from '../../src/auth/api-key';
import type { DataProviderContext } from '../../src/presentation/trpc';
import { createUsageContext } from '../../src/usage/middleware';

export function buildAuthedContext(
  overrides: Partial<DataProviderContext> = {}
): DataProviderContext {
  return {
    auth: {
      apiKeyId: OSS_KEY_ID,
      tenantId: 'test',
      ownerUserId: null,
      tier: 'oss',
    },
    cloudUser: null,
    requestId: 'test-request',
    usage: createUsageContext(),
    clientIp: null,
    ...overrides,
  };
}

export function buildUnauthedContext(
  overrides: Partial<DataProviderContext> = {}
): DataProviderContext {
  return {
    auth: null,
    cloudUser: null,
    requestId: 'test-request',
    usage: createUsageContext(),
    clientIp: null,
    ...overrides,
  };
}

// Replace the process-global ProviderRegistry with a fresh one. Pass
// providers via `register()` on the returned registry. Call
// `restoreRegistry()` in `afterEach` so a later suite gets a clean slate.
export function installFreshRegistry(): {
  registry: ProviderRegistry;
  restore: () => void;
} {
  const previous = (() => {
    try {
      return Container.get(ProviderRegistry);
    } catch {
      return null;
    }
  })();
  const registry = new ProviderRegistry();
  Container.set(ProviderRegistry, registry);
  return {
    registry,
    restore: () => {
      if (previous) {
        Container.set(ProviderRegistry, previous);
      } else {
        Container.set(ProviderRegistry, new ProviderRegistry());
      }
    },
  };
}
