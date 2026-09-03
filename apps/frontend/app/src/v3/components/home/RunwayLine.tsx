import { Decimal, observedRunwayMonths } from '@scani/shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useBaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import { trpc } from '@/lib/trpc';
import {
  bucketMovements,
  monthSequence,
  project,
  projectedShare,
  runway,
} from '../../lib/forecast';
import { V3_ROUTES } from '../../lib/routes';
import { formatProjectionMonth } from '../money/ProjectionChart';

/**
 * One line at the foot of "What's due": how long the money lasts (SC-461).
 *
 * Sited here rather than in a block of its own because mgrin asked for a
 * runway *sentence* on the home screen, and because it is the same shape as
 * the income foot-line V3-47 put here — one aggregate over a longer horizon,
 * under the rows it is derived from, never a row among them.
 *
 * Three things keep it from reading as a measured figure, which is the whole
 * constraint of this ticket on the one screen where the reader is scanning:
 *
 * - the rule above it is **dashed**, where the two foot-lines above are solid;
 * - the word **Projected** is on the line itself;
 * - the figure is a **month or a window**, never money. There is no
 *   base-currency number here to be mistaken for a balance.
 *
 * It renders nothing at all when there is nothing to project. An account with
 * no recurring payments would otherwise get "lasts more than 12 months", which
 * is true, vacuous, and the most reassuring possible way to say "we know
 * nothing about your outgoings".
 *
 * **`staleValued` is NOT reported here, and that is a decision rather than an
 * oversight (SC-956).** The observed burn behind this figure can rest partly
 * on quotes weeks old, and `ObservedBasis` on the forecast page now says so.
 * Three reasons it stops there. This line already carries a mark saying the
 * whole figure is not a measurement, which is the strongest qualifier on the
 * screen and the one a second clause would have to compete with. Its content
 * is a month count, not money, so there is no figure here for a stale price to
 * make wrong in the way it makes a burn total wrong. And it is a link whose
 * destination leads with the same figure and now carries the caveat, which is
 * exactly what a link is for.
 *
 * The half of that worth doubting: home is the default screen, and "the fact
 * existed everywhere except the screen its reader opens" is the failure
 * `CoverageNote` was built to fix. The difference relied on is that the figure
 * there was presented as measured and this one is marked projected. If that
 * turns out to be too fine a distinction, this is where the clause goes.
 */
export function RunwayLine() {
  const { t } = useTranslation();
  // The same query and the same cache entry the Money tab's Forecast view
  // reads, so the two can never answer differently.
  const forecast = trpc.payments.forecast.useQuery();
  const rates = useBaseCurrencyRates(
    (forecast.data?.movements ?? []).map((movement) => movement.currencyTokenId)
  );

  /**
   * The observed answer, and it is the one that ships (SC-657).
   *
   * Runway used to be the recurring book walked forward. Reported from
   * production use: that book does not describe how an owner spends money. They
   * move it to current accounts Scani deliberately does not track and spend
   * from there, so their burn is the rate money LEAVES THE TRACKED PERIMETER —
   * `left_control` outflows, varying by an order of magnitude month to month,
   * nothing like a schedule.
   *
   * `committed` is shown beside it as a SHARE, never as an addend:
   * `runwayDenominator` takes one argument and there is no way to hand it the
   * sum. The two are not siblings — his recurring payments are paid out of the
   * untracked accounts, so that money already left the perimeter when he moved
   * it, and it is inside `observed` already. See `@scani/shared` `lib/burn.ts`.
   */
  const observedAnswer = useMemo(() => {
    const burn = forecast.data?.observedBurn;
    if (!forecast.data || !burn) return null;
    // Nothing left the perimeter across the whole window is "this window
    // cannot answer", not "forever" — `observedRunwayMonths` returns null and
    // this falls through to the book. The division lives in `@scani/shared`
    // because the forecast page answers the same question and the two must not
    // do their own arithmetic (SC-661).
    const months = observedRunwayMonths(forecast.data.liquid.amount, burn.perMonthMean);
    if (months === null) return null;
    return { months, burn };
  }, [forecast.data]);

  const answer = useMemo(() => {
    if (!forecast.data || forecast.data.movements.length === 0) return null;
    const buckets = bucketMovements(
      forecast.data.movements,
      monthSequence(forecast.data.today, forecast.data.horizonMonths)
    );
    const projection = project(new Decimal(forecast.data.liquid.amount), buckets, rates);
    // SC-210: without the rates the burn is missing its foreign half, so the
    // runway is too long. A line that is wrong in the flattering direction is
    // worse than no line, and this one has no room for a skeleton.
    if (projection.pending) return null;
    return runway(projection);
  }, [forecast.data, rates]);

  /**
   * The book's own monthly outflow, taken from the projection so it comes
   * through the SAME currency conversion the runway did. A second conversion
   * path would let the two numbers on this line disagree invisibly.
   */
  const share = useMemo(() => {
    if (!observedAnswer || !forecast.data) return null;
    const buckets = bucketMovements(
      forecast.data.movements,
      monthSequence(forecast.data.today, forecast.data.horizonMonths)
    );
    const projection = project(new Decimal(forecast.data.liquid.amount), buckets, rates);
    return projectedShare(projection, observedAnswer.burn.perMonthMean);
  }, [observedAnswer, forecast.data, rates]);

  if (observedAnswer) {
    /**
     * A link again (SC-661). SC-657 removed it because the destination
     * contradicted this line: it read "About 27 months at recent spending"
     * while `ForecastView` projected the committed book and answered "Lasts
     * beyond 12 months · the book nets a large positive figure a month" — the opposite
     * conclusion about the same account at the same instant.
     *
     * The destination now leads with the same figure, from the same
     * `observedRunwayMonths` call, so the link asserts what a link is supposed
     * to assert: that the page elaborates the thing you tapped. It is not
     * restored because a missing affordance looked untidy — the removal was
     * correct for as long as it was true.
     */
    return (
      <Link
        to={V3_ROUTES.forecast}
        className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-dashed border-border px-4 py-3 transition-colors hover:bg-surface-hover"
      >
        <span className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
          {t('v3.home.runway.label')}
          <span className="rounded border border-dashed border-muted-foreground/70 px-1.5 text-caption uppercase leading-tight tracking-wide">
            {t('v3.money.forecast.projectedMark')}
          </span>
        </span>
        <span className="flex flex-wrap items-center gap-2 text-label">
          {t('v3.money.forecast.observedRunway', { count: observedAnswer.months })}
          {share ? (
            <span className="text-caption text-muted-foreground">
              {t('v3.money.forecast.ofWhichProjected', {
                percent: share.times(100).toFixed(0),
              })}
            </span>
          ) : null}
        </span>
      </Link>
    );
  }

  if (!answer) return null;

  return (
    <Link
      to={V3_ROUTES.forecast}
      className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-dashed border-border px-4 py-3 transition-colors hover:bg-surface-hover"
    >
      <span className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
        {t('v3.home.runway.label')}
        <span className="rounded border border-dashed border-muted-foreground/70 px-1.5 text-caption uppercase leading-tight tracking-wide">
          {t('v3.money.forecast.projectedMark')}
        </span>
      </span>
      <span className="text-label">
        {answer.kind === 'exhausted'
          ? t('v3.money.forecast.runsOutIn', { month: formatProjectionMonth(answer.month) })
          : t('v3.money.forecast.lastsBeyond', { count: answer.beyondMonths })}
      </span>
    </Link>
  );
}
