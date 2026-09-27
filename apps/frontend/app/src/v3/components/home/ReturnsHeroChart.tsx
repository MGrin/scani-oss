import { Skeleton } from '@scani/ui/ui/skeleton';
import { useTranslation } from 'react-i18next';
import type { ComparisonView } from '../../lib/returns-comparison';
import { ReturnsComparisonChart } from './ReturnsComparisonChart';

/**
 * The Returns tab's chart area in the hero (SC-1301).
 *
 * **It carries its own loading state, separately from the sentence above it.**
 * The sentence comes from `getReturns`, which is cheap; this comes from
 * `getReturnsComparison`, which pays for one benchmark price per measured day.
 * A hero that blanks while a benchmark price is fetched is worse than the
 * buried card this replaces, so the two states are independent and the
 * sentence never waits on this one.
 *
 * **It never falls back to another metric.** With the comparison unavailable
 * the area carries one line of text; drawing net worth under a returns
 * headline would be a chart and a sentence about two different things.
 *
 * Handed its data rather than owning the query, so it renders without a tRPC
 * client.
 *
 * **It used to carry a caption saying which window was actually measured**,
 * because the chart offered five ranges and the router offered three windows
 * so most ranges had no exact equivalent. SC-1305 made the router answer the
 * range, so there is nothing left to widen and nothing left to explain: the
 * axis and the figures above it describe the same days by construction.
 */
export function ReturnsHeroChart({
  comparison,
  comparisonPending,
  comparisonFailed,
  currency,
}: {
  comparison: ComparisonView | null;
  comparisonPending: boolean;
  comparisonFailed: boolean;
  currency: string;
}) {
  const { t } = useTranslation();

  return (
    <>
      {comparison && comparison.points.length > 0 ? (
        <ReturnsComparisonChart comparison={comparison} currency={currency} framed={false} />
      ) : comparisonFailed ? (
        // One line of plain text, not an empty frame: the sentence above it is
        // unaffected and the reader should be told that in words.
        <p role="alert" className="text-caption text-muted-foreground">
          {t('v3.home.returns.chart.unavailable')}
        </p>
      ) : comparisonPending ? (
        // A skeleton the height of the chart it replaces, paired with a live
        // region — the same rule the delta line follows, for the same reason:
        // this slot's whole job at that moment is to not be a sentence.
        <>
          <Skeleton aria-hidden="true" className="h-[200px] w-full" />
          <span className="sr-only" role="status">
            {t('v3.home.hero.returnsChartPending')}
          </span>
        </>
      ) : (
        // A window with under two measured days is not a line. The card below
        // draws nothing here and gets away with it; the hero cannot, because
        // nothing is a hole where the screen's main chart should be.
        <p className="text-caption text-muted-foreground">{t('v3.home.hero.returnsNoChart')}</p>
      )}
    </>
  );
}
