// Helpers for tRPC router tests. Builds the minimal `DataProviderContext`
// each procedure expects, plus a stub-DI helper for swapping the
// process-global typedi container's `ProviderRegistry` per test.

import { ProviderRegistry } from '@scani/providers/core/registry';
import { Container } from 'typedi';
// This workspace cannot depend on @scani/domain (it sits below it), so the
// shared helper is reached the same way the shared test preload is: by path.
import { snapshotContainer } from '../../../../../packages/business/domain/test/helpers/container';
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
      internal: true,
    },
    authFailure: null,
    cloudUser: null,
    requestId: 'test-request',
    usage: createUsageContext(),
    clientIp: null,
    ...overrides,
  };
}

/**
 * A CUSTOMER's bearer context — a `cloud_api_keys` row on a plan a signup
 * can actually reach. `internal: false` is the whole point: this is the
 * caller SC-585 found reading, overwriting and deleting other tenants'
 * objects, and `internalProcedure` must refuse it.
 */
export function buildCustomerContext(
  overrides: Partial<DataProviderContext> = {}
): DataProviderContext {
  return {
    ...buildAuthedContext(),
    auth: {
      apiKeyId: '00000000-0000-4000-8000-00000000cafe',
      tenantId: 'customer-tenant',
      ownerUserId: '00000000-0000-4000-8000-00000000beef',
      tier: 'managed',
      internal: false,
    },
    ...overrides,
  };
}

export function buildUnauthedContext(
  overrides: Partial<DataProviderContext> = {}
): DataProviderContext {
  return {
    auth: null,
    authFailure: null,
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
  // Snapshot rather than re-`set` the previous instance: a restore written as
  // `Container.set(id, real)` is itself a write that outlives the file, which
  // is indistinguishable from the leak it was meant to undo (SC-448).
  const restore = snapshotContainer();
  const registry = new ProviderRegistry();
  Container.set(ProviderRegistry, registry);
  return { registry, restore };
}
