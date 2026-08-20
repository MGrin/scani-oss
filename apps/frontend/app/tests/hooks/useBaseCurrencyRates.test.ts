import { describe, expect, test } from 'bun:test';
import { resolveStatus, type StatusInputs } from '../../src/hooks/useBaseCurrencyRates';

/**
 * What the app is entitled to claim about its own FX rates (SC-210).
 *
 * The component tests cover what each answer looks like on screen; this covers
 * which answer is true, which is the part a static render cannot reach. Two of
 * these branches are the bug: a query that never ran and a query that failed
 * both used to be indistinguishable from a query that came back empty.
 */

const inputs = (over: Partial<StatusInputs> = {}): StatusInputs => ({
  baseCurrencyLoading: false,
  baseCurrencyTokenId: 'token-usd',
  requestedCount: 2,
  failed: false,
  answered: true,
  ...over,
});

describe('resolveStatus', () => {
  test('rates in hand are ready', () => {
    expect(resolveStatus(inputs())).toBe('ready');
  });

  test('the base currency still loading holds everything back', () => {
    // There is no "convert into" yet, so even a full rate map means nothing.
    expect(resolveStatus(inputs({ baseCurrencyLoading: true, answered: true }))).toBe('loading');
  });

  test('a settled query with no base currency is unavailable, not loading', () => {
    // The distinction that stops a permanent skeleton: `users.getBaseCurrency`
    // has answered and had nothing. Waiting for it is waiting for nothing.
    expect(resolveStatus(inputs({ baseCurrencyTokenId: null, answered: false }))).toBe(
      'unavailable'
    );
  });

  test('nothing foreign on screen is ready, not loading', () => {
    // React Query v4 reports a DISABLED query as `status: 'loading'` forever.
    // Believing it would put a skeleton over the figure of every single-
    // currency user — the majority — and never take it off.
    expect(resolveStatus(inputs({ requestedCount: 0, answered: false }))).toBe('ready');
  });

  test('a failed rates query is unavailable', () => {
    expect(resolveStatus(inputs({ failed: true, answered: false }))).toBe('unavailable');
  });

  test('a query in flight is loading', () => {
    expect(resolveStatus(inputs({ answered: false }))).toBe('loading');
  });

  test('a failure outranks stale data from a previous key', () => {
    // `answered` can be true from an earlier fetch while the current one has
    // errored; the honest answer is that the map on hand is not the answer.
    expect(resolveStatus(inputs({ failed: true, answered: true }))).toBe('unavailable');
  });
});
