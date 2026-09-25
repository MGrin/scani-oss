import { Decimal, formatDate, observedAffordability, observedRunwayMonths } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Input } from '@scani/ui/ui/input';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { Block } from '@scani/ui/v3/components/Block';
import { DataViewEmpty } from '@scani/ui/v3/components/data-view/DataViewEmpty';
import { DataViewSkeleton } from '@scani/ui/v3/components/data-view/DataViewSkeleton';
import { LoadingRamp } from '@scani/ui/v3/components/feedback/LoadingRamp';
import { QueryError } from '@scani/ui/v3/components/feedback/QueryError';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useDelayedLoading } from '@scani/ui/v3/hooks/useDelayedLoading';
import type { V3QueryState } from '@scani/ui/v3/lib/query-state';
import { ChevronDown, TrendingDown } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { BaseCurrencyRates } from '@/hooks/useBaseCurrencyRates';
import { type RouterOutputs, trpc } from '@/lib/trpc';
import { useViewPreference } from '../../hooks/useViewPreference';
import {
  affordability,
  bucketMovements,
  DEFAULT_FORECAST_HORIZON,
  FORECAST_HORIZONS,
  type ForecastHorizon,
  type MaterialCaveat,
  materialCaveats,
  monthAfter,
  monthSequence,
  type OneOffOutflow,
  observedDecline,
  project,
  projectedShare,
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
 * ## What the surface admits to, and WHERE it admits it (SC-1068)
 *
 * The honesty is unchanged and none of it was deleted. What moved is its
 * PLACE. Measured at 390px before this ticket: the answer was one line and the
 * methodology under it was nine, filling 500px of a 714px scroller, and the
 * affordability checker — the one control here that asks a question a person
 * actually has — sat 1153px below the fold, more than a full screen down. That
 * is what "very awkward presentation" was describing, and it was not
 * carelessness: the view was built to say what it could not count before it
 * said what it found, which is a value this codebase holds correctly
 * elsewhere. Here it inverted the page, and an answer that arrives tenth reads
 * as unreliable whatever it says.
 *
 * So: the verdict and its date first, the line that verdict IS underneath it,
 * then only the caveats that could move it (`materialCaveats` in
 * `lib/forecast.ts` carries the whole argument for what "could" means), then
 * the affordability checker, then the book. Everything else is one tap away
 * behind `<ForecastMethod>` rather than scrolled past.
 *
 * Two caveats were RE-PARENTED rather than filtered, and that is a correction
 * of fact rather than a presentation choice: `unprojectable` and `overdue`
 * qualify the recurring book's walk, not the observed runway, so they now sit
 * with the block that draws that walk. They were never able to move the
 * headline.
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
  /**
   * SC-625's opt-in, as a callback for the same reason the tokens arrive as a
   * prop: this view holds no tRPC. `paymentIds` are named rather than a "all
   * of them" flag, so the set the reader agreed to is the set that changes —
   * see the router procedure's own doc.
   */
  onEstimateFromHistory?: (paymentIds: string[], enabled: boolean) => void;
  /** A write is in flight; the two buttons below disable rather than vanish. */
  estimateFromHistoryPending?: boolean;
}

