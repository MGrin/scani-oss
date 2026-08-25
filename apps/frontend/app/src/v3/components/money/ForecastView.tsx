import { Decimal } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { Block } from '@scani/ui/v3/components/Block';
import { DataViewEmpty } from '@scani/ui/v3/components/data-view/DataViewEmpty';
import { DataViewSkeleton } from '@scani/ui/v3/components/data-view/DataViewSkeleton';
import { LoadingRamp } from '@scani/ui/v3/components/feedback/LoadingRamp';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useDelayedLoading } from '@scani/ui/v3/hooks/useDelayedLoading';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { TrendingDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import type { RouterOutputs } from '@/lib/trpc';
import { useViewPreference } from '../../hooks/useViewPreference';
import {
  affordability,
  bucketMovements,
  DEFAULT_FORECAST_HORIZON,
  FORECAST_HORIZONS,
  type ForecastHorizon,
  monthSequence,
  type OneOffOutflow,
  project,
  runway,
  windowTotals,
  withOneOff,
} from '../../lib/forecast';
import { V3_PAYMENT_ROUTES, V3_ROUTES } from '../../lib/routes';
import { VIEW_PREFERENCE_KEYS } from '../../lib/view-preference';
import { ConvertedTotal } from '../ConvertedTotal';
import { AffordabilityPanel } from './AffordabilityPanel';
import { ProjectedTile } from './ProjectedTile';
import { formatProjectionMonth, ProjectionChart } from './ProjectionChart';

/**
 * The Money tab's fourth view — where the book of recurring payments is read
 * FORWARD (SC-461).
 *
 * ## The one rule this whole file is arranged around
 *
 * A projection is a claim about the future and must never wear the same
 * clothes as a measured figure. Applied here that is not a disclaimer at the
 * top of the screen — it is the `<Block>` borders being dashed, every figure
 * going through `<ProjectedTile>` rather than `<StatTile>`, the chart being a
 * dashed neutral line rather than a tinted filled area, and the word
 * "Projected" sitting on each figure rather than once above all of them. A
 * caveat that scrolls away from the number it qualifies is not a caveat.
 *
 * ## Why the runway does not move when the horizon does
 *
 * The 3 / 6 / 12 control governs the CHART and the two window totals. The
 * runway is always answered over the full twelve months the server returns,
 * because "how long does this last" is a fact about the book and not about
 * which tab is selected — a runway that changed on a tap would be the surface
 * agreeing with the reader's framing rather than answering them. So the runway
 * block names its own window, and the chart block names its own.
 *
 * ## What the surface admits to
 *
 * Four things, and every one of them is a denominator rather than an apology:
 * what the liquid figure counted and what it set aside as illiquid (mgrin took
 * the broadest definition, which makes this load-bearing); how many payments
 * could not be projected at all; what is already overdue and therefore not in
 * the forward series; and any currency that had no rate. A figure with no
 * denominator beside it is the failure this codebase keeps meeting.
 */

type ForecastData = RouterOutputs['payments']['forecast'];

interface ForecastViewProps {
  forecast: ForecastData | null;
  tokenSymbolById: Map<string, string>;
  rates: BaseCurrencyRates;
  query: V3QueryState;
  /** How many recurring payments exist at all — the empty state needs to tell
   *  "nothing to project" from "nothing recorded". */
  paymentCount: number;
  /** For the affordability panel's currency slot. Handed down so this whole
   *  view stays free of tRPC and can be rendered — and asserted — on its own,
   *  the same rule `MoneyPage`'s other three views follow. */
  tokens: readonly RouterOutputs['tokens']['getAll'][number][];
}

export function ForecastView({
  forecast,
  tokenSymbolById,
  rates,
  query,
  paymentCount,
  tokens,
}: ForecastViewProps) {
  const { t } = useTranslation();
  const loadingPhase = useDelayedLoading(query.isLoading);
  const [horizon, setHorizon] = useViewPreference<`${ForecastHorizon}`>(
    VIEW_PREFERENCE_KEYS.moneyForecastHorizon,
    `${DEFAULT_FORECAST_HORIZON}`,
    FORECAST_HORIZONS.map((months) => `${months}` as const)
  );
  const [oneOff, setOneOff] = useState<OneOffOutflow | null>(null);

  const months = Number(horizon);
  const opening = useMemo(
    () => new Decimal(forecast?.liquid.amount ?? '0'),
    [forecast?.liquid.amount]
  );

  // Two windows, and they are not the same window. `chartBuckets` is what the
  // reader chose; `runwayBuckets` is always the full twelve — see the class
  // doc. Both are cut from one payload, so they can never be as-of different
  // moments.
  const chartBuckets = useMemo(
    () =>
      forecast ? bucketMovements(forecast.movements, monthSequence(forecast.today, months)) : [],
    [forecast, months]
  );
  const runwayBuckets = useMemo(
    () =>
      forecast
        ? bucketMovements(forecast.movements, monthSequence(forecast.today, forecast.horizonMonths))
        : [],
    [forecast]
  );

  const chartProjection = useMemo(
    () => project(opening, chartBuckets, rates),
    [opening, chartBuckets, rates]
  );
  const runwayProjection = useMemo(
    () => project(opening, runwayBuckets, rates),
    [opening, runwayBuckets, rates]
  );
  const totals = useMemo(() => windowTotals(chartBuckets), [chartBuckets]);

  const answer = useMemo(() => runway(runwayProjection), [runwayProjection]);

  const withPurchase = useMemo(
    () => (oneOff ? project(opening, withOneOff(runwayBuckets, oneOff), rates) : null),
    [oneOff, opening, runwayBuckets, rates]
  );
  const verdict = useMemo(
    () => (withPurchase ? affordability(runwayProjection, withPurchase) : null),
    [runwayProjection, withPurchase]
  );

  if (query.isError && !forecast) {
    return (
      <QueryError
        error={query.error}
        subject={t('v3.money.forecast.label')}
        onRetry={query.retry}
      />
    );
  }

  if (query.isLoading) {
    return (
      <LoadingRamp
        phase={loadingPhase}
        skeleton={<DataViewSkeleton />}
        label={t('v3.money.forecast.label')}
        onRetry={query.retry}
      />
    );
  }

  // A projection over no movements is a flat line at the current balance — a
  // chart that says nothing, drawn with great confidence. The empty state says
  // the same thing in a sentence and offers the way out of it.
  if (!forecast || forecast.movements.length === 0) {
    return (
      <DataViewEmpty
        empty={{
          icon: TrendingDown,
          titleKey:
            paymentCount > 0
              ? 'ui.dataView.forecast.empty.nothingToProject'
              : 'ui.dataView.forecast.empty.noPayments',
          descriptionKey:
            paymentCount > 0
              ? 'ui.dataView.forecast.empty.allPausedOrUnpriced'
              : 'ui.dataView.forecast.empty.addOne',
          action:
            paymentCount > 0 ? (
              <Button variant="outline" asChild>
                <Link to={V3_ROUTES.recurring}>{t('v3.money.forecast.seeRecurring')}</Link>
              </Button>
            ) : (
              <Button asChild>
                <Link to={V3_PAYMENT_ROUTES.create}>{t('v3.money.forecast.addPayment')}</Link>
              </Button>
            ),
        }}
      />
    );
  }

  // SC-210, one surface further out: without the rates the burn is missing
  // every foreign bill, so the balance is too high and the runway too long.
  // A skeleton is the honest thing to show while that is true.
  const pending = runwayProjection.pending || chartProjection.pending;

  return (
    <div className="flex flex-col gap-4">
      {/* Every block on this view is DASHED. The measured surfaces next door —
          Upcoming, Recurring, Vendors — are solid, so the border alone
          separates what is observed from what is claimed, before a word is
          read. */}
      <Block className="flex flex-col gap-3 border-dashed p-4">
        <ProjectedTile
          emphasis="hero"
          label={t('v3.money.forecast.runwayLabel')}
          value={
            pending ? (
              <span className="text-muted-foreground">{t('v3.money.forecast.working')}</span>
            ) : (
              <RunwayFigure answer={answer} />
            )
          }
          note={<RunwayBasis forecast={forecast} baseSymbol={rates.baseSymbol} />}
        />
        {/* A window with no date in it has to say what the book is DOING, or
            "more than 12 months" is indistinguishable between a book that
            gains €1,200 a month and one that loses €10. Never extrapolated
            into a date — see `runway()` for why there is no honest third
            answer. */}
        {!pending && answer.kind === 'lasts' ? (
          <p className="text-caption text-muted-foreground">
            <Trans
              i18nKey="v3.money.forecast.netPerMonth"
              components={{
                value: (
                  <Numeric
                    delta
                    indicator="sign"
                    value={answer.netPerMonth.toString()}
                    currency={rates.baseSymbol}
                  />
                ),
              }}
            />
          </p>
        ) : null}
      </Block>

      <Block className="flex flex-col gap-4 border-dashed p-4">
        <div className="flex flex-col gap-3">
          <Segmented
            value={horizon}
            onValueChange={setHorizon}
            aria-label={t('v3.money.forecast.horizonSwitcher')}
          >
            {FORECAST_HORIZONS.map((option) => (
              <SegmentedItem key={option} value={`${option}`}>
                {t('v3.money.forecast.horizonOption', { count: option })}
              </SegmentedItem>
            ))}
          </Segmented>

          <ProjectedTile
            label={t('v3.money.forecast.balanceAt', {
              month: formatProjectionMonth(
                chartProjection.points.at(-1)?.month ?? forecast.today.slice(0, 7)
              ),
            })}
            value={
              pending ? (
                <span className="text-muted-foreground">{t('v3.money.forecast.working')}</span>
              ) : (
                <Numeric
                  value={(chartProjection.points.at(-1)?.balance ?? opening).toString()}
                  currency={rates.baseSymbol}
                />
              )
            }
          />
        </div>

        {pending ? (
          <DataViewSkeleton />
        ) : (
          <ProjectionChart
            points={chartProjection.points}
            opening={opening.toString()}
            currency={rates.baseSymbol}
            label={t('v3.money.forecast.chartLabel', { count: months })}
          />
        )}

        {/* The two sides of the window, each its own figure and never netted
            into one — V3-47's rule, which is about bills against income and
            holds here for the same reason: an obligation and a client's
            intention are not equally certain. The running balance above DOES
            combine them, and that is not a contradiction: a balance is
            arithmetic on a projection that is already labelled as one, while a
            single "you are €400 up" figure would present the average of two
            different certainties as a fact. */}
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <ConvertedTotal
              projected
              emphasis="default"
              label={t('v3.money.forecast.goingOut', { count: months })}
              totals={totals.outflow}
              tokenSymbolById={tokenSymbolById}
              rates={rates}
            />
          </div>
          <div className="flex flex-col gap-2">
            <ConvertedTotal
              projected
              delta
              emphasis="default"
              label={t('v3.money.forecast.comingIn', { count: months })}
              totals={totals.inflow}
              tokenSymbolById={tokenSymbolById}
              rates={rates}
            />
          </div>
        </div>
      </Block>

      <AffordabilityPanel
        oneOff={oneOff}
        onChange={setOneOff}
        verdict={verdict}
        baseSymbol={rates.baseSymbol}
        tokens={tokens}
        disabled={pending}
      />

      <ForecastCaveats forecast={forecast} />
    </div>
  );
}

/**
 * The runway, as a sentence-shaped figure.
 *
 * A month name rather than a count of months where there is one: "November
 * 2026" is a date the reader can hold against everything else they know, and
 * "5 months" is a number they then have to convert. The count is still said,
 * in the note underneath, because it is what makes two books comparable.
 */
function RunwayFigure({ answer }: { answer: ReturnType<typeof runway> }) {
  const { t } = useTranslation();

  if (answer.kind === 'exhausted') {
    return <>{t('v3.money.forecast.runsOutIn', { month: formatProjectionMonth(answer.month) })}</>;
  }
  return <>{t('v3.money.forecast.lastsBeyond', { count: answer.beyondMonths })}</>;
}

/**
 * What the liquid figure counted, and what it did not — the denominator mgrin's
 * choice of definition makes mandatory.
 *
 * He took the broadest option on offer: everything except property, private
 * positions and anything unpriced. That is the most optimistic runway of the
 * three, so the surface has to say which assets are behind it. A reader who
 * would never actually sell the equities in that number can then discount it
 * themselves, which they cannot do from a bare count of months.
 */
function RunwayBasis({ forecast, baseSymbol }: { forecast: ForecastData; baseSymbol: string }) {
  const liquid = forecast.liquid;
  const figure = <Numeric value={liquid.amount} currency={baseSymbol} />;
  const illiquid = <Numeric value={liquid.illiquid.amount} currency={baseSymbol} />;

  return (
    <>
      <Trans
        i18nKey="v3.money.forecast.basis"
        values={{ count: liquid.countedHoldings }}
        components={{ value: figure }}
      />
      {liquid.illiquid.count > 0 ? (
        <>
          {' '}
          <Trans
            i18nKey="v3.money.forecast.basisIlliquid"
            values={{ count: liquid.illiquid.count }}
            components={{ value: illiquid }}
          />
        </>
      ) : null}
      {liquid.unpriceable.count > 0 ? (
        <>
          {' '}
          <Trans
            i18nKey="v3.money.forecast.basisUnpriceable"
            values={{ count: liquid.unpriceable.count }}
          />
        </>
      ) : null}
    </>
  );
}

/**
 * What is NOT in the projection, counted rather than described.
 *
 * mgrin's ruling on variable payments (2026-08-26): admit them loudly, print
 * the count, invent nothing. `sumMonthlyEquivalentByCurrency` has always
 * skipped a payment with no estimate, and a projection that does the same
 * silently is a number that reads as complete and is not.
 */
function ForecastCaveats({ forecast }: { forecast: ForecastData }) {
  const { t } = useTranslation();
  const notes: string[] = [];

  if (forecast.unprojectable.length > 0) {
    notes.push(t('v3.money.forecast.unprojectable', { count: forecast.unprojectable.length }));
  }
  if (forecast.overdue.length > 0) {
    notes.push(t('v3.money.forecast.overdueExcluded', { count: forecast.overdue.length }));
  }

  if (notes.length === 0) return null;

  return (
    <Block className="flex flex-col gap-1.5 border-dashed p-4">
      <p className="text-label">{t('v3.money.forecast.notCounted')}</p>
      {notes.map((note) => (
        <p key={note} className="text-caption text-muted-foreground">
          {note}
        </p>
      ))}
    </Block>
  );
}
