import { describe, expect, test } from 'bun:test';
import { summarisePendingReview } from '../../src/services/reviewSummary';

// Without a subtitle, two same-day imports render as identical rows —
// "Screenshot import / 5/18/2026" twice — and the user cannot tell which
// is which or decide which to open. Seen in the browser on 2026-08-11.
//
// All THREE reviewable kinds need one. The first version covered only
// screenshot-parse while claiming file-import too, and the file-import
// branch was unreachable because it looked for a holdings shape that kind
// never produces. Each kind below is pinned to the shape its worker
// actually returns.

const screenshotResult = (holdings: Array<{ symbol?: string }>) => ({
  results: [{ data: { holdings, detectedCurrency: holdings[0]?.symbol, overallConfidence: 0.9 } }],
});

describe('summarisePendingReview — screenshot-parse', () => {
  test('names the single holding a screenshot import found', () => {
    expect(summarisePendingReview('screenshot-parse', screenshotResult([{ symbol: 'GBP' }]))).toBe(
      '1 holding · GBP'
    );
  });

  test('counts and lists distinct symbols', () => {
    const out = summarisePendingReview(
      'screenshot-parse',
      screenshotResult([{ symbol: 'RUB' }, { symbol: 'RUB' }, { symbol: 'USD' }])
    );
    expect(out).toBe('3 holdings · RUB, USD');
  });

  test('caps the symbol list so a long row stays readable', () => {
    const many = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'].map((symbol) => ({ symbol }));
    expect(summarisePendingReview('screenshot-parse', screenshotResult(many))).toBe(
      '6 holdings · AAA, BBB, CCC +3'
    );
  });

  test('still counts a holding that carries no symbol', () => {
    // An unnamed holding is still one the user has to review, so the count
    // is worth showing even when there is nothing to name it by.
    expect(
      summarisePendingReview('screenshot-parse', { results: [{ data: { holdings: [{}] } }] })
    ).toBe('1 holding');
  });

  test('aggregates holdings across multiple results in one job', () => {
    const out = summarisePendingReview('screenshot-parse', {
      results: [
        { data: { holdings: [{ symbol: 'EUR' }] } },
        { data: { holdings: [{ symbol: 'GBP' }] } },
      ],
    });
    expect(out).toBe('2 holdings · EUR, GBP');
  });
});

describe('summarisePendingReview — file-import', () => {
  // The worker auto-stamps action_taken_at on every file-import path
  // EXCEPT the needsCurrency early return, so this is the only shape that
  // can ever reach the review feed.
  test('describes the pending currency choice', () => {
    const out = summarisePendingReview('file-import', {
      needsCurrency: { r2Key: 'k', fileType: 'csv', transactionCount: 42, transactionPreview: [] },
    });
    expect(out).toBe('42 transactions · CSV — needs a currency');
  });

  test('handles a single transaction without pluralising', () => {
    const out = summarisePendingReview('file-import', {
      needsCurrency: { fileType: 'ofx', transactionCount: 1, transactionPreview: [] },
    });
    expect(out).toBe('1 transaction · OFX — needs a currency');
  });

  test('omits the file type when the shape lacks one', () => {
    const out = summarisePendingReview('file-import', {
      needsCurrency: { transactionCount: 7 },
    });
    expect(out).toBe('7 transactions — needs a currency');
  });
});

describe('summarisePendingReview — wallet-import', () => {
  // Shape pinned to what the worker returns on its needsReview path.
  test('names the wallet and how much was found', () => {
    const out = summarisePendingReview('wallet-import', {
      needsReview: true,
      walletLabel: 'TUCfdE...Lf88',
      chainsDetected: 2,
      candidateCount: 5,
    });
    expect(out).toBe('TUCfdE...Lf88 · 5 candidates across 2 chains');
  });

  test('reports an empty sweep rather than pretending it found something', () => {
    // A real row on the branch DB: a wallet whose sweep detected nothing.
    // Saying so is the point — it tells the user why there is nothing to
    // import without opening the job.
    const out = summarisePendingReview('wallet-import', {
      walletLabel: 'TUCfdE...Lf88',
      chainsDetected: 0,
      candidateCount: 0,
    });
    expect(out).toBe('TUCfdE...Lf88 · nothing found');
  });

  test('falls back to the counts when the wallet has no label', () => {
    const out = summarisePendingReview('wallet-import', { chainsDetected: 1, candidateCount: 3 });
    expect(out).toBe('3 candidates across 1 chain');
  });
});

describe('summarisePendingReview — must never throw on an unexpected shape', () => {
  // This runs on a read path that renders the page. A summary that throws
  // takes down the whole feed, which is far worse than a missing subtitle.
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
        let out: string | undefined;
        expect(() => {
          out = summarisePendingReview(kind, value);
        }).not.toThrow();
        expect(out).toBeUndefined();
      });
    }
  }

  test('a job kind with no summariser yields no subtitle rather than a guess', () => {
    expect(summarisePendingReview('exchange-import', screenshotResult([{ symbol: 'BTC' }]))).toBe(
      undefined
    );
  });
});
