import type { HoldingWithDetails } from '@scani/shared';
import { Block } from '@scani/ui/v3/components/Block';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { Trans, useTranslation } from 'react-i18next';
import {
  allExcludedFromTotal,
  excludedFromTotal,
  holdingAllocation,
  holdingsValue,
  stalePricedInTotal,
} from '../../lib/holdings';
import { AllocationBar } from '../charts/AllocationBar';

/**
 * What the list adds up to, over the rows actually shown.
 *
 * The figure is the *filtered* set, which is the whole reason this is a
 * `summary` on the data view rather than a header on the page: filtering to
 * one institution and reading the portfolio total underneath it is a wrong
 * number, and the count line directly below already says "12 of 84 holdings"
 * so there is no ambiguity about what is being added up.
 *
 * The label is "Value" and not "Total value" for the same reason — it is the
 * value of these, not a claim about everything.
 *
 * The bar is suppressed below two types. A stacked bar with one segment is a
 * full-width rectangle that encodes nothing, plus a list entry repeating the
 * figure directly above it.
 *
 * The figure counts what `countsTowardTotal` counts, which since SC-63 is the
 * server's own rule. That leaves a gap the reader can see — rows are on screen
 * that the total above them ignores — so the gap is stated rather than left to
 * be discovered by adding the column up. An unexplained exclusion is the same
 * experience as a wrong total.
 *
 * **TWO CAPTIONS, AND THE ORDER IS THE ARGUMENT (SC-956).** The stale-quote
 * line is a claim about value that IS in the figure; the excluded line is a
 * caveat about rows that are not. They are opposite operations, and adjacent
 * in the other order they read as two versions of one caveat — a reader who
 * has just been told what was left out takes the next sentence as more of the
 * same and stops. `ObservedBasis` on the money surface made this call first
 * and for the same reason; this follows it rather than re-deciding.
 *
 * The stale line names what it INCLUDES, in as many words, because the whole
 * hazard is that an old price is silently indistinguishable from a fresh one.
 * A stale price still counts — the rollup decided that deliberately, since
 * dropping the holding fabricates a gap on a pure data-gap day — so this
 * labels the figure rather than changing it.
 *
 * **ONE DEGENERATE CASE HEADLINES THE EXCLUDED TOTAL INSTEAD (SC-1122).** When
 * EVERY row on screen is excluded, the caption stops explaining a difference
 * and starts naming the whole page, under a hero figure of zero — a list where
 * every row carries a value, totalling nothing. So that case swaps the label
 * and the figure rather than adding a third caption: the tile reads "Inactive
 * value" over the sum of those rows, which is the number the reader came for,
 * and the sentence below says it is in no portfolio total.
 *
 * The LABEL carries the marking, not a footnote. A bare total under "Value"
 * would read as live portfolio value and would be the SC-388 defect running
 * the other way — worse than the zero, because a wrong number is quieter than
 * an empty one. The label is the thing that makes the figure mean anything
 * (`StatTile`), so it is where "this is not your money today" belongs.
 *
 * THE MIXED LIST IS UNTOUCHED, and the `else` branch below is written as one
 * so that this is structural rather than a promise. mgrin called the mixed
 * behaviour correct in as many words; a change that tidied it would be wrong
 * even where it looked better.
 */

interface HoldingsSummaryProps {
  holdings: readonly HoldingWithDetails[];
  currency: string;
}

export function HoldingsSummary({ holdings, currency }: HoldingsSummaryProps) {
  const { t } = useTranslation();
  const allocation = holdingAllocation(t, holdings);
  const excluded = excludedFromTotal(holdings);
  const stale = stalePricedInTotal(holdings);
  const allInactive = allExcludedFromTotal(holdings);

  return (
    <Block className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <StatTile
          emphasis="hero"
          label={t(allInactive ? 'v3.holdings.summary.inactiveValue' : 'v3.holdings.summary.value')}
          value={
            <Numeric
              value={allInactive ? excluded.value : holdingsValue(holdings)}
              currency={currency}
            />
          }
        />
        {allInactive ? (
          // No count and no figure in this sentence, on purpose. The count line
          // directly below already says how many rows there are and the hero
          // directly above is the figure, so a third statement of either would
          // be the "same number twice" this ticket is about. It also keeps the
          // string free of plural forms, which are not the same set in all
          // eight locales.
          <p className="text-caption text-muted-foreground">
            {t('v3.holdings.summary.allInactive')}
          </p>
        ) : (
          <>
            {stale.count > 0 ? (
              <p className="text-caption text-muted-foreground">
                <Trans
                  i18nKey="v3.holdings.summary.stalePriced"
                  count={stale.count}
                  components={{
                    value: (
                      <Numeric value={stale.value} currency={currency} className="text-caption" />
                    ),
                  }}
                />
              </p>
            ) : null}
            {excluded.count > 0 ? (
              <p className="text-caption text-muted-foreground">
                {/* One sentence, one key, the figure as a slot (SC-235). Built
                    as lead + `<Numeric>` + tail it handed a translator two
                    halves and pinned the amount between them — and no language
                    is obliged to put a figure between "worth" and "still listed
                    below". */}
                <Trans
                  i18nKey="v3.holdings.summary.excludes"
                  count={excluded.count}
                  components={{
                    value: (
                      <Numeric
                        value={excluded.value}
                        currency={currency}
                        className="text-caption"
                      />
                    ),
                  }}
                />
              </p>
            ) : null}
          </>
        )}
      </div>
      {allocation.length > 1 ? (
        <AllocationBar
          items={allocation}
          currency={currency}
          label={t('v3.holdings.summary.allocation')}
        />
      ) : null}
    </Block>
  );
}
