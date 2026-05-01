// Shared test helpers used by every test file under tests/. The four
// pieces (createMockContext, makeMockToken, assertImplementsCapability,
// replayHttp) cover the patterns that recur across every provider test.

import type { NewToken, Token } from '@scani/db/schema';
import type {
  AccountDiscoveryProvider,
  AddressValidatorProvider,
  AIInferenceProvider,
  BalanceProvider,
  Capability,
  CurrentPriceProvider,
  HistoricalPriceProvider,
  ProviderBase,
  TokenIdentityProvider,
  TransactionsProvider,
} from './capabilities';
import {
  isAccountDiscoveryProvider,
  isAddressValidatorProvider,
  isAIInferenceProvider,
  isBalanceProvider,
  isCredentialValidator,
  isCurrentPriceProvider,
  isHistoricalPriceProvider,
  isTokenIdentityProvider,
  isTransactionsProvider,
} from './capabilities';
import type { DecryptedCredentials, ProviderContext, WithUserCreds } from './types';

/**
 * Build a minimal but type-correct `ProviderContext` for tests.
 *
 * `baseCurrency` is required (real callers always have one); we mint
 * a synthetic Token row from the supplied symbol so callers don't have
 * to assemble Drizzle types in every test. Override fields by spreading
 * over the result.
 */
export function createMockContext(
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
    marketSegment: null,
    iconUrl: null,
    providerMetadata: {},
    isScamProbability: 0,
    isActive: true,
    createdAt: now,
    updatedAt: now,
    ...over,
  };
}

/**
 * Build a synthetic `Partial<NewToken>` for identity-flow tests.
 */
export function makeMockTokenIdentity(over: Partial<NewToken> = {}): Partial<NewToken> {
  return {
    symbol: 'BTC',
    name: 'Bitcoin',
    decimals: 8,
    providerMetadata: {},
    ...over,
  };
}

/**
 * Throw if `provider` doesn't satisfy the duck-typed guards for
 * `capability`. Catches typos (`fetchCurrentPrice` vs `fetchPrice`)
 * before they become "no current pricer registered" runtime
 * surprises.
 */
export function assertImplementsCapability(provider: object, capability: Capability): void {
  const ok = matchesCapability(provider, capability);
  if (!ok) {
    const key = (provider as ProviderBase).providerKey ?? '<unknown>';
    throw new Error(
      `Provider '${key}' does not satisfy capability '${capability}' — ` +
        `check that the corresponding methods are present on the class. ` +
        `See core/capabilities.ts for the duck-typed guard contract.`
    );
  }
}

function matchesCapability(provider: object, capability: Capability): boolean {
  switch (capability) {
    case 'current-price':
      return isCurrentPriceProvider(provider);
    case 'historical-price':
      return isHistoricalPriceProvider(provider);
    case 'current-balances':
      return isBalanceProvider(provider);
    case 'transactions':
      return isTransactionsProvider(provider);
    case 'token-identity':
      return isTokenIdentityProvider(provider);
    case 'credential-validator':
      return isCredentialValidator(provider);
    case 'ai-inference':
      return isAIInferenceProvider(provider);
    case 'account-discoverer':
      return isAccountDiscoveryProvider(provider);
    case 'address-validator':
      return isAddressValidatorProvider(provider);
  }
}

/** Type narrowing helper used inside tests. */
export function asCurrentPriceProvider(p: object): CurrentPriceProvider {
  if (!isCurrentPriceProvider(p)) {
    throw new Error('Expected CurrentPriceProvider');
  }
  return p;
}
export function asHistoricalPriceProvider(p: object): HistoricalPriceProvider {
  if (!isHistoricalPriceProvider(p)) {
    throw new Error('Expected HistoricalPriceProvider');
  }
  return p;
}
export function asBalanceProvider(p: object): BalanceProvider {
  if (!isBalanceProvider(p)) {
    throw new Error('Expected BalanceProvider');
  }
  return p;
}
export function asTransactionsProvider(p: object): TransactionsProvider {
  if (!isTransactionsProvider(p)) {
    throw new Error('Expected TransactionsProvider');
  }
  return p;
}
export function asTokenIdentityProvider(p: object): TokenIdentityProvider {
  if (!isTokenIdentityProvider(p)) {
    throw new Error('Expected TokenIdentityProvider');
  }
  return p;
}
export function asAIInferenceProvider(p: object): AIInferenceProvider {
  if (!isAIInferenceProvider(p)) {
    throw new Error('Expected AIInferenceProvider');
  }
  return p;
}
export function asAccountDiscoveryProvider(p: object): AccountDiscoveryProvider {
  if (!isAccountDiscoveryProvider(p)) {
    throw new Error('Expected AccountDiscoveryProvider');
  }
  return p;
}
export function asAddressValidatorProvider(p: object): AddressValidatorProvider {
  if (!isAddressValidatorProvider(p)) {
    throw new Error('Expected AddressValidatorProvider');
  }
  return p;
}

/**
 * Single-use mock fetch from a recorded fixture. Returns a function
 * with the `globalThis.fetch` signature. The first call returns the
 * fixture's body wrapped in a `Response`; any subsequent call (or a
 * URL mismatch when `expectUrlPattern` is supplied) throws — fixture
 * tests should be deterministic, and a swallow-all mock hides genuine
 * over-fetching bugs.
 */
export function replayHttp(fixture: {
  body: string | object;
  status?: number;
  headers?: Record<string, string>;
  expectUrlPattern?: RegExp;
}): typeof fetch {
  let consumed = false;
  const body = typeof fixture.body === 'string' ? fixture.body : JSON.stringify(fixture.body);
  const fn = async (input: unknown, _init?: unknown): Promise<Response> => {
    if (consumed) {
      throw new Error(
        'replayHttp: fixture already consumed — provider issued more requests than expected'
      );
    }
    if (fixture.expectUrlPattern) {
      const url = typeof input === 'string' ? input : String(input);
      if (!fixture.expectUrlPattern.test(url)) {
        throw new Error(
          `replayHttp: URL "${url}" did not match expected pattern ${fixture.expectUrlPattern}`
        );
      }
    }
    consumed = true;
    return new Response(body, {
      status: fixture.status ?? 200,
      headers: fixture.headers ?? { 'content-type': 'application/json' },
    });
  };
  return fn as typeof fetch;
}
