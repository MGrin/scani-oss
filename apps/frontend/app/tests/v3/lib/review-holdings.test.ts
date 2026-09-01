import { describe, expect, test } from 'bun:test';
import {
  buildBatchPayload,
  deriveReviewState,
  type ReviewHoldingInput,
  readScreenshotParse,
  toReviewRows,
} from '@/v3/lib/review-holdings';

/**
 * The rules v2 computes inline inside `ReviewHoldingsCard` and
 * `ScreenshotParseResult`, where nothing could assert them — which is how both
 * of the defects below survived (SC-320 slice 5).
 */

function rows(...holdings: ReviewHoldingInput[]) {
  return toReviewRows(holdings);
}

const MATCHED: ReviewHoldingInput = { symbol: 'BTC', balance: '1.5', tokenId: 'tok-btc' };

describe('the count is the payload', () => {
  /**
   * v2's defect, stated as a property.
   *
   * `newHoldings`/`updateHoldings` drive both the header and the button label
   * and filter on nothing but `tokenId`; the save then filters those AGAIN on a
   * truthy `balance`. Clear one amount of two and v2 offers "Import 2
   * holdings", enables the button, and writes one — silently, because the
   * dropped row is not mentioned anywhere.
   */
  test('a row with no amount blocks the save instead of vanishing from it', () => {
    const state = deriveReviewState(
      rows(MATCHED, { symbol: 'ETH', balance: '', tokenId: 'tok-eth' })
    );
    expect(state.importableCount).toBe(2);
    expect(state.blocker).toBe('missingAmount');
    expect(state.incomplete.map((row) => row.symbol)).toEqual(['ETH']);
    expect(buildBatchPayload(state, { accountId: 'acc', requestId: 'req' })).toBeNull();
  });

  test('what the button promises is exactly what is written', () => {
    const state = deriveReviewState(
      rows(MATCHED, {
        symbol: 'ETH',
        balance: '4',
        tokenId: 'tok-eth',
        holdingId: 'hold-eth',
      })
    );
    const payload = buildBatchPayload(state, { accountId: 'acc', requestId: 'req' });
    expect(state.blocker).toBeNull();
    expect(payload?.newHoldings.length ?? 0).toBe(1);
    expect(payload?.updateHoldings.length ?? 0).toBe(1);
    expect((payload?.newHoldings.length ?? 0) + (payload?.updateHoldings.length ?? 0)).toBe(
      state.importableCount
    );
  });

  test('a removed row is in neither the count nor the payload', () => {
    const state = deriveReviewState(
      rows(MATCHED, { symbol: 'ETH', balance: '4', tokenId: 'tok-eth' }).map((row, index) =>
        index === 1 ? { ...row, removed: true } : row
      )
    );
    expect(state.importableCount).toBe(1);
    expect(state.removedCount).toBe(1);
    expect(
      buildBatchPayload(state, { accountId: 'acc', requestId: 'req' })?.newHoldings
    ).toHaveLength(1);
  });

  test('an unmatched row is skipped rather than blocking', () => {
    const state = deriveReviewState(rows(MATCHED, { symbol: 'ZZZ', balance: '1' }));
    expect(state.unmatched.map((row) => row.symbol)).toEqual(['ZZZ']);
    expect(state.importableCount).toBe(1);
    expect(state.blocker).toBeNull();
  });

  test('nothing matched is refused with its own reason', () => {
    expect(deriveReviewState(rows({ symbol: 'ZZZ', balance: '1' })).blocker).toBe(
      'nothingToImport'
    );
  });

  /**
   * A figure the extractor could not read stays absent. v2 substitutes `'0'`,
   * which turns "we could not read this" into a claim that the position is
   * empty — on the one screen built for a human to catch exactly that.
   */
  test('a missing figure is empty, never zero', () => {
    const [row] = toReviewRows([{ symbol: 'BTC', balance: undefined as unknown as string }]);
    expect(row?.balance).toBe('');
  });
});

describe('two rows on one token', () => {
  const CREATE = { symbol: 'RUB', balance: '100', tokenId: 'tok-rub' };
  const HELD_NAMED = {
    symbol: 'RUB',
    balance: '200',
    tokenId: 'tok-rub',
    holdingId: 'hold-rub',
    existingLabel: 'Savings',
  };

  test('the name is asked for whenever a token is on more than one row', () => {
    const state = deriveReviewState(rows(CREATE, HELD_NAMED));
    expect(state.contestedTokenIds.has('tok-rub')).toBe(true);
  });

  /**
   * The half v2 gets wrong by DROPPING `existingLabel` upstream, so every held
   * row is keyed as unnamed. An unnamed create beside a holding called
   * "Savings" does not collide — `holdingPositionKey` puts them at different
   * keys and the server accepts it — but v2 keys the held row at `''`, reports
   * a collision, disables Import, and tells the reader that RUB is "on more
   * than one row under the same name" when it is not.
   */
  test('an unnamed new row does not collide with a NAMED existing one', () => {
    const state = deriveReviewState(rows(CREATE, HELD_NAMED));
    expect(state.collidingSymbols).toEqual([]);
    expect(state.blocker).toBeNull();
  });

  /**
   * The other direction, and the worse one: the same name on both IS a
   * collision, and it is the one the server refuses. v2 compares `'savings'`
   * against `''`, finds no collision, and lets the reader submit into a
   * rejection — so the guard whose stated purpose is "the review screen must
   * refuse exactly what the server refuses" fails OPEN on the only path that
   * uses it.
   */
  test('a new row named like the existing one is refused before the round trip', () => {
    const state = deriveReviewState(
      rows(CREATE, HELD_NAMED).map((row) => (row.holdingId ? row : { ...row, label: '  savings ' }))
    );
    expect(state.collidingSymbols).toEqual(['RUB']);
    expect(state.blocker).toBe('duplicatePosition');
    expect(buildBatchPayload(state, { accountId: 'acc', requestId: 'req' })).toBeNull();
  });

  test('two unnamed new rows for one token still collide', () => {
    const state = deriveReviewState(rows(CREATE, { ...CREATE }));
    expect(state.collidingSymbols).toEqual(['RUB']);
  });

  test('differently named pots are allowed through', () => {
    const state = deriveReviewState(
      rows(CREATE, { ...CREATE }).map((row, index) => ({
        ...row,
        label: index === 0 ? 'Savings' : 'Current',
      }))
    );
    expect(state.collidingSymbols).toEqual([]);
    const payload = buildBatchPayload(state, { accountId: 'acc', requestId: 'req' });
    expect(payload?.newHoldings.map((row) => row.label)).toEqual(['Savings', 'Current']);
  });

  /**
   * A name typed into a row whose token later stopped being contested is not a
   * name the reader chose to keep, and storing it would put a stray "Savings"
   * on a lone holding.
   */
  test('a name on an uncontested row is not sent', () => {
    const state = deriveReviewState(rows(MATCHED).map((row) => ({ ...row, label: 'Savings' })));
    expect(state.contestedTokenIds.size).toBe(0);
    expect(
      buildBatchPayload(state, { accountId: 'acc', requestId: 'req' })?.newHoldings[0]?.label
    ).toBeUndefined();
  });
});