export function ForecastView({
  forecast,
  tokenSymbolById,
  rates,
  query,
  paymentCount,
  tokens,
  onEstimateFromHistory,
  estimateFromHistoryPending = false,
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
  /**
   * WHAT THE RUNWAY IS ACTUALLY DIVIDED BY (SC-661).
   *
   * The measured drain unless the user has OVERRIDDEN it, in which case his
   * figure is the answer — that is the whole point of the override, and a
   * headline that went on dividing by the measurement would have taken his
   * correction and ignored it.
   *
   * Derived ONCE and used by every consumer below. Two notions of "what you
   * spend a month" on one screen — a runway from his figure beside a committed
   * share of the measured one — is this ticket's own defect, two surfaces
   * disagreeing, rebuilt inside a single component.
   *
   * A `confirmed` answer does NOT change it: agreeing with the measurement is
   * not replacing it. Neither does `currencyChanged`, which is an answer that
   * no longer applies rather than a different figure.
   */
  const effectiveBurn =
    forecast?.observedBurnAnswer?.kind === 'override'
      ? forecast.observedBurnAnswer.amount
      : (forecast?.observedBurn?.perMonthMean ?? null);

  const observedMonths = useMemo(
    () =>
      forecast?.observedBurn && effectiveBurn !== null
        ? observedRunwayMonths(forecast.liquid.amount, effectiveBurn)
        : null,
    [forecast?.liquid.amount, forecast?.observedBurn, effectiveBurn]
  );

  /**
   * The book's own monthly outflow as a SHARE of observed, never an addend.
   * Taken from the projection so it comes through the same currency
   * conversion — a second path would let the two figures on one screen
   * disagree invisibly. See `@scani/shared` `lib/burn.ts` for why projected is
   * a subset of observed and adding them halves the runway.
   */
  const share = useMemo(
    () =>
      observedMonths === null || !forecast?.observedBurn || effectiveBurn === null
        ? null
        : projectedShare(runwayProjection, effectiveBurn),
    [observedMonths, forecast?.observedBurn, runwayProjection, effectiveBurn]
  );

  /**
   * THE DATE, which the page did not have (SC-1068).
   *
   * `observedRunwayMonths` answers in whole months and the page printed that
   * count, so a reader wanting "when" had to add 27 months to today in their
   * head. This is that addition, through `monthSequence`'s own calendar walk
   * so it cannot drift from the months the chart is drawn over.
   *
   * `null` when the window has no perimeter exits — the committed walk below
   * is then the only answer there is, and it has a date of its own.
   */
  const runwayMonth = useMemo(
    () => (forecast && observedMonths !== null ? monthAfter(forecast.today, observedMonths) : null),
    [forecast, observedMonths]
  );

  /** The verdict, drawn. See `observedDecline` for why it is not the book's
   *  walk — on a book funded from outside the perimeter that line RISES, and
   *  a rising chart under "the money lasts N months" is two answers stacked. */
  const decline = useMemo(
    () =>
      forecast && observedMonths !== null && effectiveBurn !== null
        ? observedDecline(forecast.liquid.amount, effectiveBurn, forecast.today, observedMonths)
        : null,
    [forecast, observedMonths, effectiveBurn]
  );

  /** The seam. `lib/forecast.ts` carries the argument; nothing is decided here. */
  const material = useMemo(
    () =>
      forecast
        ? materialCaveats({
            liquid: forecast.liquid,
            perMonth: effectiveBurn,
            perMonthMedian: forecast.observedBurn?.perMonthMedian ?? null,
            denominatorIsMeasured: forecast.observedBurnAnswer?.kind !== 'override',
            notCountedOutflows: forecast.observedBurn
              ? forecast.observedBurn.excluded.unclassified +
                forecast.observedBurn.excluded.untracked +
                forecast.observedBurn.excluded.unvalued
              : 0,
          })
        : [],
    [forecast, effectiveBurn]
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

          The committed book is not a second opinion here — it records a large
          recurring inflow against a near-zero outflow (illustratively
          ~$4,200/mo in and ~$60/mo out; synthetic values, same shape), because
          the income is a recurring payment and the spending happens outside
          the tracked perimeter. Projected forward that book says the money
          grows forever. It is not a different question honestly answered; it
          is a projection missing its largest term, erring in the flattering
          direction by construction. So it does not get to be the runway. */}
      <Block className="flex flex-col gap-3 border-dashed p-4">
        {/* THE VERDICT IS THE LABEL AND THE VALUE TOGETHER, READ AS ONE
            SENTENCE: "You're OK until — Feb 2029" (SC-1068).

            mgrin asked for a plain verdict plus the date things get tight. The
            DATE is what takes `text-display`, and that is a measurement rather
            than a preference: the type scale has six roles and nothing between
            20px and 44px (`v3-tokens-root.css`), so a sentence set at display
            size wraps — the previous hero, "About 27 months at recent
            spending", wrapped to FOUR lines and took 190px of a 844px phone.
            `formatProjectionMonth` renders a short month, so the date fits the
            326px of content a 390px viewport leaves and the claim is one line.

            TWO STATES AND NO THIRD (mgrin, 2026-09-07). A "getting tight" band
            between them was offered and declined, on the reasoning
            `materialCaveats` is built from: a band needs a number somebody has
            to defend, and the DATE already carries the nuance a band would
            have approximated.

            THE BOUNDARY IS THE WINDOW THIS BLOCK ALREADY DECLARES IT ANSWERS
            OVER, so it is not a new parameter — `horizonMonths`, the full
            twelve months the server returns, which the class doc above states
            the runway is always answered across. A runway ending inside the
            window the page is about is the not-OK state; one reaching past it
            is the OK state. Both name a date, which is why the split costs the
            reader nothing: the sentence tells you which side you are on and the
            figure tells you by how much.

            The duration is not lost; it is the line underneath, in the words
            it was already translated into. */}
        {runwayMonth !== null ? (
          <>
            <ProjectedTile
              emphasis="hero"
              label={t(
                observedMonths !== null && observedMonths >= forecast.horizonMonths
                  ? 'v3.money.forecast.verdictOk'
                  : 'v3.money.forecast.verdictRunsOut'
              )}
              value={formatProjectionMonth(runwayMonth)}
            />
            {/* `text-body`, not `text-caption`. This is the second half of the
                answer, not a qualification of it, and the caption role is what
                every qualification on this surface uses. */}
            <p className="text-body text-muted-foreground">
              {t('v3.money.forecast.observedRunway', { count: observedMonths ?? 0 })}
            </p>
          </>
        ) : (
          /* No perimeter exits in the window, so there is no measured rate to
             divide and the committed walk is the only answer there is. It
             carries its own date when it reaches zero, and when it does not it
             has to say what the book is DOING — "more than 12 months" is
             otherwise indistinguishable between a book gaining and one barely
             losing. */
          <>
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
            />
            {!pending && answer.kind === 'lasts' ? (
              <p className="text-body text-muted-foreground">
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
          </>
        )}

        {/* THE BALANCE-OVER-TIME LINE, and it is the verdict drawn rather than
            a second opinion — `liquid − burn × t`, the same division the
            sentence above rounds. Its x-intercept IS the date that sentence
            names, so the two cannot disagree. The book's own walk keeps its
            chart, its horizon control and its wiggle, in the block below that
            is explicitly about the book. */}
        {decline !== null && runwayMonth !== null ? (
          <ProjectionChart
            points={decline}
            opening={forecast.liquid.amount}
            currency={rates.baseSymbol}
            label={t('v3.money.forecast.declineLabel', {
              month: formatProjectionMonth(runwayMonth),
            })}
            height={160}
          />
        ) : null}

        {/* ONLY WHAT COULD MOVE THE ANSWER. The rule, the two arms and every
            candidate it rules out are in `materialCaveats`; nothing about
            "material" is decided at this call site, deliberately. */}
        {material.length > 0 ? (
          <div className="flex flex-col gap-1">
            {material.map((caveat) => (
              <MaterialCaveatLine
                key={caveat.kind}
                caveat={caveat}
                burn={forecast.observedBurn}
                baseSymbol={rates.baseSymbol}
              />
            ))}
          </div>
        ) : null}

        {/* Everything the page used to lead with. Reachable in one tap, and
            still on the same screen as the figure it qualifies — which is the
            half of SC-461's rule that survives this ticket intact: a caveat
            that scrolls away from its number is not a caveat, and one behind a
            control that names it does not scroll away. */}
        <ForecastMethod
          forecast={forecast}
          share={share}
          baseSymbol={rates.baseSymbol}
          promoted={new Set(material.map((caveat) => caveat.kind))}
        />
      </Block>

      {/* PROMOTED TO SECOND (SC-1068). The ticket names this the one part of
          the view that asks a question a person actually has, and it was
          measured at 1153px below the fold on a 390px phone — past the whole
          methodology, past the book's chart, past two totals. Directly under
          the answer it is the natural next question: that is how long the
          money lasts, so what does this cost me. */}
      <AffordabilityPanel
        oneOff={oneOff}
        onChange={setOneOff}
        verdict={verdict}
        observedVerdict={observedVerdict}
        baseSymbol={rates.baseSymbol}
        tokens={tokens}
        disabled={pending}
      />

      {/* Hidden entirely when there is nothing scheduled, which is now
          reachable: the page renders on observed burn alone, and this block
          would otherwise promise "what is scheduled, and when" above a flat
          chart and two zeroes. An empty answer under a confident heading is
          the shape this whole ticket is about.

          DEMOTED, and the heading is the whole of it (SC-661). This block used
          to be the runway's evidence; it is now a separate, narrower claim —
          what the recurring book has scheduled, and when. It is still worth a
          screen: an observed heavy month — $18k where a quiet one is $2k,
          on the synthetic spread below — says nothing about how much of it
          could be STOPPED, and the book is the only thing that does. What it
          may no longer do is answer "how long does the money last". */}
      {forecast.movements.length === 0 ? null : (
        <Block className="flex flex-col gap-4 border-dashed p-4">
          <div className="flex flex-col gap-1">
            {/* "Projected", never "Committed": this walk substitutes a payment's own
                settled history (`basis: 'history'` in `buildForecast`), so an
                estimate is inside the figure. See `RecurringSummary` for the rule
                and why "Expected" is not available (SC-817). */}
            <p className="text-label">{t('v3.money.forecast.projectedTitle')}</p>
            <p className="text-caption text-muted-foreground">
              {t('v3.money.forecast.projectedNote')}
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

      {/* RE-PARENTED, not filtered (SC-1068). Both of these qualify the
          RECURRING BOOK's walk — a variable payment with no estimate and a
          bill already overdue are missing from the projected series and from
          nothing else — so neither was ever able to move the observed runway
          the page now leads with. They belong next to the figure they
          actually qualify, and the seam never had to judge them. */}
      <ForecastEstimates
        forecast={forecast}
        onEstimateFromHistory={onEstimateFromHistory}
        pending={estimateFromHistoryPending}
      />

      <ForecastCaveats
        forecast={forecast}
        onEstimateFromHistory={onEstimateFromHistory}
        pending={estimateFromHistoryPending}
      />
    </div>
  );
}

/**
 * The kinds already stated beside the answer, so nothing is printed twice.
 *
 * A set rather than a list of booleans: the seam returns a list of kinds and
 * the two derivation components each ask about a different one, so a shape
 * that grows with the seam and needs no second edit is the honest one.
 */
type PromotedKinds = ReadonlySet<MaterialCaveat['kind']>;

/**
 * A caveat that could move the answer, in the words it already had.
 *
 * These are the SAME strings the derivation used, deliberately: this ticket is
 * about placement and precedence, not about rewriting copy that is already
 * translated into eight languages and already says the true thing. What
 * changed is that they are now shown only when `materialCaveats` says they
 * could move the figure they sit under — and are absent, rather than reworded,
 * when it says they could not.
 *
 * They take `text-caption` like every other qualification on this surface, and
 * that is the point of the redesign rather than an oversight: a caveat is
 * still a caveat when it is material. What it is not, any more, is the first
 * thing on the page.
 */
function MaterialCaveatLine({
  caveat,
  burn,
  baseSymbol,
}: {
  caveat: MaterialCaveat;
  burn: ForecastData['observedBurn'];
  baseSymbol: string;
}) {
  const { t } = useTranslation();

  if (caveat.kind === 'illiquid') {
    return (
      <p className="text-caption text-muted-foreground">
        <Trans
          i18nKey="v3.money.forecast.basisIlliquid"
          values={{ count: caveat.count }}
          components={{ value: <Numeric value={caveat.amount} currency={baseSymbol} /> }}
        />
      </p>
    );
  }

  if (caveat.kind === 'notCounted') {
    return (
      <p className="text-caption text-muted-foreground">
        {t('v3.money.forecast.observedNotCounted', { count: caveat.count })}
      </p>
    );
  }

  // `spread`. Guarded rather than asserted: the seam only ever raises this
  // with an observed burn in hand, but a component that would throw if that
  // ever stopped being true is one this page cannot afford — it is the page
  // whose whole job is answering how long the money lasts.
  if (!burn) return null;
  return (
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
  );
}

/**
 * HOW THE ANSWER WAS WORKED OUT — everything this page used to lead with.
 *
 * ## Nothing here was deleted, and that distinction is the whole ticket
 *
 * SC-1068 is a complaint about PRECEDENCE, not about honesty. The window the
 * mean was taken over, who classified the money it is made of, what could not
 * be priced, what is already overdue — every one of those still renders, in
 * the order and with the arguments SC-661/SC-673 gave them, on the same screen
 * as the figure they qualify. They are one tap away instead of ahead of the
 * answer.
 *
 * That keeps the half of SC-461's rule this ticket does not touch: *a caveat
 * that scrolls away from the number it qualifies is not a caveat*. A caveat
 * behind a control that names it has not scrolled away — it is on the same
 * block, and opening it costs one tap rather than a screen and a half of
 * scrolling past it, which is what the measurement found.
 *
 * ## THE CONFIDENCE STATEMENTS ARE IN HERE UNCONDITIONALLY, AND HE RULED IT
 *
 * The provenance split, the stale-quote count and the "mean of N complete
 * months" line do not change the number — they change how much of it you
 * should believe. So `materialCaveats` cannot judge them: there is no
 * "including it" to compute, and asking whether they move the answer returns
 * *cannot say* for every account, which would make the filter always-show, i.e.
 * no filter. They are not passed through it and they are not conditional.
 *
 * **This reversed an argument attributed to mgrin by name** — the comments
 * below, which are rewritten rather than deleted for exactly that reason.
 * SC-661 was his response to not recognising the figure, remedy EXPLAIN BEFORE
 * ASKING; SC-1068 is the same man on the same block, remedy ZERO
 * QUALIFICATIONS BEFORE THE ANSWER. **Asked which wins, he chose SC-1068, on
 * 2026-09-07.** Not a worker's call, and not taken as one.
 *
 * ## Closed by default, and `<details>` rather than `<Accordion>`
 *
 * A disclosure that opens itself has moved the qualifications back above the
 * answer while looking like it did not — this ticket with an extra control in
 * it — so it starts closed.
 *
 * `<details>` is the primitive, and the choice is about what a CLOSED
 * disclosure contains. Radix's accordion unmounts its content, so the
 * provenance and the excluded counts leave the document entirely; find-in-page
 * cannot reach them, and neither can this component's own tests, which render
 * through `renderToStaticMarkup` and assert on strings. A caveat a reader
 * cannot search for and a guard that cannot see it are both worse than a
 * chevron. `<details>` keeps the text in the DOM, and browsers expand it to
 * show a find-in-page hit. `GenericJobResult` already uses it here.
 *
 * ## The tap target, and what this row does NOT get
 *
 * `min-h-tap` is banned in app v3 source (`token-hygiene.test.ts`) because on
 * a non-interactive element it forces a 44px row on a MOUSE, which is what
 * V3-23 exists to undo. The hit area is supposed to come from the token layer
 * instead — and that layer's coarse-pointer floor lists `button`,
 * `[role='button']`, `a[href]` and friends, with **no `summary`**
 * (`v3-tokens.css`, the `@media (pointer: coarse)` block). So this row asks
 * for its height by padding, which is what the hygiene rule tells a surface to
 * do, and lands a little under 44 on touch.
 *
 * Stated rather than silently accepted: `GenericJobResult`'s `<details>` is
 * the same, so adding `summary` to that selector list would fix both in one
 * line. That is a change to a shared token file affecting every v3 screen, so
 * it is offered as its own ticket rather than folded into a forecast redesign.
 */
function ForecastMethod({
  forecast,
  share,
  baseSymbol,
  promoted,
}: {
  forecast: ForecastData;
  share: Decimal | null;
  baseSymbol: string;
  promoted: PromotedKinds;
}) {
  const { t } = useTranslation();
  const observedMonths =
    forecast.observedBurn && forecast.observedBurnAnswer?.kind === 'override'
      ? forecast.observedBurnAnswer.amount
      : (forecast.observedBurn?.perMonthMean ?? null);

  return (
    <details className="group border-t border-dashed border-border">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-3 text-caption text-muted-foreground transition-colors duration-fast ease-emphasized hover:text-foreground [&::-webkit-details-marker]:hidden">
        {t('v3.money.forecast.methodTitle')}
        <ChevronDown
          aria-hidden="true"
          className="h-4 w-4 shrink-0 transition-transform duration-base ease-emphasized group-open:rotate-180"
        />
      </summary>
      <div className="flex flex-col gap-2 pb-2">
        <p className="text-caption text-muted-foreground">
          <RunwayBasis forecast={forecast} baseSymbol={baseSymbol} promoted={promoted} />
        </p>
        {forecast.observedBurn && observedMonths !== null ? (
          <ObservedBasis
            burn={forecast.observedBurn}
            share={share}
            baseSymbol={baseSymbol}
            answer={forecast.observedBurnAnswer}
            promoted={promoted}
          />
        ) : null}
      </div>
    </details>
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
function RunwayBasis({
  forecast,
  baseSymbol,
  promoted,
}: {
  forecast: ForecastData;
  baseSymbol: string;
  /** Kinds already stated beside the answer. Printed once, never twice: a
   *  reader who opens the derivation to check a sentence they just read and
   *  finds it again learns nothing and doubts they read it the first time. */
  promoted: PromotedKinds;
}) {
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
      {liquid.illiquid.count > 0 && !promoted.has('illiquid') ? (
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
 * Illustrative of the case this guards, with the same SHAPE as the account it
 * was measured against but synthetic values: a mean well above the median, over
 * a range spanning an order of magnitude. **A mean near twice the median** makes
 * the choice of statistic more than a rounding difference — it is one runway
 * against nearly double it on the same balance, driven by one or two
 * exceptional months.
 *
 * SC-657 chose the mean deliberately and correctly: total ÷ months IS the rate
 * the balance actually drained at, and an exceptional month is real money that
 * really left. A median-based runway survives on paper past the point the account is
 * empty. But a figure that far from the typical month has to say so, or the
 * line alarms the reader about a distribution while sounding like a trend.
 *
 * So the label names the statistic — "Mean of 6 complete months" rather than
 * "Averaged over" — and the middle month is printed next to the range. Neither
 * surface said which statistic it used before this.
 *
 * Every one of these is here because a single number over months spanning
 * $2k-$18k — synthetic, as above — presented alone, is more confident than
 * the data. The spread says so; the excluded count says how many outflows the
 * figure did not see; the committed share says how much of the spending is
 * contractual rather than discretionary — the one question the recurring book
 * genuinely answers.
 *
 * `excluded.unclassified` is the one to watch. Those are outflows nobody has
 * answered the review question on, and they are treated as zero. If they are
 * a large share, the burn is understated and the runway is too long — the
 * flattering direction again, which is why the count is printed rather than
 * folded away.
 *
 * `staleValued` is the newest of them and the only one about the PRICE rather
 * than about which rows were seen (SC-956). `ObservedBurnService` has counted
 * it since SC-151 and nothing rendered it, so a mean built partly on quotes
 * weeks old reached this page presented exactly like one built on today's —
 * and the runway on the home screen is that mean divided into the liquid
 * total, so the same silence carried one figure further.
 */
function ObservedBasis({
  burn,
  share,
  baseSymbol,
  answer,
  promoted,
}: {
  burn: NonNullable<ForecastData['observedBurn']>;
  share: Decimal | null;
  baseSymbol: string;
  answer: ForecastData['observedBurnAnswer'] | undefined;
  /** See `RunwayBasis`. The ORDERING arguments below are unchanged; what a
   *  promoted kind removes is one line, not the sequence the rest sit in. */
  promoted: PromotedKinds;
}) {
  const { t } = useTranslation();
  /**
   * THIS SUM MOVED TO `materialCaveats` AND THE REASONING CAME WITH IT
   * (SC-1068). The sentence it fed rendered exactly when the count was above
   * zero, and the seam's second arm promotes it on exactly that condition — so
   * a copy left here could never render. What follows is why the three terms
   * are the three terms, kept because `materialCaveats` takes the total and
   * cannot state it.
   *
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
      {burn.perMonthMin !== burn.perMonthMax && !promoted.has('spread') ? (
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
          {t('v3.money.forecast.ofWhichProjected', { percent: share.times(100).toFixed(0) })}
        </p>
      ) : null}
      {/* SUPERSEDED BY SC-1068 ON MGRIN'S RULING OF 2026-09-07. Rewritten
          rather than deleted, because a reversal with no record reads as drift
          and the next reader restores what was reversed.

          WHAT SC-661 DECIDED, and it was his call too: provenance sat ABOVE the
          excluded sentence, and the placement was part of the fix rather than a
          layout preference. Its reason was sound and is worth keeping. The
          excluded line is a small honest caveat about a handful of EXCLUDED
          rows; provenance is a large claim about the majority of the value that
          IS COUNTED. Opposite operations — adjacent and in that order, a reader
          who has just been told some rows were left out takes the next
          qualifier as more of the same and stops, so the larger claim arrives
          dressed as a footnote to the smaller one.

          WHY IT NO LONGER APPLIES. The two are no longer adjacent, and cannot
          be. The excluded sentence is a MATERIAL caveat under `materialCaveats`
          — it carries no magnitude, and counting those rows can only shorten
          the runway — so it sits beside the answer. Provenance is a CONFIDENCE
          statement: it does not change the number, it changes how much of it
          you should believe, so there is no "including it" to compute and the
          materiality test returns *cannot say* for every account. A test that
          can only answer that is not a filter, which is why it goes behind the
          disclosure unconditionally rather than by rule.

          Separated by a disclosure control, neither can be read as a footnote
          to the other whatever order the document is in — which is a stronger
          form of the guarantee SC-661 bought with an ordering.

          THE TWO DECISIONS ARE GENUINELY OPPOSED AND HE SETTLED IT. SC-661 was
          his response to not recognising the figure, remedy EXPLAIN BEFORE
          ASKING. SC-1068 is the same man on the same block, remedy ZERO
          QUALIFICATIONS BEFORE THE ANSWER. Asked which wins, he chose SC-1068.
          `forecast.test.tsx` asserts the separation, so restoring the old order
          fails a test rather than passing quietly. */}
      <BurnProvenance burn={burn} />
      {burn.staleValued > 0 ? (
        // SITS BETWEEN PROVENANCE AND THE EXCLUDED LINE, and both neighbours
        // are why (SC-956). It is a claim about rows that ARE counted, like
        // provenance and unlike `notCounted`, so it belongs on that side of
        // the break. And it is the smaller of the two counted-value claims, so
        // it goes second — the same ordering argument the provenance block
        // above states, applied one step down.
        //
        // The direction is NOT stated, and that is the difference from every
        // other clause here. `unclassified` and `unvalued` are treated as zero,
        // so the burn is understated and the runway too long — the flattering
        // direction, which is worth naming. A quote from three weeks ago is
        // not systematically high or low; asserting a direction would be
        // inventing one. What the reader needs is that the figure moved on a
        // price nobody refreshed.
        <p className="text-caption text-muted-foreground">
          {t('v3.money.forecast.observedStaleValued', { count: burn.staleValued })}
        </p>
      ) : null}
      {/* THE ASK COMES LAST, AND THAT ORDER IS STILL THE ARGUMENT (SC-661) —
          but the claim it makes is narrower since SC-1068, and saying so is
          the point of this note.

          SC-661's reason is unchanged and correct: his complaint was that he
          does not recognise the figure, everything above the ask is why, and
          asking first would be asking him to judge a number before being told
          any of it — which is how the measured drain got read as an alien one.

          WHAT CHANGED IS THE SCOPE OF "ABOVE". SC-661 could say *everything
          above is why* about the whole screen, because the derivation was the
          screen. It is now behind a disclosure, so this ordering governs what a
          reader meets AFTER they open it, and the ask is the last thing in
          there rather than the last thing on the page. A reader who never opens
          it is never asked — which is the trade SC-1068 made deliberately, and
          it is a real cost: the correction affordance, the one input on this
          chain that is genuinely his, is now one tap further away. Named here
          rather than discovered.

          The order inside the derivation is asserted by `forecast.test.tsx`. */}
      <BurnAnswer answer={answer} measured={burn.perMonthMean} baseSymbol={baseSymbol} />
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
 * on the production book, window 2026-02..2026-07, `left_control`: **a minority
 * of rows carry a user stamp, and the share that is not the user's is markedly
 * higher by VALUE than by COUNT.** The unattributed rows are the big ones: the
 * single largest transaction is a fifth of the window on its own and has no
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
 * `valueTransactionInBase` — under a percent apart on the production book, and
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
  // rule `projectedShareOfObserved` follows. A window with no counted exits
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
 * THE ONE INPUT IN THIS CHAIN THAT IS GENUINELY HIS (SC-661).
 *
 * SC-673 and the provenance caption above explain WHY the figure feels alien —
 * 76% of it by value rests on answers carrying no record of who decided. Only
 * this does anything about it: an override is the one number on the screen the
 * user authored. mgrin's objection was not "tell me why I do not recognise
 * this", it was that he does not recognise it.
 *
 * ## Why the measured figure is still the default, and a declared one was built
 * ## and thrown away
 *
 * The first build of this made a DECLARED monthly spend the headline. It was
 * rejected on a measurement: asked what they spend a month, people give typical
 * RECURRING spend and omit exceptional items. On the one production book that
 * yielded a runway roughly twice the one the actual drain supports — an
 * overstatement in the flattering direction, which is the exact failure
 * SC-657 exists to avoid. So the measurement leads and the user corrects it.
 * An override has something to disagree with; a declaration has nothing.
 *
 * ## Four states, and the third is the one that needed a column
 *
 * `confirmed` with `matches: false` is why `users.observed_burn_confirmed_value`
 * stores a number at all. The drain is recomputed whenever the window moves, so
 * a confirmation read against a bare timestamp goes on claiming agreement after
 * the figure it agreed with has changed. Here that state stops claiming it and
 * names both numbers.
 */
function BurnAnswer({
  answer,
  measured,
  baseSymbol,
}: {
  answer: ForecastData['observedBurnAnswer'] | undefined;
  measured: string;
  baseSymbol: string;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  // Already in cache app-wide; this is a read of the token ID that gets STORED
  // beside the amount, not a second source of truth for the symbol shown.
  const baseCurrency = trpc.users.getBaseCurrency.useQuery();
  const currencyTokenId = baseCurrency.data?.id ?? null;

  const save = trpc.users.setObservedBurnAnswer.useMutation({
    onSuccess: () => {
      setEditing(false);
      setDraft('');
      void utils.payments.forecast.invalidate();
    },
  });

  /**
   * AN API OLDER THAN THIS BUNDLE SENDS NO ANSWER AT ALL, AND THE TWO HALVES
   * CAN SHIP APART.
   *
   * The field is non-optional on the wire, so the honest-looking type is the
   * non-optional one — and the comment defending that in the test fixture said
   * a payload omitting it "stays a failure rather than a silently empty
   * affordance". That reasoning assumed the frontend and the api deploy
   * together. They are separate deploy targets (Cloudflare Pages and Fly), and
   * on 2026-08-26 a frontend change reached production on a day when the Fly
   * chain had not run once, so the assumption is not one this component may
   * make.
   *
   * The failure it preferred is not a missing affordance: `answer.kind` on
   * `undefined` throws in render, on the page whose whole job is answering
   * "how long does my money last". Rendering nothing degrades correctly — the
   * runway does not depend on the answer, only on the override REPLACING the
   * denominator, and an absent field means there is no override.
   *
   * Deliberately NOT `answer ?? { kind: 'none' }`: that would ask the user a
   * question this server cannot record the answer to.
   */
  if (!answer) return null;

  /**
   * Positive, not merely numeric. `ObservedBurnAnswerDto` is what ENFORCES
   * this — a disabled button is not a guard — and it already gives the reason:
   * a zero drain makes the runway infinite, which is the most flattering
   * possible way to be wrong on the one screen the owner scans.
   *
   * Mirrored here so the refusal is a greyed-out button rather than a 400 the
   * user reads as "that did not save", and there is a SECOND consequence worth
   * recording: `observedRunwayMonths` returns `null` for a zero denominator,
   * and the whole `ObservedBasis` block — this affordance included — renders
   * only when that value is non-null. A stored zero would therefore hide the
   * control that withdraws it.
   */
  const trimmed = draft.trim();
  const draftIsUsable = /^\d+(\.\d+)?$/.test(trimmed) && new Decimal(trimmed || '0').greaterThan(0);
  const busy = save.isPending || currencyTokenId === null;

  const confirmMeasured = () =>
    currencyTokenId && save.mutate({ kind: 'confirm', value: measured, currencyTokenId });
  const submitOverride = () =>
    currencyTokenId &&
    draftIsUsable &&
    save.mutate({ kind: 'override', amount: trimmed, currencyTokenId });
  const revert = () => save.mutate({ kind: 'clear' });

  const askButtons = (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onClick={confirmMeasured} disabled={busy}>
        {t('v3.money.forecast.answerConfirm')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setEditing(true)} disabled={busy}>
        {t('v3.money.forecast.answerOverride')}
      </Button>
    </div>
  );

  if (editing) {
    return (
      <div className="flex flex-col gap-2 border-t border-dashed border-border pt-2">
        <label className="text-caption text-muted-foreground" htmlFor="observed-burn-override">
          {t('v3.money.forecast.answerAmountLabel')}
        </label>
        <Input
          id="observed-burn-override"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={submitOverride} disabled={busy || !draftIsUsable}>
            {t('v3.money.forecast.answerSave')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setDraft('');
            }}
          >
            {t('v3.money.forecast.answerCancel')}
          </Button>
        </div>
        {save.isError ? (
          <p className="text-caption text-destructive">{t('v3.money.forecast.answerFailed')}</p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 border-t border-dashed border-border pt-2">
      {answer.kind === 'override' ? (
        <>
          <p className="text-caption text-muted-foreground">
            <Trans
              i18nKey="v3.money.forecast.answerOverrideActive"
              values={{ date: formatDate(answer.at) }}
              components={{
                amount: <Numeric value={answer.amount} currency={baseSymbol} />,
                measured: <Numeric value={measured} currency={baseSymbol} />,
              }}
            />
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={revert} disabled={busy}>
              {t('v3.money.forecast.answerRevert')}
            </Button>
          </div>
        </>
      ) : null}

      {answer.kind === 'confirmed' && answer.matches ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.money.forecast.answerConfirmed', { date: formatDate(answer.at) })}
        </p>
      ) : null}

      {/* The measurement has left the figure he agreed with. Both numbers are
          named, because "you confirmed this" would now be a claim about a
          number he never saw — the defect the stored value exists to catch. */}
      {answer.kind === 'confirmed' && !answer.matches ? (
        <>
          <p className="text-caption text-muted-foreground">
            <Trans
              i18nKey="v3.money.forecast.answerConfirmedMoved"
              values={{ date: formatDate(answer.at) }}
              components={{
                was: <Numeric value={answer.value} currency={baseSymbol} />,
                now: <Numeric value={measured} currency={baseSymbol} />,
              }}
            />
          </p>
          {askButtons}
        </>
      ) : null}

      {answer.kind === 'currencyChanged' ? (
        <>
          <p className="text-caption text-muted-foreground">
            {t('v3.money.forecast.answerCurrencyChanged', { date: formatDate(answer.at) })}
          </p>
          {askButtons}
        </>
      ) : null}

      {answer.kind === 'none' ? (
        <>
          <p className="text-caption font-medium text-foreground">
            {t('v3.money.forecast.answerTitle')}
          </p>
          {askButtons}
        </>
      ) : null}

      {save.isError ? (
        <p className="text-caption text-destructive">{t('v3.money.forecast.answerFailed')}</p>
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
interface EstimateActionProps {
  forecast: ForecastData;
  onEstimateFromHistory?: (paymentIds: string[], enabled: boolean) => void;
  pending?: boolean;
}

function ForecastCaveats({ forecast, onEstimateFromHistory, pending }: EstimateActionProps) {
  const { t } = useTranslation();
  const notes: string[] = [];

  // THE COUNT IS A DENOMINATOR AND IT DOES NOT SHRINK BECAUSE AN OPTION EXISTS
  // (SC-625). Whatever is still unestimated after the reader has turned the
  // option on is still counted here, in the same words. What changes is that
  // the line can now be acted on where acting on it would do something.
  if (forecast.unprojectable.length > 0) {
    notes.push(t('v3.money.forecast.unprojectable', { count: forecast.unprojectable.length }));
  }
  if (forecast.overdue.length > 0) {
    notes.push(t('v3.money.forecast.overdueExcluded', { count: forecast.overdue.length }));
  }

  // Only the ones a settled amount actually exists for. Offering the action
  // over all of them would have the reader agree to a sentence about N
  // payments and change fewer — silently, since the count would simply drop by
  // less than the sentence implied and nothing would say why. A payment with
  // no settlement behind it stays in the line above with no remedy attached,
  // which is the honest thing to show for it.
  const remediable = forecast.unprojectable.filter((entry) => entry.lastSettled !== null);

  if (notes.length === 0) return null;

  return (
    <Block className="flex flex-col gap-1.5 border-dashed p-4">
      <p className="text-label">{t('v3.money.forecast.notCounted')}</p>
      {notes.map((note) => (
        <p key={note} className="text-caption text-muted-foreground">
          {note}
        </p>
      ))}

      {remediable.length > 0 && onEstimateFromHistory ? (
        <div className="mt-1.5 flex flex-col items-start gap-2 border-t border-dashed border-border pt-2">
          <p className="text-caption text-muted-foreground">
            {t('v3.money.forecast.couldEstimate', { count: remediable.length })}
          </p>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() =>
              onEstimateFromHistory(
                remediable.map((entry) => entry.paymentId),
                true
              )
            }
          >
            {t('v3.money.forecast.useLastSettled', { count: remediable.length })}
          </Button>
        </div>
      ) : null}
    </Block>
  );
}

/**
 * What this projection priced on the reader's own say-so (SC-625).
 *
 * A SEPARATE block from `<ForecastCaveats>`, and not a line inside it, because
 * that one is headed "Not in this projection" and these payments ARE in it.
 * Folding them together would put a true count under a false heading — the
 * cheapest possible way to lose the distinction the whole ticket is about.
 *
 * Two denominators, then, answering two questions: what could not be priced at
 * all, and what was priced from history. A single "N payments are estimated"
 * line doing both jobs would let a book with everything guessed read the same
 * as a book with everything declared.
 */
function ForecastEstimates({ forecast, onEstimateFromHistory, pending }: EstimateActionProps) {
  const { t } = useTranslation();
  const estimated = forecast.estimatedFromHistory;
  if (estimated.length === 0) return null;

  return (
    <Block className="flex flex-col gap-1.5 border-dashed p-4">
      <p className="text-label">{t('v3.money.forecast.estimatedTitle')}</p>
      <p className="text-caption text-muted-foreground">
        {t('v3.money.forecast.estimatedCount', { count: estimated.length })}
      </p>

      {/* A COUNT here and a CITATION on the recurring list, not both in both
          places. This view holds no vendor names — it takes a forecast, tokens
          and rates, and nothing else — so naming the payments here would mean
          listing uuids, which tells a reader nothing and would need a query
          this view deliberately does not make. The recurring list already has
          the name, the figure and the cadence beside each one, so that is
          where "from Feb 2026" belongs. */}
      <Button variant="outline" size="sm" asChild className="mt-1 self-start">
        <Link to={V3_ROUTES.recurring}>{t('v3.money.forecast.seeRecurring')}</Link>
      </Button>

      {onEstimateFromHistory ? (
        <div className="mt-1.5 flex items-start border-t border-dashed border-border pt-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() =>
              onEstimateFromHistory(
                estimated.map((entry) => entry.paymentId),
                false
              )
            }
          >
            {t('v3.money.forecast.stopEstimating', { count: estimated.length })}
          </Button>
        </div>
      ) : null}
    </Block>
  );
}
