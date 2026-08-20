import type { Decimal } from '@scani/shared';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { Trans, useTranslation } from 'react-i18next';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import { convertTotalsToBase } from '../lib/paymentTotals';

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

/** The list separator between the base-currency figure and each part that did
 *  not convert. Markup rather than a key: it separates items of a list, it is
 *  not a word in any of their sentences (SC-235). */
const SEPARATOR = ' + ';

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
  const { t } = useTranslation();
  const total = convertTotalsToBase(totals, rates);

  if (total.pending) {
    // Same rule as `<ConvertedTotal>`, in one line instead of a tile: a sum
    // computed without the rates it needs is the base-currency part alone, and
    // rendering it here would say a vendor costs $23 when it costs $88 (SC-210).
    return (
      <>
        <Skeleton aria-hidden="true" className="inline-block h-4 w-20 align-middle" />
        <span className="sr-only" role="status">
          {t('v3.common.convertedFigure.working')}
        </span>
      </>
    );
  }

  // Both lists are "not in the figure", which is all this line has room to
  // say in ink — but they are missing for different reasons, and the reason is
  // what the screen reader gets. `<ConvertedTotal>` has the room to write it
  // out.
  const missing = [
    ...total.unconverted.map((part) => ({ part, unavailable: false })),
    ...total.unknown.map((part) => ({ part, unavailable: true })),
  ];
  // Each clause is one whole key with the figure as a slot (SC-235). It was
  // built as `" + "` + `<Numeric>` + `" unconverted"`, three siblings with the
  // word order living in this element: a translator could rewrite both halves
  // and still not put the qualifier before the figure, which is where several
  // of the eight languages want it.
  //
  // The `+` stays in the markup because it is what it looks like — the
  // separator between items of a list, not a word in any of their sentences.
  //
  // Seen and spoken stay separate keys because they say different things
  // rather than the same thing at different lengths: the spoken one names WHY
  // a part is missing, and the collapsed form counts currencies where the
  // named form shows figures, so neither pair can share a string.
  const spokenKey = (unavailable: boolean, collapsed: boolean) =>
    `v3.common.convertedFigure.${unavailable ? 'unavailable' : 'unconverted'}Spoken${
      collapsed ? 'Many' : ''
    }`;

  return (
    <>
      <Numeric delta={delta} value={total.amount.toString()} currency={rates.baseSymbol} />
      {missing.length > NAMED_UNCONVERTED ? (
        <span className="text-caption text-muted-foreground">
          <span aria-hidden="true">
            {SEPARATOR}
            {t('v3.common.convertedFigure.moreCurrencies', { count: missing.length })}
          </span>
          {/* One spoken reason for a collapsed list: a failed fetch takes out
              every currency at once, so if any part is missing for that reason
              it is the reason the list is long. */}
          <span className="sr-only">
            {t(spokenKey(total.unknown.length > 0, true), { count: missing.length })}
          </span>
        </span>
      ) : (
        missing.map(({ part, unavailable }) => {
          const figure = (
            <Numeric
              value={part.amount.toString()}
              currency={tokenSymbolById.get(part.currencyTokenId) ?? rates.baseSymbol}
            />
          );
          return (
            <span key={part.currencyTokenId} className="text-caption text-muted-foreground">
              <span aria-hidden="true">
                {SEPARATOR}
                <Trans
                  i18nKey="v3.common.convertedFigure.unconvertedSeen"
                  components={{ value: figure }}
                />
              </span>
              <span className="sr-only">
                <Trans i18nKey={spokenKey(unavailable, false)} components={{ value: figure }} />
              </span>
            </span>
          );
        })
      )}
    </>
  );
}
