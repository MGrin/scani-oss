import type { HoldingWithDetails } from '@scani/shared';
import { Block } from '@scani/ui/v3/components/Block';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { Trans, useTranslation } from 'react-i18next';
import { excludedFromTotal, holdingAllocation, holdingsValue } from '../../lib/holdings';
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
 */

interface HoldingsSummaryProps {
  holdings: readonly HoldingWithDetails[];
  currency: string;
}

export function HoldingsSummary({ holdings, currency }: HoldingsSummaryProps) {
  const { t } = useTranslation();
  const allocation = holdingAllocation(holdings);
  const excluded = excludedFromTotal(holdings);

  return (
    <Block className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-1">
        <StatTile
          emphasis="hero"
          label={t('v3.holdings.summary.value')}
          value={<Numeric value={holdingsValue(holdings)} currency={currency} />}
        />
        {excluded.count > 0 ? (
          <p className="text-caption text-muted-foreground">
            {/* One sentence, one key, the figure as a slot (SC-235). Built as
                lead + `<Numeric>` + tail it handed a translator two halves and
                pinned the amount between them — and no language is obliged to
                put a figure between "worth" and "still listed below". */}
            <Trans
              i18nKey="v3.holdings.summary.excludes"
              count={excluded.count}
              components={{
                value: (
                  <Numeric value={excluded.value} currency={currency} className="text-caption" />
                ),
              }}
            />
          </p>
        ) : null}
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
