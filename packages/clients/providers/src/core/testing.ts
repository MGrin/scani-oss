// Shared test helpers used by every test file under tests/. The four
// pieces (createMockContext, makeMockToken, assertImplementsCapability,
// replayHttp) cover the patterns that recur across every provider test.

import type { Token } from '@scani/db/schema';
import type { DecryptedCredentials, ProviderContext, WithUserCreds } from './types';

/**
 * Build a minimal but type-correct `ProviderContext` for tests.
 *
 * `baseCurrency` is required (real callers always have one); we mint
 * a synthetic Token row from the supplied symbol so callers don't have
 * to assemble Drizzle types in every test. Override fields by spreading
 * over the result.
 */
function createMockContext(
  options: {
    baseCurrencySymbol?: string;
    baseCurrencyId?: string;
    timestamp?: Date;
    userId?: string;
    accountId?: string;
    /** When set, the context becomes self-credentialed. */
    credentials?: DecryptedCredentials;
    institutionId?: string;
  } = {}
): ProviderContext {
  const baseCurrency = makeMockToken({
    id: options.baseCurrencyId ?? '00000000-0000-4000-8000-base000000000',
    symbol: options.baseCurrencySymbol ?? 'USD',
    name: options.baseCurrencySymbol ?? 'United States Dollar',
  });

  const ctx: ProviderContext = {
    baseCurrency,
    timestamp: options.timestamp,
    userId: options.userId,
    accountId: options.accountId,
  };

  if (options.credentials) {
    const userId = options.userId ?? 'test-user';
    const institutionId = options.institutionId ?? 'test-institution';
    ctx.credentialsRef = { userId, institutionId };
    ctx.resolveCredentials = async (ref) => {
      if (ref.userId !== userId || ref.institutionId !== institutionId) {
        throw new Error(
          `mock resolveCredentials called with unexpected ref: ${JSON.stringify(ref)}`
        );
      }
      return options.credentials!;
    };
  }

  return ctx;
}

/**
 * Self-credentialed variant. Returns a context branded as
 * `WithUserCreds<ProviderContext>` so it satisfies the type-level
 * requirement of `BalanceProvider` / `TransactionsProvider` methods.
 *
 * `credentials` is required because the brand asserts presence at
 * compile time — callers can't accidentally produce a "self-cred"
 * context that's actually pool-cred.
 */
export function createMockSelfCredContext(options: {
  credentials: DecryptedCredentials;
  baseCurrencySymbol?: string;
  baseCurrencyId?: string;
  timestamp?: Date;
  userId?: string;
  accountId?: string;
  institutionId?: string;
}): WithUserCreds<ProviderContext> {
  const ctx = createMockContext(options);
  // Type-narrow: credentialsRef + resolveCredentials are both
  // populated by createMockContext when `credentials` is set.
  return ctx as WithUserCreds<ProviderContext>;
}

/**
 * Build a synthetic `Token` row. Defaults match a fungible crypto.
 * Override fields per-test by spreading `over` last.
 */
export function makeMockToken(over: Partial<Token> = {}): Token {
  const now = new Date('2024-01-01T00:00:00Z');
  return {
    id: '00000000-0000-4000-8000-token0000000',
    symbol: 'BTC',
    name: 'Bitcoin',
    typeId: '00000000-0000-4000-8000-type0000crypto',
    decimals: 8,
    decimalsSource: 'chain',
    marketSegment: null,
    iconUrl: null,
    providerMetadata: {},
    isScamProbability: 0,
    scamScoreVersion: null,
    scamScoreSource: 'heuristic',
    lookalikeOf: null,
    createdByUserId: null,
    isActive: true,
    unpriceableUntil: null,
    lastPricingAttemptAt: null,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}
