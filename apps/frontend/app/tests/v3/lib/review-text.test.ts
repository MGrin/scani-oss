import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import i18n from 'i18next';
import {
  type ReviewTexts,
  type ReviewWireRow,
  reviewDetailText,
  reviewTitle,
  toReviewRow,
  v3ReviewTexts,
} from '../../../src/v3/lib/review-text';

/**
 * The review feed's words, now that the server has stopped sending them
 * (SC-371).
 *
 * The claim is that nothing on /review reads differently: every string below
 * is the string `ReviewFeedService` and `reviewDetail.ts` produced before the
 * move — same counts, same pluralisation, same `·` and `—`.
 *
 * It used to assert a second thing beside it. The classic interface could not
 * reach a `v3.*` key — those are registered by the v3 chunk alone — so it
 * carried its own English table, and the last suite in this file pinned the
 * two equal key for key and word for word so a wording change to one could not
 * ship without the other. The comment on that suite said to delete it with
 * `src/v2/pages/ReviewPage.tsx`; SC-423 deleted both, and one source is left.
 */

const v3 = v3ReviewTexts(i18n.t.bind(i18n));

/** Reads one composition, so a case can be written the way it is read. */
function detail(texts: (t: ReviewTexts) => string | null): string | null {
  return texts(v3);
}

const wire = (over: Partial<ReviewWireRow> = {}): ReviewWireRow => ({
  id: 'job:abc',
  kind: 'screenshot-parse',
  label: { code: 'job', jobName: 'screenshot-parse' },
  href: '/jobs/abc',
  createdAt: '2026-08-10T09:00:00.000Z',
  ...over,
});

describe('reviewTitle', () => {
  test('a pending job is named by the job-label table', () => {
    expect(reviewTitle(v3, { code: 'job', jobName: 'wallet-import' })).toBe('Wallet import');
    expect(reviewTitle(v3, { code: 'job', jobName: 'screenshot-parse' })).toBe('Document parse');
  });

  test('an unknown job name reads as itself rather than as "Background task"', () => {
    expect(reviewTitle(v3, { code: 'job', jobName: 'refund-reconcile' })).toBe('refund-reconcile');
  });

  test('a dead job says which job died', () => {
    expect(reviewTitle(v3, { code: 'jobFailed', jobName: 'wallet-import' })).toBe(
      'Wallet import failed'
    );
  });

  test('the producers with one fixed name keep it', () => {
    expect(reviewTitle(v3, { code: 'invoiceExtracted' })).toBe('Invoice extracted');
    expect(reviewTitle(v3, { code: 'transfersToConfirm' })).toBe('Transfers to confirm');
    expect(reviewTitle(v3, { code: 'balanceChangesToExplain' })).toBe('Balance changes to explain');
  });
});

