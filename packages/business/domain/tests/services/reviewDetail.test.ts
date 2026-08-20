import { describe, expect, test } from 'bun:test';
import { reviewDetailSchema } from '@scani/shared';
import { describePendingReview } from '../../src/services/reviewDetail';

// Without a second line, two same-day imports render as identical rows —
// "Screenshot import / 5/18/2026" twice — and the user cannot tell which
// is which or decide which to open. Seen in the browser on 2026-08-11.
//
// All THREE reviewable kinds need one. The first version covered only
// screenshot-parse while claiming file-import too, and the file-import
// branch was unreachable because it looked for a holdings shape that kind
// never produces. Each kind below is pinned to the shape its worker
// actually returns.
//
// What they return is the *operands* (SC-371). The sentence they used to
// return is asserted where it is now composed, in
// `apps/frontend/app/tests/v3/lib/review-text.test.ts` — including that it
// still reads exactly as it did here.

const screenshotResult = (holdings: Array<{ symbol?: string }>) => ({
  results: [{ data: { holdings, detectedCurrency: holdings[0]?.symbol, overallConfidence: 0.9 } }],
});

describe('describePendingReview — screenshot-parse', () => {
  test('names the single holding a screenshot import found', () => {
    expect(
      describePendingReview('screenshot-parse', screenshotResult([{ symbol: 'GBP' }]))
    ).toEqual({ code: 'parsedHoldings', holdings: 1, symbols: ['GBP'] });
  });

  test('counts every holding but names each symbol once', () => {
    expect(
      describePendingReview(
        'screenshot-parse',
        screenshotResult([{ symbol: 'RUB' }, { symbol: 'RUB' }, { symbol: 'USD' }])
      )
    ).toEqual({ code: 'parsedHoldings', holdings: 3, symbols: ['RUB', 'USD'] });
  });

  test('hands over every symbol it found, capped by nobody here', () => {
    // Which three to show and how to say "+3" is a decision about a 390px
    // row, so it belongs to the interface that has one — this side would be
    // deciding it for readers it cannot see.
    const many = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'].map((symbol) => ({ symbol }));
    expect(describePendingReview('screenshot-parse', screenshotResult(many))).toEqual({
      code: 'parsedHoldings',
      holdings: 6,
      symbols: ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'],
    });
  });

  test('still counts a holding that carries no symbol', () => {
    // An unnamed holding is still one the user has to review, so the count
    // is worth showing even when there is nothing to name it by.
    expect(
      describePendingReview('screenshot-parse', { results: [{ data: { holdings: [{}] } }] })
    ).toEqual({ code: 'parsedHoldings', holdings: 1, symbols: [] });
  });

  test('aggregates holdings across multiple results in one job', () => {
    expect(
      describePendingReview('screenshot-parse', {
        results: [
          { data: { holdings: [{ symbol: 'EUR' }] } },
          { data: { holdings: [{ symbol: 'GBP' }] } },
        ],
      })
    ).toEqual({ code: 'parsedHoldings', holdings: 2, symbols: ['EUR', 'GBP'] });
  });
});

describe('describePendingReview — file-import', () => {
  // The worker auto-stamps action_taken_at on every file-import path
  // EXCEPT the needsCurrency early return, so this is the only shape that
  // can ever reach the review feed.
  test('describes the pending currency choice', () => {
    expect(
      describePendingReview('file-import', {
        needsCurrency: {
          r2Key: 'k',
          fileType: 'csv',
          transactionCount: 42,
          transactionPreview: [],
        },
      })
    ).toEqual({ code: 'transactionsNeedCurrency', transactions: 42, fileType: 'csv' });
  });

  test('passes the file type through as recorded, not as displayed', () => {
    expect(
      describePendingReview('file-import', {
        needsCurrency: { fileType: 'ofx', transactionCount: 1, transactionPreview: [] },
      })
    ).toEqual({ code: 'transactionsNeedCurrency', transactions: 1, fileType: 'ofx' });
  });

  test('omits the file type when the shape lacks one', () => {
    expect(
      describePendingReview('file-import', { needsCurrency: { transactionCount: 7 } })
    ).toEqual({ code: 'transactionsNeedCurrency', transactions: 7, fileType: undefined });
  });
});

describe('describePendingReview — wallet-import', () => {
  // Shape pinned to what the worker returns on its needsReview path.
  test('names the wallet and how much was found', () => {
    expect(
      describePendingReview('wallet-import', {
        needsReview: true,
        walletLabel: 'TUCfdE...Lf88',
        chainsDetected: 2,
        candidateCount: 5,
      })
    ).toEqual({
      code: 'walletCandidates',
      walletLabel: 'TUCfdE...Lf88',
      candidates: 5,
      chains: 2,
    });
  });

  test('reports an empty sweep rather than pretending it found something', () => {
    // A real row on the branch DB: a wallet whose sweep detected nothing.
    // Zero is the fact that says so — it tells the user why there is nothing
    // to import without opening the job.
    expect(
      describePendingReview('wallet-import', {
        walletLabel: 'TUCfdE...Lf88',
        chainsDetected: 0,
        candidateCount: 0,
      })
    ).toEqual({
      code: 'walletCandidates',
      walletLabel: 'TUCfdE...Lf88',
      candidates: 0,
      chains: 0,
    });
  });

  test('falls back to the counts when the wallet has no label', () => {
    expect(
      describePendingReview('wallet-import', { chainsDetected: 1, candidateCount: 3 })
    ).toEqual({ code: 'walletCandidates', walletLabel: undefined, candidates: 3, chains: 1 });
  });
});

describe('describePendingReview — what it returns is on the wire contract', () => {
  test('every shape it produces validates as a ReviewDetail', () => {
    const produced = [
      describePendingReview('screenshot-parse', screenshotResult([{ symbol: 'BTC' }])),
      describePendingReview('file-import', { needsCurrency: { transactionCount: 2 } }),
      describePendingReview('wallet-import', { chainsDetected: 1, candidateCount: 0 }),
    ];
    for (const detail of produced) {
      expect(() => reviewDetailSchema.parse(detail)).not.toThrow();
    }
  });
});

describe('describePendingReview — must never throw on an unexpected shape', () => {
  // This runs on a read path that renders the page. A reader that throws
  // takes down the whole feed, which is far worse than a missing second line.
  const junk: unknown[] = [
    null,
    undefined,
    {},
    { results: null },
    { results: [] },
    { results: [{}] },
    { results: [{ data: {} }] },
    { results: [{ data: { holdings: null } }] },
    { results: [{ data: { holdings: [] } }] },
    { results: 'not-an-array' },
    { needsCurrency: null },
    { needsCurrency: {} },
    { needsCurrency: { transactionCount: 'lots' } },
    'a string',
    42,
    [],
  ];

  for (const kind of ['screenshot-parse', 'file-import', 'wallet-import']) {
    for (const [i, value] of junk.entries()) {
      test(`${kind} shape ${i} returns undefined rather than throwing`, () => {
        let out: unknown;
        expect(() => {
          out = describePendingReview(kind, value);
        }).not.toThrow();
        expect(out).toBeUndefined();
      });
    }
  }

  test('a job kind with no reader yields no detail rather than a guess', () => {
    expect(describePendingReview('exchange-import', screenshotResult([{ symbol: 'BTC' }]))).toBe(
      undefined
    );
  });
});
