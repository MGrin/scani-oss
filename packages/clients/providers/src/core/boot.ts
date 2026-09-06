/**
 * `buildProviderRegistry()` — single entry point apps call at boot to
 * stand up the entire provider layer.
 *
 * The factory wires up:
 *
 *   1. **Rate-limiter Redis.** `setSharedRedis(redis)` so
 *      every `new RateLimiter(...)` constructed downstream routes
 *      through Redis (multi-worker coherence, no per-process budget
 *      drift).
 *
 *   2. **`RateLimiterRegistry`.** The central namespace map — every
 *      provider directory's `register()` call goes through it; boot
 *      fails loud on duplicate namespaces.
 *
 *   3. **`ProviderRegistry`.** Provider factories are run in order;
 *      each returns one or more provider instances which slot into
 *      the registry's capability buckets via duck-typed guards.
 *
 *   4. **`ProviderCredentialReport`.** Every factory with a keyless
 *      branch reports whether it resolved its platform credential, and
 *      boot emits ONE summary line naming the keyed set and the degraded
 *      set. Replaces the scattered per-factory `console.warn`s, which
 *      two of the seven degrading providers did not have at all (SC-536).
 *
 * The factory takes a `providers` array of `ProviderFactory`
 * functions rather than hard-coding the import list, so the apps'
 * composition roots choose which providers they stand up.
 *
 * Every app runs the real provider classes in-process. A second boot
 * mode that proxied pricing / AI / token-identity through the
 * data-provider over tRPC was built and never adopted; it was deleted
 * in SC-587 on mgrin's decision, so there is no `mode` parameter and
 * no alternative egress path to reason about.
 */

import { createComponentLogger } from '@scani/logging';
import { setSharedRedis } from '@scani/rate-limiter';
import type { Redis as IoRedis } from 'ioredis';
import { Container } from 'typedi';
import { ProviderCredentialReport, type ProviderCredentialStatus } from './credential-report';
import { RateLimiterRegistry } from './rate-limiter-registry';
import { ProviderRegistry } from './registry';

const logger = createComponentLogger('providers:boot');

/**
 * Per-provider factory function. Returns a provider instance (or
 * an array — Etherscan registers one provider per chain). The
 * factory may use the Redis handle for its rate-limiter; the env for
 * API keys; the rate-limiter registry for namespace registration.
 */
export interface ProviderFactoryDeps {
  redis: IoRedis | null;
  env: Record<string, string | undefined>;
  rateLimiterRegistry: RateLimiterRegistry;
  /**
   * Declare whether this factory resolved its platform credential.
   * A factory with a keyless branch MUST call this on BOTH paths — the
   * keyed report is what makes the boot summary a line that always prints
   * and changes content, rather than a warning nobody has ever seen.
   *
   * Not for user-credentialed providers (the CEXes, brokerages, Google
   * Sheets): their credentials are per-tenant and resolved at job time,
   * so there is nothing to report at boot.
   */
  reportCredentialStatus: (status: ProviderCredentialStatus) => void;
}

export type ProviderFactory = (deps: ProviderFactoryDeps) => Promise<object | readonly object[]>;

export interface BuildProviderRegistryOptions {
  /**
   * Redis client. Expected in every deployed process — the rate-limiter
   * must be Redis-backed for multi-worker coherence. Omitting it is
   * supported for tests and single-process CLI tools, and warns.
   */
  redis?: IoRedis | null;
  /** Process env (typically `Bun.env` or `process.env`). */
  env: Record<string, string | undefined>;
  /**
   * Ordered list of provider factories. Order = registration order
   * = dispatch priority. Cheap / public providers first, paid ones last.
   */
  providers: readonly ProviderFactory[];
}

export interface BuiltProviderRegistry {
  registry: ProviderRegistry;
  rateLimiterRegistry: RateLimiterRegistry;
  credentialReport: ProviderCredentialReport;
}

export async function buildProviderRegistry(
  opts: BuildProviderRegistryOptions
): Promise<BuiltProviderRegistry> {
  const redis = opts.redis ?? null;
  if (!redis) {
    // Running without Redis is supported (tests, single-process
    // CLI tools), but we warn so a misconfigured prod boot is loud
    // rather than silently per-process-rate-limiting.
    // eslint-disable-next-line no-console
    console.warn('buildProviderRegistry: no Redis — rate limits will be per-process only');
  }

  if (redis) {
    setSharedRedis(redis);
  }

  // Use the typedi-registered singletons. The instances are shared
  // across the app, so anything that injects them via class-field
  // `Container.get(...)` sees the same registry wiring this boot
  // produces.
  const rateLimiterRegistry = Container.get(RateLimiterRegistry);
  const registry = Container.get(ProviderRegistry);
  const credentialReport = Container.get(ProviderCredentialReport);
  // Singleton, and the test suite boots the registry many times in one
  // process — without this the second boot reports the first boot's
  // providers alongside its own.
  credentialReport.reset();

  const deps: ProviderFactoryDeps = {
    redis,
    env: opts.env,
    rateLimiterRegistry,
    reportCredentialStatus: (status) => credentialReport.record(status),
  };

  for (const factory of opts.providers) {
    const result = await factory(deps);
    const instances = Array.isArray(result) ? result : [result];
    for (const instance of instances) {
      registry.register(instance);
    }
  }

  // ALWAYS logged, healthy or not (SC-536). `warn` when something is
  // degraded so it sorts with the other things an operator should act on;
  // `info` otherwise, which every deployment runs at by default.
  const summary = credentialReport.summary();
  const degraded = credentialReport.degraded();
  if (degraded.length > 0) {
    logger.warn({ degraded: degraded.map((s) => s.envVar) }, `⚠️  ${summary}`);
  } else {
    logger.info(`✅ ${summary}`);
  }

  return { registry, rateLimiterRegistry, credentialReport };
}
