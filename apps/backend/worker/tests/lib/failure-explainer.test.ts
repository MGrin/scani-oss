import { describe, expect, test } from 'bun:test';
import { ProviderError } from '@scani/providers/core/errors';
import { ProviderFailureExplainer } from '../../src/lib/failure-explainer';

/**
 * SC-1711. A Bitcoin refresh failed on blockchain.info's 429 and its page
 * gave no reason. The explainer names the provider and what happened in its
 * own words, and the provider's text never reaches the owner (SC-551).
 */

const explainer = new ProviderFailureExplainer();
const RAW = 'bitcoin HTTP 429 — Rate limited';

describe('ProviderFailureExplainer (SC-1711)', () => {
  test('a rate-limited provider error names the provider and the limit', () => {
    const reason = explainer.explain(new ProviderError(RAW, 'rate-limited', 'bitcoin'));
    expect(reason).toContain('Bitcoin');
    expect(reason).toContain('limiting');
    expect(reason).not.toContain(RAW);
  });

  test('a use case wrapping the provider error as its cause is still explained', () => {
    const wrapped = new Error('Balance refresh failed for account a1', {
      cause: new ProviderError(RAW, 'rate-limited', 'bitcoin'),
    });
    expect(explainer.explain(wrapped)).toContain('limiting');
  });

  test('rejected credentials say to reconnect', () => {
    const reason = explainer.explain(new ProviderError('kraken HTTP 401', 'auth-failed', 'kraken'));
    expect(reason).toContain('Kraken');
    expect(reason).toContain('Reconnect');
  });

  test('a provider outage says to try again later', () => {
    const reason = explainer.explain(new ProviderError('bitcoin HTTP 503', 'retryable', 'bitcoin'));
    expect(reason).toContain('did not answer');
  });

  test('CONTROL: an error that is not a provider error gets no explanation', () => {
    expect(explainer.explain(new Error('Failed query: select "id" from "holdings"'))).toBeNull();
    expect(explainer.explain('a string')).toBeNull();
  });

  test('a provider error the owner cannot act on gets no explanation', () => {
    expect(
      explainer.explain(new ProviderError('no such token', 'not-supported', 'coingecko'))
    ).toBeNull();
  });
});