describe('reading a screenshot-parse result', () => {
  const RESULT = {
    accountId: 'acc-1',
    summary: { totalFiles: 1, successCount: 1, failureCount: 0 },
    results: [
      {
        r2Key: 'u/1/statement.pdf',
        success: true,
        data: {
          overallConfidence: 0.91,
          holdings: [
            {
              symbol: 'RUB',
              name: 'Russian Ruble',
              assetType: 'fiat',
              balance: '1500.15',
              confidence: 0.8,
              tokenId: 'tok-rub',
              holdingId: 'hold-rub',
              existingBalance: '5000',
              existingLabel: 'Savings',
            },
          ],
        },
      },
    ],
  };

  /**
   * The headline defect of this slice, and the reason `review-registry` could
   * not be delegated.
   *
   * `EnrichHoldingsService` sets `existingLabel` for SC-330 — the Tinkoff
   ***REMOVED***
   ***REMOVED***
   * in `ScreenshotParseResult` lists every other enriched field and omits this
   * one, and that renderer is the ONLY consumer of `ReviewHoldingsCard`. So the
   * fix has never rendered, and the collision guard keyed on it has been
   * running against `''` in production.
   */
  test('existingLabel survives the mapping', () => {
    expect(readScreenshotParse(RESULT).holdings[0]?.existingLabel).toBe('Savings');
  });

  test('every other enriched field survives too', () => {
    const holding = readScreenshotParse(RESULT).holdings[0];
    expect(holding).toMatchObject({
      symbol: 'RUB',
      name: 'Russian Ruble',
      assetType: 'fiat',
      balance: '1500.15',
      confidence: 0.8,
      tokenId: 'tok-rub',
      holdingId: 'hold-rub',
      existingBalance: '5000',
    });
  });

  /**
   * v2 reads the per-file counts out of `summary` while deriving the rows from
   * `results`, so a row written before the worker recorded a summary renders
   * "0 succeeded, 0 failed" directly above the list it extracted.
   */
  test('the counts come from the results, not from a summary that may be absent', () => {
    const parse = readScreenshotParse({ ...RESULT, summary: undefined });
    expect(parse.succeeded).toBe(1);
    expect(parse.failed).toBe(0);
    expect(parse.totalFiles).toBe(1);
    expect(parse.holdings).toHaveLength(1);
  });

  test('a failure is counted and contributes no holdings', () => {
    const parse = readScreenshotParse({
      ...RESULT,
      results: [...RESULT.results, { r2Key: 'u/1/b.pdf', success: false, error: 'boom' }],
    });
    expect(parse.succeeded).toBe(1);
    expect(parse.failed).toBe(1);
    expect(parse.holdings).toHaveLength(1);
  });

  test('a PDF is a statement, an image is a screenshot, and one of each is neither', () => {
    expect(readScreenshotParse(RESULT).kind).toBe('pdf');
    expect(
      readScreenshotParse({ ...RESULT, results: [{ ...RESULT.results[0], r2Key: 'u/1/a.png' }] })
        .kind
    ).toBe('image');
    expect(
      readScreenshotParse({
        ...RESULT,
        results: [RESULT.results[0], { r2Key: 'u/1/a.png', success: true, data: { holdings: [] } }],
      }).kind
    ).toBe('mixed');
  });

  test('overall confidence is only claimed when one file was read', () => {
    expect(readScreenshotParse(RESULT).overallConfidence).toBe(0.91);
    expect(
      readScreenshotParse({
        ...RESULT,
        results: [RESULT.results[0], { ...RESULT.results[0], r2Key: 'u/1/b.pdf' }],
      }).overallConfidence
    ).toBeNull();
  });

  test('a shape this does not recognise reads as empty rather than throwing', () => {
    for (const value of [null, undefined, 'nope', 42, {}, { results: 'no' }]) {
      const parse = readScreenshotParse(value);
      expect(parse.holdings).toEqual([]);
      expect(parse.accountId).toBeNull();
    }
  });

  test('an absent accountId is null, never an empty string', () => {
    expect(readScreenshotParse({ ...RESULT, accountId: '' }).accountId).toBeNull();
  });
});
