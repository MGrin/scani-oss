/**
 * Factory for `GoogleSheetsProvider`.
 *
 * Backend / worker boot calls `googleSheetsFactory(deps)` and then
 * registers the returned provider onto `ProviderRegistry`:
 *
 * ```ts
 * const gs = googleSheetsFactory({ db, redis, registry, rateLimiterRegistry });
 * registry.register(gs);
 * ```
 *
 * Different signature from the standard `ProviderFactory` — this one
 * takes a backend-specific `db` connection because GoogleSheets reads
 * per-user sheet config out of the DB. data-provider can't use this;
 * its registry stays Google-Sheets-free.
 */

import type { DbType } from '@scani/db/connection';
import { createComponentLogger } from '@scani/logging';
import type { RateLimiterRegistry } from '@scani/providers/core/rate-limiter-registry';
import { createOutflowLimiter, type OutflowRateLimiter } from '@scani/rate-limiter';
import type Redis from 'ioredis';
import { GoogleSheetsCurrencyConverter } from './currency-converter';
import { createFailureResult } from './failure-result';
import { GoogleSheetsProvider } from './google-sheets-provider';

export interface GoogleSheetsFactoryDeps {
  db: DbType;
  /** Optional Redis — when present, rate-limit buckets are
      Redis-coordinated; otherwise the in-memory fallback runs. */
  redis?: Redis | null;
  /** Same RateLimiterRegistry instance the rest of the providers tree
      registered against. Lets GoogleSheets share the `finnhub`
      namespace (and avoid double-budgeting against Finnhub's free
      tier) when the Finnhub provider is also registered. */
  rateLimiterRegistry: RateLimiterRegistry;
}

const GOOGLE_SHEETS_NAMESPACE = 'google-sheets';
const FINNHUB_NAMESPACE = 'finnhub';
const EXCHANGERATE_NAMESPACE = 'exchangerate-api';

function getOrRegister(
  registry: RateLimiterRegistry,
  namespace: string,
  redis: Redis | null | undefined,
  spec: { maxRequests: number; windowMs: number; description: string }
): OutflowRateLimiter {
  const existing = registry.get(namespace);
  if (existing) return existing;
  const limiter = createOutflowLimiter({
    maxRequests: spec.maxRequests,
    windowMs: spec.windowMs,
    redis: redis ?? undefined,
    namespace,
  });
  return registry.register({
    namespace,
    limiter,
    registeredFrom: 'providers-google-sheets',
    description: spec.description,
  });
}

export function googleSheetsFactory(deps: GoogleSheetsFactoryDeps): GoogleSheetsProvider {
  const sheetsLimiter = getOrRegister(
    deps.rateLimiterRegistry,
    GOOGLE_SHEETS_NAMESPACE,
    deps.redis,
    {
      maxRequests: 60,
      windowMs: 60 * 1000,
      description: 'Google Sheets API: 60 req / 60s',
    }
  );
  const finnhubLimiter = getOrRegister(deps.rateLimiterRegistry, FINNHUB_NAMESPACE, deps.redis, {
    maxRequests: 50,
    windowMs: 60 * 1000,
    description: 'Finnhub: 50 req / 60s',
  });
  const exchangeLimiter = getOrRegister(
    deps.rateLimiterRegistry,
    EXCHANGERATE_NAMESPACE,
    deps.redis,
    {
      maxRequests: 30,
      windowMs: 1000,
      description: 'ExchangeRate-API: ~30 rps',
    }
  );

  const converter = new GoogleSheetsCurrencyConverter(exchangeLimiter);

  return new GoogleSheetsProvider({
    db: deps.db,
    rateLimiter: sheetsLimiter,
    finnhubRateLimiter: finnhubLimiter,
    convertPrice: (price, from, to, at) => converter.convert(price, from, to, at),
    createFailureResult,
    logger: createComponentLogger('provider:google-sheets'),
  });
}
