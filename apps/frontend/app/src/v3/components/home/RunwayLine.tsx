import { committedShareOfObserved, Decimal, runwayDenominator } from '@scani/shared';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useBaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import { trpc } from '@/lib/trpc';
import { bucketMovements, monthSequence, project, runway } from '../../lib/forecast';
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
   * Runway used to be the recurring book walked forward. Reported by mgrin
   * from production use: that book does not describe how he spends money. He
   * moves it to current accounts Scani deliberately does not track and spends
   * from there, so his burn is the rate money LEAVES THE TRACKED PERIMETER —
   * `left_control` outflows, $4k–$43k a month, nothing like a schedule.
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
    const perMonth = runwayDenominator(burn.perMonthMean);
    // Nothing left the perimeter across the whole window. `liquid ÷ 0` is not
    // "forever", it is "this window cannot answer" — fall through to the book.
    if (perMonth.lessThanOrEqualTo(0)) return null;
    const months = new Decimal(forecast.data.liquid.amount).dividedBy(perMonth);
    return { months: months.floor().toNumber(), burn };
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
  const committedShare = useMemo(() => {
    if (!observedAnswer || !forecast.data) return null;
    const buckets = bucketMovements(
      forecast.data.movements,
      monthSequence(forecast.data.today, forecast.data.horizonMonths)
    );
    const projection = project(new Decimal(forecast.data.liquid.amount), buckets, rates);
    if (projection.pending || projection.points.length === 0) return null;
    const committed = projection.points
      .reduce((sum, point) => sum.plus(point.outflow), new Decimal(0))
      .dividedBy(projection.points.length);
    return committedShareOfObserved(committed.toString(), observedAnswer.burn.perMonthMean);
  }, [observedAnswer, forecast.data, rates]);

  if (observedAnswer) {
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
          {committedShare ? (
            <span className="text-caption text-muted-foreground">
              {t('v3.money.forecast.ofWhichCommitted', {
                percent: committedShare.times(100).toFixed(0),
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
