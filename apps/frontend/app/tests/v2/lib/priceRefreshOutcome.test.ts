import { describe, expect, test } from 'bun:test';
import { describePriceRefresh } from '../../../src/v2/lib/priceRefreshOutcome';

/**
 * SC-148. The job's `success: true` meant "a price came back", and both shells
 * translated it into "BTC price refreshed" — over a price line that still read
 * `25m ago`, one row below, on the same screen.
 */

const now = new Date().toISOString();
const twentyFiveMinutesAgo = new Date(Date.now() - 25 * 60 * 1000).toISOString();

describe('describePriceRefresh', () => {
  test('a price that was actually fetched is the only thing called an update', () => {
    const outcome = describePriceRefresh({ price: '62817', fetched: true, timestamp: now }, 'BTC');
    expect(outcome.kind).toBe('updated');
    expect(outcome.message).toBe('BTC price updated');
  });

  // The reported defect verbatim: the job honestly returned the cached value
  // and its 25-minute-old timestamp, and the toast claimed a refresh.
  test('a cache hit says nothing was fetched, and says how old', () => {
    const outcome = describePriceRefresh(
      { price: '62817', fetched: false, timestamp: twentyFiveMinutesAgo },
      'BTC'
    );
    expect(outcome.kind).toBe('already-current');
    expect(outcome.message).toBe('No new price for BTC — showing the one from 25m ago');
  });

  /**
   * `fetched: false` is reached two ways, and only one of them is fresh: a hit
   * inside the one-hour live window, and a stale fallback when every provider
   * declined. Verified live against a three-hour-old row. So the sentence must
   * not assert freshness at all — an earlier draft read "is already current —
   * fetched 3h ago", which contradicts itself in one breath and is the same
   * overclaim this whole function exists to delete.
   */
  test('a stale fallback does not get called current', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const outcome = describePriceRefresh(
      { price: '62817', fetched: false, timestamp: threeHoursAgo },
      'BTC'
    );
    expect(outcome.message).toBe('No new price for BTC — showing the one from 3h ago');
    expect(outcome.message).not.toInclude('current');
  });

  test('a cache hit with no timestamp still refuses to claim a refresh', () => {
    const outcome = describePriceRefresh({ price: '1', fetched: false }, 'BTC');
    expect(outcome.kind).toBe('already-current');
    expect(outcome.message).toBe('No new price for BTC — the stored one is unchanged');
  });

  // `success: true, price: null` — the job ran, no provider had a quote, and
  // the figure on screen did not move. This was the falsest of the three.
  test('no price at all is a failure, not a success', () => {
    const outcome = describePriceRefresh(
      { price: null, fetched: false, timestamp: now },
      'AIRDROP'
    );
    expect(outcome.kind).toBe('no-price');
    expect(outcome.message).toInclude('No provider had a price for AIRDROP');
    expect(outcome.message).toInclude('unchanged');
  });

  // `'price' in report`, not a loose null check: a result with no `price` key
  // is a shape this cannot read, and calling that "no provider had a quote"
  // would be its own false claim.
  test('an explicit null is the no-price case; an absent key is not', () => {
    expect(describePriceRefresh({ price: null, fetched: true }, 'BTC').kind).toBe('no-price');
    expect(describePriceRefresh({ fetched: true }, 'BTC').kind).toBe('updated');
  });

  // v2's detail page speaks about the holding it is already showing.
  test('with no symbol the sentence still reads', () => {
    expect(describePriceRefresh({ price: '1', fetched: true }, null).message).toBe(
      'The price updated'
    );
    expect(describePriceRefresh({ price: '1', fetched: false }, null).message).toBe(
      'No new price for this holding — the stored one is unchanged'
    );
  });

  /**
   * A job row written before `fetched` existed, or a result the caller could
   * not narrow. Reading it as "updated" is the pre-existing behaviour and the
   * only safe default — the alternative tells someone nothing happened when it
   * may have.
   */
  test.each([
    [null],
    [undefined],
    [{}],
  ])('an unreadable result %p degrades to updated', (report) => {
    expect(describePriceRefresh(report as Record<string, never> | null, 'BTC').kind).toBe(
      'updated'
    );
  });
});