describe('reviewDetailText — screenshot-parse', () => {
  const holdings = (count: number, symbols: string[]) =>
    detail((texts) =>
      reviewDetailText(texts, { code: 'parsedHoldings', holdings: count, symbols })
    );

  test('names the single holding a screenshot import found', () => {
    expect(holdings(1, ['GBP'])).toBe('1 holding · GBP');
  });

  test('counts and lists distinct symbols', () => {
    expect(holdings(3, ['RUB', 'USD'])).toBe('3 holdings · RUB, USD');
  });

  test('caps the symbol list so a long row stays readable', () => {
    expect(holdings(6, ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'])).toBe(
      '6 holdings · AAA, BBB, CCC +3'
    );
  });

  test('a holding with no symbol is still counted', () => {
    expect(holdings(1, [])).toBe('1 holding');
  });
});

describe('reviewDetailText — file-import', () => {
  const needsCurrency = (transactions: number, fileType?: string) =>
    detail((texts) =>
      reviewDetailText(texts, { code: 'transactionsNeedCurrency', transactions, fileType })
    );

  test('describes the pending currency choice', () => {
    expect(needsCurrency(42, 'csv')).toBe('42 transactions · CSV — needs a currency');
  });

  test('handles a single transaction without pluralising', () => {
    expect(needsCurrency(1, 'ofx')).toBe('1 transaction · OFX — needs a currency');
  });

  test('omits the file type when the row has none', () => {
    expect(needsCurrency(7)).toBe('7 transactions — needs a currency');
  });
});

describe('reviewDetailText — wallet-import', () => {
  const wallet = (candidates: number, chains: number, walletLabel?: string) =>
    detail((texts) =>
      reviewDetailText(texts, { code: 'walletCandidates', candidates, chains, walletLabel })
    );

  test('names the wallet and how much was found', () => {
    expect(wallet(5, 2, 'TUCfdE...Lf88')).toBe('TUCfdE...Lf88 · 5 candidates across 2 chains');
  });

  test('reports an empty sweep rather than pretending it found something', () => {
    expect(wallet(0, 0, 'TUCfdE...Lf88')).toBe('TUCfdE...Lf88 · nothing found');
  });

  test('falls back to the counts when the wallet has no label', () => {
    expect(wallet(3, 1)).toBe('3 candidates across 1 chain');
  });
});

describe('reviewDetailText — the other producers', () => {
  test('an invoice reads as its vendor, which no table can translate', () => {
    expect(
      detail((texts) => reviewDetailText(texts, { code: 'vendor', name: 'Albert Heijn' }))
    ).toBe('Albert Heijn');
  });

  test('the transfer queue counts what is waiting, singular and plural', () => {
    expect(detail((t) => reviewDetailText(t, { code: 'unpairedTransfers', transfers: 12 }))).toBe(
      '12 transfers out with no matching deposit'
    );
    expect(detail((t) => reviewDetailText(t, { code: 'unpairedTransfers', transfers: 1 }))).toBe(
      '1 transfer out with no matching deposit'
    );
  });

  test('the balance-gap queue counts what is waiting, singular and plural', () => {
    // Asserted through the shipped `en.json`, so a key that does not exist
    // fails here rather than rendering its own name on the home screen —
    // which is the only way a missing translation surfaces in this codebase.
    expect(
      detail((t) => reviewDetailText(t, { code: 'unexplainedBalanceChanges', changes: 37 }))
    ).toBe('37 balance changes we cannot explain');
    expect(
      detail((t) => reviewDetailText(t, { code: 'unexplainedBalanceChanges', changes: 1 }))
    ).toBe('1 balance change we cannot explain');
  });

  /**
   * The dead-job line comes from `describeJobFailure` in @scani/shared — the
   * one description of a failure, already shared by both frontends' job pages.
   * The feed forwards the facts so this row cannot call a failure something
   * its own detail page does not, and so it inherits SC-369's keys whenever
   * that describer's English becomes keys.
   */
  test('a dead job is explained by the shared describer, not by this table', () => {
    const failure = {
      code: 'jobFailure' as const,
      facts: {
        state: 'failed',
        deadAt: '2026-08-14T12:00:00.000Z',
        failureReason: 'retries_exhausted',
        attemptsMade: 3,
        attemptsAllowed: 3,
      },
    };
    expect(detail((texts) => reviewDetailText(texts, failure))).toBe(
      'This was tried 3 times and failed every time. It will not be tried again on its own.'
    );
  });

  test('nothing to say is null, not an empty row', () => {
    expect(detail((texts) => reviewDetailText(texts, undefined))).toBeNull();
  });
});

describe('toReviewRow', () => {
  test('the figure becomes a number exactly once, on its way to the value column', () => {
    const row = toReviewRow(v3, wire({ amount: { value: '87.31', currency: 'EUR' } }));
    expect(row.amount).toEqual({ value: 87.31, currency: 'EUR' });
  });

  test('a figure that is not one is dropped rather than rendered as NaN', () => {
    const row = toReviewRow(v3, wire({ amount: { value: 'lots', currency: 'EUR' } }));
    expect(row.amount).toBeNull();
  });

  test('the searchable text is what the row shows, digits included', () => {
    // `42.50` was searchable when it was spelled into the subtitle; a float
    // would have made it `42.5` and quietly stopped matching.
    const row = toReviewRow(
      v3,
      wire({
        label: { code: 'invoiceExtracted' },
        detail: { code: 'vendor', name: 'Albert Heijn' },
        amount: { value: '42.50', currency: 'USD' },
      })
    );
    expect(row.search).toBe('Invoice extracted Albert Heijn 42.50 USD');
  });
});
