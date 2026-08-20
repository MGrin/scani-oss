import { describe, expect, test } from 'bun:test';
import { credentialRejection, ProviderError } from '../../src/core/errors';

/**
 * The line between "this key is wrong" and "we could not check" (SC-445).
 *
 * Every `validateCredentials` in this package ended in a catch-all that
 * answered `{ valid: false }` to both, and the connect form renders that as
 * "these details were rejected" — so a venue that was down told the reader to
 * go regenerate a credential that was fine. On IBKR, where 1025 counts failed
 * attempts, doing that is what sustains the lockout (SC-279).
 *
 * Only `auth-failed` is evidence: a service that recognised the request and
 * refused it. Everything else keeps travelling as a throw, with its `kind`
 * intact, for the api to turn into a sentence that makes no claim about the
 * credential.
 */
describe('credentialRejection', () => {
  test('an auth-failed ProviderError is a verdict, with the provider’s own words', () => {
    const err = new ProviderError('kraken HTTP 401 — EAPI:Invalid key', 'auth-failed', 'kraken');
    expect(credentialRejection(err)).toEqual({
      valid: false,
      message: 'kraken HTTP 401 — EAPI:Invalid key',
    });
  });

  test.each([
    'rate-limited',
    'retryable',
    'unrecoverable',
    'not-supported',
  ] as const)('a %s ProviderError is re-thrown rather than blamed on the credential', (kind) => {
    const err = new ProviderError(`something ${kind}`, kind, 'ibkr');
    expect(() => credentialRejection(err)).toThrow(err);
  });

  test('an unclassified throw is re-thrown — an unknown failure is not evidence', () => {
    const err = new Error('fetch failed');
    expect(() => credentialRejection(err)).toThrow(err);
  });

  test('the kind survives the re-throw, because the api maps on it', () => {
    const err = new ProviderError('IBKR Flex Query error (code 1025)', 'rate-limited', 'ibkr', {
      retryAfterMs: 86_400_000,
    });
    try {
      credentialRejection(err);
      throw new Error('expected a throw');
    } catch (caught) {
      expect(caught).toBeInstanceOf(ProviderError);
      expect((caught as ProviderError).kind).toBe('rate-limited');
      expect((caught as ProviderError).retryAfterMs).toBe(86_400_000);
    }
  });
});
