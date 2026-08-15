import type { Decimal } from '@scani/shared';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import { convertTotalsToBase } from '@/v2/lib/paymentTotals';

/**
 * One base-currency figure in a row or a fact — the inline sibling of
 * `<ConvertedTotal>`, which is a stat tile with a caption underneath it.
 *
 * The rule it exists to keep is the one a bare `<Numeric>` cannot: a total
 * whose only part has no rate would render as the reader's currency and zero,
 * which is a confident claim that the vendor costs nothing. Here the
 * un-convertible part is printed beside the figure instead, so the row is
 * visibly incomplete rather than quietly wrong. `<ConvertedTotal>` says the
 * same thing at more length, where there is room for a sentence.
 *
 * **Past one un-convertible currency it counts them instead of listing them**
 * (SC-71 9.2). With a cold FX cache the home screen's income row rendered
 * `≈ +€15,720.00 + £6,300.00 unconverted + $31…` and was cut off at the card
 * edge, losing the third currency entirely — so the degraded path, which is the
 * only path this component is ever seen on, was the one that dropped
 * information. A count is shorter than any of the figures it replaces and
 * cannot be clipped; the figures themselves are one tap away on the Money tab,
 * where `<ConvertedTotal>` has the room to name them.
 */

/** Above this many un-convertible parts the tail becomes a count. One is worth
 *  naming — it is usually *the* foreign bill — and two already overflow a
 *  phone-width card row. */
const NAMED_UNCONVERTED = 1;

interface ConvertedFigureProps {
  totals: ReadonlyMap<string, Decimal>;
  tokenSymbolById: Map<string, string>;
  rates: BaseCurrencyRates;
  /** Money moving in a direction rather than a magnitude — expected income
   *  (V3-47), which carries the same sign and gain token here that it does in
   *  the `<ConvertedTotal>` on the Money tab. */
  delta?: boolean;
}

export function ConvertedFigure({
  totals,
  tokenSymbolById,
  rates,
  delta = false,
}: ConvertedFigureProps) {
  const total = convertTotalsToBase(totals, rates);

  return (
    <>
      <Numeric delta={delta} value={total.amount.toString()} currency={rates.baseSymbol} />
      {total.unconverted.length > NAMED_UNCONVERTED ? (
        <span className="text-caption text-muted-foreground">
          {` + ${total.unconverted.length} currencies`}
          <span className="sr-only"> not converted — no recent rate</span>
          <span aria-hidden="true"> unconverted</span>
        </span>
      ) : (
        total.unconverted.map((part) => (
          <span key={part.currencyTokenId} className="text-caption text-muted-foreground">
            {' + '}
            <Numeric
              value={part.amount.toString()}
              currency={tokenSymbolById.get(part.currencyTokenId) ?? rates.baseSymbol}
            />
            <span className="sr-only"> not converted — no recent rate</span>
            <span aria-hidden="true"> unconverted</span>
          </span>
        ))
      )}
    </>
  );
}
