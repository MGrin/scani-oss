import { Decimal, observedAffordability, observedRunwayMonths } from '@scani/shared';
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
  committedShare,
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
import { convertTotalsToBase } from '../../lib/paymentTotals';
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

  /**
   * The answer this page now leads with (SC-661).
   *
   * It divides the liquid balance by the rate money actually leaves the
   * tracked perimeter, through the SAME `@scani/shared` helper the home line
   * uses — which is the point rather than tidiness. This page and that line
   * reached OPPOSITE conclusions about the same account at the same instant
   * because each did its own arithmetic; one function is what stops that
   * happening again.
   *
   * `null` means the window contained no perimeter exits, and the committed
   * walk below is then the only answer there is.
   */
  const observedMonths = useMemo(
    () =>
      forecast?.observedBurn
        ? observedRunwayMonths(forecast.liquid.amount, forecast.observedBurn.perMonthMean)
        : null,
    [forecast?.liquid.amount, forecast?.observedBurn]
  );

  /**
   * The book's own monthly outflow as a SHARE of observed, never an addend.
   * Taken from the projection so it comes through the same currency
   * conversion — a second path would let the two figures on one screen
   * disagree invisibly. See `@scani/shared` `lib/burn.ts` for why committed is
   * a subset of observed and adding them halves the runway.
   */
  const share = useMemo(
    () =>
      observedMonths === null || !forecast?.observedBurn
        ? null
        : committedShare(runwayProjection, forecast.observedBurn.perMonthMean),
    [observedMonths, forecast?.observedBurn, runwayProjection]
  );

  /**
   * The one-off in base currency, through `convertTotalsToBase` — the one
   * conversion path this tab uses everywhere else.
   */
  const oneOffInBase = useMemo(() => {
    if (!oneOff) return null;
    const converted = convertTotalsToBase(
      new Map([[oneOff.currencyTokenId, new Decimal(oneOff.amount)]]),
      rates
    );
    // No rate for that currency yet: an unconverted one-off would be silently
    // treated as zero and the purchase would cost nothing.
    if (converted.unconverted.length > 0 || converted.unknown.length > 0) return null;
    return converted.amount;
  }, [oneOff, rates]);

  const observedVerdict = useMemo(
    () =>
      forecast?.observedBurn && oneOffInBase
        ? observedAffordability(
            forecast.liquid.amount,
            forecast.observedBurn.perMonthMean,
            oneOffInBase.toString()
          )
        : null,
    [forecast?.liquid.amount, forecast?.observedBurn, oneOffInBase]
  );

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

  /**
   * A projection over no movements is a flat line at the current balance — a
   * chart that says nothing, drawn with great confidence. The empty state says
   * the same thing in a sentence and offers the way out of it.
   *
   * `observedMonths === null` is load-bearing and was the SC-661 bug: this
   * used to bail on `movements.length === 0` alone, while the home line's
   * observed path has no movements guard at all. An account with perimeter
   * exits and no recurring payments therefore got a runway on the home screen
   * and "no payments recorded — add one" here, so the two screens disagreed
   * about whether the feature existed. That is worse than a number mismatch.
   */
  if (!forecast || (forecast.movements.length === 0 && observedMonths === null)) {
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
      {/* THE HERO IS OBSERVED (SC-661, mgrin). It answers the same question as
          the home line, in the same words, through the same helper.

          The committed book is not a second opinion here — on the real account
          it records ~$11,235/mo in and ~$784/mo out, because the income is a
          recurring payment and the spending happens outside the tracked
          perimeter. Projected forward that book says the money grows forever.
          It is not a different question honestly answered; it is a projection
          missing its largest term, erring in the flattering direction by
          construction. So it does not get to be the runway. */}
      <Block className="flex flex-col gap-3 border-dashed p-4">
        {/* Note the order against `pending`. The observed figure answers even
            while the rates are still coming, and that is correct rather than a
            slip: `perMonthMean` and `liquid.amount` both arrive from the
            server already in base currency, so it has no foreign half to be
            missing. SC-210's rule — a burn without rates is too small and the
            runway too long — is about the committed walk below, which is why
            that one still shows "working it out". */}
        <ProjectedTile
          emphasis="hero"
          label={t('v3.money.forecast.runwayLabel')}
          value={
            observedMonths !== null ? (
              t('v3.money.forecast.observedRunway', { count: observedMonths })
            ) : pending ? (
              <span className="text-muted-foreground">{t('v3.money.forecast.working')}</span>
            ) : (
              <RunwayFigure answer={answer} />
            )
          }
          note={<RunwayBasis forecast={forecast} baseSymbol={rates.baseSymbol} />}
        />
        {observedMonths !== null && forecast.observedBurn ? (
          <ObservedBasis burn={forecast.observedBurn} share={share} baseSymbol={rates.baseSymbol} />
        ) : null}
        {/* Only when the book is the answer, which is now the fallback. A
            window with no date in it has to say what the book is DOING, or
            "more than 12 months" is indistinguishable between a book that
            gains €1,200 a month and one that loses €10. */}
        {observedMonths === null && !pending && answer.kind === 'lasts' ? (
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

      {/* Hidden entirely when there is nothing scheduled, which is now
          reachable: the page renders on observed burn alone, and this block
          would otherwise promise "what is scheduled, and when" above a flat
          chart and two zeroes. An empty answer under a confident heading is
          the shape this whole ticket is about.

          DEMOTED, and the heading is the whole of it (SC-661). This block used
          to be the runway's evidence; it is now a separate, narrower claim —
          what the recurring book has scheduled, and when. It is still worth a
          screen: an observed $43k month says nothing about how much of it
          could be STOPPED, and the book is the only thing that does. What it
          may no longer do is answer "how long does the money last". */}
      {forecast.movements.length === 0 ? null : (
        <Block className="flex flex-col gap-4 border-dashed p-4">
          <div className="flex flex-col gap-1">
            <p className="text-label">{t('v3.money.forecast.committedTitle')}</p>
            <p className="text-caption text-muted-foreground">
              {t('v3.money.forecast.committedNote')}
            </p>
          </div>
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
      )}

      <AffordabilityPanel
        oneOff={oneOff}
        onChange={setOneOff}
        verdict={verdict}
        observedVerdict={observedVerdict}
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
 * The denominators under the observed figure — what the mean was taken over,
 * what it hid, and what it could not count.
 *
 * ## Why the MEDIAN is printed beside the mean
 *
 * Measured on mgrin's real book 2026-08-26: mean $13,984.20 against median
 * $7,504.95, min $3,999.52, max $43,563.15. **The mean is 1.86x the median**,
 ***REMOVED***
 ***REMOVED***
 * exceptional months.
 *
 * SC-657 chose the mean deliberately and correctly: total ÷ months IS the rate
 * the balance actually drained at, and a $43k month is real money that really
 ***REMOVED***
 * empty. But a figure that far from the typical month has to say so, or the
 * line alarms the reader about a distribution while sounding like a trend.
 *
 * So the label names the statistic — "Mean of 6 complete months" rather than
 * "Averaged over" — and the middle month is printed next to the range. Neither
 * surface said which statistic it used before this.
 *
 * Every one of these is here because a single number over $4k-$43k months,
 * presented alone, is more confident than the data. The spread says so; the
 * excluded count says how many outflows the figure did not see; the committed
 * share says how much of the spending is contractual rather than
 * discretionary — the one question the recurring book genuinely answers.
 *
 * `excluded.unclassified` is the one to watch. Those are outflows nobody has
 * answered the review question on, and they are treated as zero. If they are
 * a large share, the burn is understated and the runway is too long — the
 * flattering direction again, which is why the count is printed rather than
 * folded away.
 */
function ObservedBasis({
  burn,
  share,
  baseSymbol,
}: {
  burn: NonNullable<ForecastData['observedBurn']>;
  share: Decimal | null;
  baseSymbol: string;
}) {
  const { t } = useTranslation();
  /**
   * THREE TERMS, AND THEY ARE NOT IN HERE FOR THE SAME REASON.
   *
   * `internal` is deliberately NOT in this sum. A `paired` or `internal`
   * answer names a destination INSIDE the perimeter, so the money
   * demonstrably did not leave; its absence from the burn is the answer, not
   * a gap. Counting it would invite a reader to see those transactions as
   * missing burn when they are the opposite.
   *
   * `unclassified` and `unvalued` are gaps plainly: nobody answered, or it
   * left and could not be priced. Both are treated as zero in the mean, so
   * the runway is too long by whatever they were — the flattering direction,
   * which is why the count is printed rather than folded away.
   *
   * `untracked` is in the total for a DIFFERENT reason, and it is the one
   * that can go wrong silently. By the vocabulary it is not a gap at all —
   * it means the money is still his, in an account Scani cannot see, so coin
   * to a cold wallet is wealth changing address rather than spending, and
   * `ObservedBurnService` excludes it on exactly that reading.
   *
   * But that reading is an ASSUMPTION. mgrin describes his spending
   * destination as "current accounts, not tracked by scani" — word for word
   * the other vocabulary term. If his answers start landing on `untracked`,
   * burn falls, the runway lengthens, and nothing goes red. `untracked`
   * rising while the total falls is the only place it would ever show, so
   * counting it here is what puts that assumption on a screen instead of
   * leaving it in a service header. It is 0 today, which is the empirical
   * case for the current reading and precisely why nobody would notice it
   * moving.
   *
   * If this total is ever itemised: `internal` is excluded because the money
   * stayed, `untracked` because we BELIEVE it stayed. Different claims,
   * different confidence.
   */
  const notCounted = burn.excluded.unclassified + burn.excluded.untracked + burn.excluded.unvalued;

  return (
    <div className="flex flex-col gap-1">
      <p className="text-caption text-muted-foreground">
        <Trans
          i18nKey="v3.money.forecast.observedBasis"
          values={{ count: burn.windowMonths, from: burn.fromMonth, to: burn.toMonth }}
          components={{
            value: <Numeric value={burn.perMonthMean} currency={baseSymbol} />,
          }}
        />
      </p>
      {burn.perMonthMin !== burn.perMonthMax ? (
        <p className="text-caption text-muted-foreground">
          <Trans
            i18nKey="v3.money.forecast.observedSpread"
            components={{
              min: <Numeric value={burn.perMonthMin} currency={baseSymbol} />,
              max: <Numeric value={burn.perMonthMax} currency={baseSymbol} />,
              median: <Numeric value={burn.perMonthMedian} currency={baseSymbol} />,
            }}
          />
        </p>
      ) : null}
      {share ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.money.forecast.ofWhichCommitted', { percent: share.times(100).toFixed(0) })}
        </p>
      ) : null}
      {/* PROVENANCE SITS ABOVE THE EXCLUDED SENTENCE, and the placement is part
          of the fix rather than a layout preference (SC-661, mgrin).

          The excluded line is a small honest caveat about 4 EXCLUDED rows. This
          is a large claim about 76% of the value that IS COUNTED. They are
          OPPOSITE OPERATIONS, and adjacent they read as two versions of one
          caveat — a reader who has just been told some rows were left out takes
          the next qualifier as more of the same and stops. Arriving second, the
          larger claim would be dressed as a footnote to the smaller one. */}
      <BurnProvenance burn={burn} />
      {notCounted > 0 ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.money.forecast.observedNotCounted', { count: notCounted })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Who classified the money the burn is MADE OF (SC-661/SC-673).
 *
 * ## By value, never by count, and that is a measurement not a style
 *
 * The figure above is money and months derived from money, so a count-weighted
 * share describes a different quantity than the number it qualifies. Measured
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 ***REMOVED***
 * source.
 *
 * The count is the flattering reading, and `ObservedBurnService` returns no
 * counts at all so it cannot be rendered here by accident. This feature has
 * erred flattering at every layer examined — the committed book, the decoder,
 * and a declared estimate would have too. The caption that exists to stop that
 * must not do it as well.
 *
 * ## THE MIDDLE CLASS RENDERS EMPTY ON THE ONE BOOK WE HAVE, AND IS NOT DEAD
 *
 * Read this before deleting the branch. Within the burn window's
 * `left_control` rows the split is 34 user / **0 automated** / 45
 * unattributed, so this line never appears for that account. **It is not empty
 * book-wide: 30 rows across his book decode as `repair`.** Narrow claim, and
 * the narrowness is the point — an earlier draft of this comment said "never
 * renders on his data", which was false and would have survived, because
 * nothing about it invites doubt.
 *
 * The class earns its place through an ASYMMETRY in that data. The
 * transfer-linking repair job DOES stamp itself — all 5 internal/paired rows
 * carry `repair` — so whatever answered the unstamped rows was **not** that
 * job. The benign reading, that a known mechanism did it and forgot to stamp,
 * is ruled out by the known mechanism stamping. Collapsing `automated` into
 * `unattributed` would erase the difference between "a rule you can go and
 * read decided this" and "no code path we know of decided this", which is the
 * same error as collapsing `internal` into `untracked` on the excluded side:
 * one is a fact, the other is the absence of one.
 *
 * ## What is deliberately NOT claimed
 *
 * Nothing here says what wrote the unattributed rows. The data cannot say, and
 * the honest claim is the narrow one: nobody recorded who decided.
 *
 * The value is the burn's own quantity proxy rather than
 ***REMOVED***
 * these outflows are essentially all dollar-denominated. Stated because the
 * percentages are printed to the whole number and that difference cannot move
 * one.
 */
function BurnProvenance({ burn }: { burn: NonNullable<ForecastData['observedBurn']> }) {
  const { t } = useTranslation();

  const total = new Decimal(burn.provenance.user)
    .plus(burn.provenance.automated)
    .plus(burn.provenance.unattributed);
  // A share of nothing is not 0%, it is a question with no answer — the same
  // rule `committedShareOfObserved` follows. A window with no counted exits
  // says nothing rather than reporting three confident zeroes.
  if (total.lessThanOrEqualTo(0)) return null;

  /**
   * THE GUARD IS ON THE AMOUNT AND THE SENTENCE PRINTS A PERCENT, WHICH ARE
   * DIFFERENT QUANTITIES (SC-661, found by reading the DEPLOYED chunk rather
   * than the source).
   *
   * Every class below renders when its amount is `> 0`. Rounded to whole
   * percent, an amount that is positive but under half a percent of the total
   * printed "0% of that value rests on answers you gave." — a measurement
   * asserting zero, which is strictly worse than the silence the guard was
   * written to produce. Absent says nothing; `0%` says something false.
   *
   * `<1` rather than raising the guard, because suppressing a small class
   * asserts it contributed NOTHING, which is the same false claim in the other
   * direction. Absent stays reserved for a class that is genuinely empty.
   *
   * It could not appear on the book this shipped against: `automated` is
   * exactly 0 there, so it takes the null branch. The case that separates
   * "renders when the amount is > 0" from "renders when the PRINTED figure is
   * > 0" needs a value both positive and tiny, and that book has none — which
   * is why this survived to production and why the test below constructs one.
   *
   * THE ARGUMENT IS ALREADY IN THIS REPO AND SHIPPED. `format/precision.ts`
   * (SC-567) on dust quantities: "WHAT MAY NOT HAPPEN ON EITHER IS `0`. That
   * is not a rounding of a small position, it is a different claim — that the
   * position is empty". Its `vanishesAt(absolute, decimals)` is this predicate
   * with one argument different; kept local rather than exported, because
   * exporting a predicate to serve one caller is how a shared module accretes.
   *
   * THE OBVIOUS OBJECTION IS ON THE RECORD THERE, AND IT DOES NOT REACH HERE.
   * That same file REFUSES a `<0.01` marker for money, because a statement's
   * reader multiplies unit price by quantity and checks it against the row
   * total, and a threshold cannot be multiplied out. Nobody multiplies these
   * three percentages by anything — they are captions, not factors in any
   * arithmetic on this screen.
   *
   * Triggered on the printed string rather than a numeric threshold. Today
   * `lessThan(0.5)` would agree with it exactly: `decimal.ts:12` sets
   * `rounding: ROUND_HALF_UP` project-wide, so there is no live boundary bug
   * and this is not fixing one. It is written this way so it cannot drift from
   * a global someone changes later — comparing the output to `'0'` is what
   * would have printed, rather than a second model of it.
   *
   * KNOWN CEILING, deliberately not fixed: three independently rounded shares
   * can print 99 or 101. They are three separate sentences that never claim to
   * total 100, and largest-remainder apportionment to make captions add up
   * costs more than the artefact. `<1` also carries its own approximation on
   * its face, so the reader most likely to add them up is already told not to
   * expect exactness. Revisit if the shares are ever itemised into one line
   * that does claim it.
   */
  const pct = (amount: string): string => {
    const share = new Decimal(amount).dividedBy(total).times(100);
    const printed = share.toFixed(0);
    return printed === '0' && share.greaterThan(0) ? '<1' : printed;
  };

  return (
    <div className="flex flex-col gap-1 border-t border-dashed border-border pt-2">
      <p className="text-caption font-medium text-foreground">
        {t('v3.money.forecast.provenanceTitle')}
      </p>
      {new Decimal(burn.provenance.user).greaterThan(0) ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.money.forecast.provenanceUser', { percent: pct(burn.provenance.user) })}
        </p>
      ) : null}
      {new Decimal(burn.provenance.automated).greaterThan(0) ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.money.forecast.provenanceAutomated', { percent: pct(burn.provenance.automated) })}
        </p>
      ) : null}
      {new Decimal(burn.provenance.unattributed).greaterThan(0) ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.money.forecast.provenanceUnattributed', {
            percent: pct(burn.provenance.unattributed),
          })}
        </p>
      ) : null}
    </div>
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
