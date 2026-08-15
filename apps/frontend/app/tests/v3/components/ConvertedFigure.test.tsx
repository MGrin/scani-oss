import { describe, expect, test } from 'bun:test';
import { Decimal } from '@scani/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import type { BaseCurrencyRates } from '../../../src/hooks/useBaseCurrencyRates';
import { ConvertedFigure } from '../../../src/v3/components/ConvertedFigure';

/**
 * The inline converted figure a vendor row and a peek fact are built out of.
 *
 * There is one thing it must never do, and it is the reason it exists rather
 * than a bare `<Numeric>`: report a vendor we cannot price as costing nothing.
 */

const EUR = 'token-eur';
const GBP = 'token-gbp';
const SYMBOLS = new Map([
  [EUR, 'EUR'],
  [GBP, 'GBP'],
]);

const rates = (gbp: { rate: string; asOf: string } | null): BaseCurrencyRates => ({
  baseCurrencyTokenId: EUR,
  baseSymbol: 'EUR',
  rateByCurrencyTokenId: new Map([[GBP, gbp]]),
  isLoading: false,
});

describe('ConvertedFigure', () => {
  test('one figure when every currency converts', () => {
    const html = renderToStaticMarkup(
      <ConvertedFigure
        totals={
          new Map([
            [EUR, new Decimal('100')],
            [GBP, new Decimal('20')],
          ])
        }
        tokenSymbolById={SYMBOLS}
        rates={rates({ rate: '1.15', asOf: new Date().toISOString() })}
      />
    );
    expect(html).toInclude('€123.00');
    expect(html).not.toInclude('unconverted');
  });

  /** The home screen's income line (V3-47) is the one caller that passes it:
   *  money arriving is a direction, not a magnitude. */
  test('a delta figure carries the sign and the gain token', () => {
    const html = renderToStaticMarkup(
      <ConvertedFigure
        delta
        totals={new Map([[GBP, new Decimal('20')]])}
        tokenSymbolById={SYMBOLS}
        rates={rates({ rate: '1.15', asOf: new Date().toISOString() })}
      />
    );
    expect(html).toInclude('+€23.00');
    expect(html).toInclude('text-gain');
  });

  test('a currency with no rate is printed beside the total, never folded in', () => {
    const html = renderToStaticMarkup(
      <ConvertedFigure
        totals={new Map([[GBP, new Decimal('30')]])}
        tokenSymbolById={SYMBOLS}
        rates={rates(null)}
      />
    );
    expect(html).toInclude('€0.00');
    expect(html).toInclude('£30.00');
    expect(html).toInclude('unconverted');
  });
});
