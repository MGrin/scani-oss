import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import { describePriceRefresh } from '../../../src/v3/lib/price-refresh-outcome';

const t = i18n.t.bind(i18n);

/**
 * SC-148. The job's `success: true` meant "a price came back", and both shells
 * translated it into "BTC price refreshed" — over a price line that still read
 * `25m ago`, one row below, on the same screen.
 *
 * Every assertion below is the sentence v2's version produced, unchanged. That
 * is the claim the move makes (SC-320) and the only one worth testing: the
 * keys are new, the English is not. `tests/v2/lib/priceRefreshOutcome.test.ts`
 * still guards the copy v2 renders until that tree is deleted.
 */

const now = new Date().toISOString();
const twentyFiveMinutesAgo = new Date(Date.now() - 25 * 60 * 1000).toISOString();

describe('describePriceRefresh', () => {
  test('a price that was actually fetched is the only thing called an update', () => {
    const outcome = describePriceRefresh(
      t,
      { price: '62817', fetched: true, timestamp: now },
      'BTC'
    );
    expect(outcome.kind).toBe('updated');
    expect(outcome.message).toBe('BTC price updated');
  });

  // The reported defect verbatim: the job honestly returned the cached value
  // and its 25-minute-old timestamp, and the toast claimed a refresh.
  test('a cache hit says nothing was fetched, and says how old', () => {
    const outcome = describePriceRefresh(
      t,
      { price: '62817', fetched: false, timestamp: twentyFiveMinutesAgo },
      'BTC'
    );
    expect(outcome.kind).toBe('already-current');
    expect(outcome.message).toBe('No new price for BTC — showing the one from 25m ago');
  });

  /**
   * `fetched: false` is reached two ways, and only one of them is fresh: a hit
   * inside the one-hour live window, and a stale fallback when every provider
   * declined. So the sentence must not assert freshness at all — an earlier
   * draft read "is already current — fetched 3h ago", which contradicts itself
   * in one breath and is the same overclaim this function exists to delete.
   */
  test('a stale fallback does not get called current', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const outcome = describePriceRefresh(
      t,
      { price: '62817', fetched: false, timestamp: threeHoursAgo },
      'BTC'
    );
    expect(outcome.message).toBe('No new price for BTC — showing the one from 3h ago');
    expect(outcome.message).not.toInclude('current');
  });

  test('a cache hit with no timestamp still refuses to claim a refresh', () => {
    const outcome = describePriceRefresh(t, { price: '1', fetched: false }, 'BTC');
    expect(outcome.kind).toBe('already-current');
    expect(outcome.message).toBe('No new price for BTC — the stored one is unchanged');
  });

  // `success: true, price: null` — the job ran, no provider had a quote, and
  // the figure on screen did not move. This was the falsest of the three.
  test('no price at all is a failure, not a success', () => {
    const outcome = describePriceRefresh(
      t,
      { price: null, fetched: false, timestamp: now },
      'AIRDROP'
    );
    expect(outcome.kind).toBe('no-price');
    expect(outcome.message).toBe(
      'No provider had a price for AIRDROP. The figure on screen is unchanged.'
    );
  });

  // `'price' in report`, not a loose null check: a result with no `price` key
  // is a shape this cannot read, and calling that "no provider had a quote"
  // would be its own false claim.
  test('an explicit null is the no-price case; an absent key is not', () => {
    expect(describePriceRefresh(t, { price: null, fetched: true }, 'BTC').kind).toBe('no-price');
    expect(describePriceRefresh(t, { fetched: true }, 'BTC').kind).toBe('updated');
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
    expect(describePriceRefresh(t, report as Record<string, never> | null, 'BTC').kind).toBe(
      'updated'
    );
  });

  // Every branch renders a sentence rather than the key it asked for — the
  // failure mode i18next makes silent, and the one a hand-written stub `t`
  // could never catch.
  test.each([
    [{ price: '1', fetched: true }],
    [{ price: '1', fetched: false }],
    [{ price: '1', fetched: false, timestamp: now }],
    [{ price: null }],
  ])('%p resolves against en.json rather than echoing a key', (report) => {
    expect(describePriceRefresh(t, report, 'BTC').message).not.toInclude('v3.holdings');
  });
});
