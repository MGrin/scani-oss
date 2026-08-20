import '../../i18n-preload';

import { describe, expect, test } from 'bun:test';
import { Decimal } from '@scani/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BaseCurrencyRates } from '../../../src/hooks/useBaseCurrencyRates';
import { ConvertedTotal } from '../../../src/v3/components/ConvertedTotal';

/**
 * The Money tab's hero figure, and the bug mgrin reported from the live app
 * (SC-210): "I see the total across all US recurring payments, and then it
 * switches to the total with other currency payments. But sometimes it stays
 * on US only number (so 425 vs 888 USD)."
 *
 * Both halves of that sentence are this component rendering a figure it had no
 * business rendering. The tests below are written against the numbers in the
 * report, so a regression reads as the report.
 */

const USD = 'token-usd';
const EUR = 'token-eur';
const GBP = 'token-gbp';

const SYMBOLS = new Map([
  [USD, 'USD'],
  [EUR, 'EUR'],
  [GBP, 'GBP'],
]);

/** The reported book: $425 of the reader's own money, €300 and £163 besides. */
const BOOK = new Map([
  [USD, new Decimal('425')],
  [EUR, new Decimal('300')],
  [GBP, new Decimal('163')],
]);

const FRESH = new Date().toISOString();

const rates = (over: Partial<BaseCurrencyRates> = {}): BaseCurrencyRates => ({
  baseCurrencyTokenId: USD,
  baseSymbol: 'USD',
  rateByCurrencyTokenId: new Map([
    [EUR, { rate: '1.1', asOf: FRESH }],
    [GBP, { rate: '1.0', asOf: FRESH }],
  ]),
  ratesStatus: 'ready',
  ...over,
});

describe('ConvertedTotal', () => {
  test('every currency converts: one figure, and it says what it folded in', () => {
    const html = renderToStaticMarkup(
      <ConvertedTotal
        label="Committed each month"
        totals={BOOK}
        tokenSymbolById={SYMBOLS}
        rates={rates()}
      />
    );
    // 425 + (300 × 1.1) + 163
    expect(html).toInclude('$918.00');
    expect(html).toInclude('Includes');
  });

  /**
   * The jump, from its first half. While the rates are in flight the sum of
   * what we can convert is the reader's own currency alone — and that number
   * is not wrong later, it is wrong NOW, at hero size, and it is read.
   */
  test('mid-fetch it renders no figure at all rather than the base-currency-only sum', () => {
    const html = renderToStaticMarkup(
      <ConvertedTotal
        label="Committed each month"
        totals={BOOK}
        tokenSymbolById={SYMBOLS}
        rates={rates({ rateByCurrencyTokenId: new Map(), ratesStatus: 'loading' })}
      />
    );

    expect(html).not.toInclude('$425.00');
    // Nor any other figure: the point is that nothing numeric is asserted.
    expect(html).not.toInclude('$');
    expect(html).toInclude('animate-pulse');
    expect(html).toInclude('Working out the total');
    // The label stays — the tile holds its place, only the figure waits.
    expect(html).toInclude('Committed each month');
  });

  /**
   * The other half: the rates never arrive. There is no later render to wait
   * for, so the figure is shown — but it is visibly incomplete, and the
   * sentence blames the fetch.
   */
  test('when the rates fail, the figure is shown with what is missing from it named', () => {
    const html = renderToStaticMarkup(
      <ConvertedTotal
        label="Committed each month"
        totals={BOOK}
        tokenSymbolById={SYMBOLS}
        rates={rates({ rateByCurrencyTokenId: new Map(), ratesStatus: 'unavailable' })}
      />
    );

    expect(html).toInclude('$425.00');
    expect(html).toInclude('could not be loaded');
    // The amounts left out are named, not just counted: dropping them silently
    // is what understates the figure.
    expect(html).toInclude('€300.00');
    expect(html).toInclude('£163.00');
    // And it must NOT say this, which is a claim about the currencies.
    expect(html).not.toInclude('no recent rate');
    expect(html).not.toInclude('animate-pulse');
  });

  test('a currency with genuinely no rate keeps its own sentence, not the failure one', () => {
    const html = renderToStaticMarkup(
      <ConvertedTotal
        label="Committed each month"
        totals={BOOK}
        tokenSymbolById={SYMBOLS}
        rates={rates({
          // The source answered and had no rate for GBP.
          rateByCurrencyTokenId: new Map([
            [EUR, { rate: '1.1', asOf: FRESH }],
            [GBP, null],
          ]),
        })}
      />
    );

    expect(html).toInclude('no recent rate');
    expect(html).not.toInclude('could not be loaded');
    expect(html).toInclude('£163.00');
  });

  /**
   * The worst case the old code could produce, and the one it produced most
   * confidently: base currency never resolved, so nothing matches and nothing
   * converts. `$0.00` at hero size is a claim that the reader owes nothing.
   */
  test('with nothing knowable it shows no number rather than zero', () => {
    const html = renderToStaticMarkup(
      <ConvertedTotal
        label="Committed each month"
        totals={BOOK}
        tokenSymbolById={SYMBOLS}
        rates={rates({
          baseCurrencyTokenId: null,
          rateByCurrencyTokenId: new Map(),
          ratesStatus: 'unavailable',
        })}
      />
    );

    expect(html).not.toInclude('$0.00');
    expect(html).toInclude('—');
    expect(html).toInclude('No total');
  });

  test('an empty book is a real zero and still renders as one', () => {
    const html = renderToStaticMarkup(
      <ConvertedTotal
        label="Committed each month"
        totals={new Map()}
        tokenSymbolById={SYMBOLS}
        rates={rates()}
      />
    );
    expect(html).toInclude('$0.00');
  });
});
