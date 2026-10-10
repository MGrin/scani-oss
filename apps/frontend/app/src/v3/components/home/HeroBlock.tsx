import { Button } from '@scani/ui/ui/button';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { Block } from '@scani/ui/v3/components/Block';
import { DeltaPill } from '@scani/ui/v3/components/charts/DeltaPill';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { peekOpenState, peekPath } from '@scani/ui/v3/lib/peek';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import type { HomeChart } from '../../hooks/useHomeChart';
import { useReviewFeed } from '../../hooks/useReviewFeed';
import {
  fromFirstRecord,
  HOME_METRIC_TITLE_KEYS,
  HOME_PERIODS,
  type HomeMetric,
  heroDeltaState,
  heroFigureQuality,
  lastMeasuredBeforeToday,
  latestPnl,
  netWorthChartPoints,
  rebasePnlSeries,
  resolvePeriodDelta,
} from '../../lib/home';
import { todayDateString } from '../../lib/paymentTotals';
import { comparisonView } from '../../lib/returns-comparison';
import { pendingTransferCount } from '../../lib/review';
import { V3_ROUTES } from '../../lib/routes';
import { CoverageNote } from './CoverageNote';
import {
  FigureVisibilityToggle,
  MaskedFigure,
  useSharedFigureVisibility,
} from './FigureVisibility';
import { HistoryExport } from './HistoryExport';
import { NetWorthTape } from './NetWorthTape';
import { formatChartDate, PortfolioChart } from './PortfolioChart';
import { ReturnsHeroChart } from './ReturnsHeroChart';
import { ReturnsHeroTile } from './ReturnsHeroTile';

/**
 * "How much do I have" and "what changed" — the two questions §2.1 gives the
 * top of the screen, now answered with the chart the user actually opens the
 * app for rather than with a glyph of it.
 *
 * The block used to own the period **and** the metric, because both controlled
 * the same two figures and hoisting either would have put the state one level
 * above the only thing reading it. Returns as a third tab (SC-1301) ended
 * that: the range now also drives the returns window, and the block below the
 * hero has to know which tab is on so it can give up its own window picker and
 * its copy of the money sentence. Both live in `useHomeChart` now, called once
 * by `HomePage`.
 *
 * **With Returns on, the hero is a stat tile and a comparison chart.** It was
 * a bare sentence until SC-1305, which is the one thing about this block that
 * did not match its siblings; the tile is `ReturnsHeroTile` and the card below
 * renders nothing where its own sentence would be while this tab is on.
 *
 * The PnL series is fetched only while PnL is on screen. It is the more
 * expensive of the two queries and v2 pays the same way, by unmounting the
 * inactive chart; the cost is a spinner on first switch, once per session.
 *
 * **A failed series is not an empty one** (SC-71 9.1). With the api down the
 * block printed "No history for this period yet" under a full net-worth figure
 * — a network failure rendered as a statement about the reader's data, on the
 * screen where being wrong costs the most. The two states now say different
 * things and only one of them offers a retry.
 */

/**
 * The delta line while the answer is still coming (SC-111).
 *
 * A skeleton the height of the line it replaces, rather than the words
 * "loading…": the block above it already says the figure it is about, and this
 * slot's whole job at that moment is to *not* be a sentence. It is
 * `aria-hidden` and paired with a live region so a screen reader is told the
 * state once instead of reading a decorative box.
 */
function DeltaPending() {
  const { t } = useTranslation();
  return (
    <>
      <Skeleton aria-hidden="true" className="h-5 w-44" />
      <span className="sr-only" role="status">
        {t('v3.home.hero.changePending')}
      </span>
    </>
  );
}

/** The delta line's degraded twin: what failed, and the one control that can
 *  do something about it. */
function ChartLoadFailure({ onRetry }: { onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-caption text-loss">{t('v3.home.hero.changeUnavailable')}</span>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {t('v3.home.hero.retry')}
      </Button>
    </span>
  );
}

const OPEN_CHART_KEYS: Record<HomeMetric, string> = {
  'net-worth': 'v3.home.hero.openChart.netWorth',
  pnl: 'v3.home.hero.openChart.pnl',
  returns: 'v3.home.hero.openChart.returns',
};

/** On Home the chart is the way into its peek, which names the same chart. */
function OpensPeek({
  when,
  label,
  children,
}: {
  when: boolean;
  label: string;
  children: ReactNode;
}) {
  if (!when) return <>{children}</>;
  return (
    <Link
      to={peekPath(V3_ROUTES.homePeek, 'hero')}
      state={peekOpenState(V3_ROUTES.homePeek)}
      aria-label={label}
      className="block rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </Link>
  );
}

interface HeroBlockProps {
  /** From `dashboard.getOverview` — the live total, a day ahead of the rollup. */
  total: string | undefined;
  currency: string;
  /**
   * The tab, the range and the returns window, owned by `HomePage` since
   * SC-1301 — the block below the hero reads the same three facts.
   */
  chart: HomeChart;
  /** `compact` is Home's own (SC-1669): the chart opens `full` in a peek.
   *  Every tab stays on the card, each chart with its axes (SC-1690). */
  variant?: 'compact' | 'full';
}

export function HeroBlock({ total, currency, chart, variant = 'full' }: HeroBlockProps) {
  const { t } = useTranslation();
  const compact = variant === 'compact';
  const { period, periodKey, range } = chart;
  const metric: HomeMetric = chart.metric;
  // Money figures only: both money tabs share it, so switching to PnL while
  // hidden cannot show what the net-worth tab was hiding (SC-1375).
  const figure = useSharedFigureVisibility();
  const figureToggle = (
    <FigureVisibilityToggle hidden={figure.settingHidden} onToggle={figure.toggle} />
  );

  const series = trpc.portfolio.getNetWorthSeries.useQuery({ ...range, granularity: 'auto' });
  const pnlSeries = trpc.portfolio.getPnLSeries.useQuery(
    { ...range, granularity: 'auto' },
    { enabled: metric === 'pnl' }
  );
  // The expensive half — one benchmark price per measured day — asked for only
  // while the tab that draws it is on. Same window, and therefore the same
  // query, as the `ReturnsBlock` below, which needs it for the gaps.
  const comparisonQuery = trpc.portfolio.getReturnsComparison.useQuery(
    { window: chart.returns.request },
    { enabled: metric === 'returns' }
  );

  const { items: reviewItems } = useReviewFeed();

  const points = fromFirstRecord(series.data?.series ?? []);
  const firstRecord = points[0]?.date;
  const unmeasured = (series.data?.unmeasuredDates ?? []).filter(
    (date) => firstRecord !== undefined && date >= firstRecord
  );
  const today = todayDateString();
  const trend = netWorthChartPoints(points, total, today, unmeasured);
  // Only for net worth: the PnL series still carries its uncovered days as
  // rows, so its curve breaks on its own and the axis needs no explaining.
  const measuredThrough = metric === 'pnl' ? null : lastMeasuredBeforeToday(trend, today);
  const pnl = rebasePnlSeries(pnlSeries.data?.series ?? []);
  const pnlLatest = latestPnl(pnl);

  const isPnl = metric === 'pnl';
  const isReturns = metric === 'returns';
  const delta = resolvePeriodDelta(points, total);
  const comparison = comparisonView(comparisonQuery.data);
  // What the figure above does not know, said next to it (SC-146, SC-149,
  // SC-151). Every omission it can report runs one way — dust nothing quotes,
  // a quote past our freshness window, a cost basis we could not fully rebuild
  // — so silence here is not neutral, it is optimistic.
  //
  // The source is the metric's own headline day, not simply the last row. The
  // rollup fills value before it fills PnL, so a PnL headline routinely states
  // an earlier day than the series ends on, and qualifying a different day than
  // the one on screen would be its own quiet lie.
  //
  // One of the four does not come off the series at all (SC-1070). The
  // unreviewed-transfer clause is the only one that links somewhere and
  // promises that page holds exactly the rows it counted, and the series
  // carries a 04:00 snapshot of that count — so a reader who answered every
  // transfer watched the sentence say four over an empty queue until the next
  // night. It reads the live queue instead, which `HomePage` and `V3Shell`
  // have already fetched: same hook, same query, one cache entry, no second
  // request, and every answer path already invalidates it.
  const quality = heroFigureQuality({
    isPnl,
    netWorthPoints: points,
    pnlPoints: pnlSeries.data?.series ?? [],
    pendingTransfers: pendingTransferCount(reviewItems),
  });
  const granularity = (isPnl ? pnlSeries.data?.granularity : series.data?.granularity) ?? 'daily';
  const loading = isPnl ? pnlSeries.isLoading : series.isLoading;
  const active = isPnl ? pnlSeries : series;
  // "We could not ask" rather than "there is nothing" — and only when there is
  // genuinely nothing on screen. A refetch that fails behind a chart already
  // drawn leaves the chart standing, the same rule `V3DataView` follows.
  const failed = active.isError && active.data === undefined;
  // Both tiles read the *active* query's flags, and only one tile is mounted at
  // a time — the metric control unmounts the other.
  const deltaState = heroDeltaState({
    hasDelta: delta !== null,
    isLoading: loading,
    hasFailed: failed,
  });
  const pnlState = heroDeltaState({
    hasDelta: pnlLatest !== null,
    isLoading: loading,
    hasFailed: failed,
  });

  return (
    <Block className="flex flex-col gap-4 p-4">
      {isReturns ? (
        // The same tile the other two tabs render, not a sentence (SC-1305):
        // three values of one control should not change the shape of the block
        // above them. It renders the moment `getReturns` answers and never
        // waits on the chart below it.
        //
        // A skeleton rather than a zeroed tile while that call is in flight:
        // "Unchanged" is a claim, and one that would be wrong for every reader
        // who has this tab.
        chart.returns.view ? (
          <ReturnsHeroTile
            view={chart.returns.view}
            currency={currency}
            periodSuffixKey={period.suffixKey}
          />
        ) : (
          <>
            <Skeleton aria-hidden="true" className="h-9 w-64" />
            <span className="sr-only" role="status">
              {t('v3.home.hero.returnsPending')}
            </span>
          </>
        )
      ) : isPnl ? (
        <StatTile
          emphasis="hero"
          label={t('v3.home.hero.pnlOverPeriod', { period: t(period.suffixKey) })}
          labelAction={figureToggle}
          value={
            <MaskedFigure hidden={figure.hidden} onPeek={figure.onPeek}>
              <Numeric
                value={pnlLatest?.total ?? null}
                currency={currency}
                delta
                indicator="sign"
              />
            </MaskedFigure>
          }
          delta={
            pnlState === 'delta' && pnlLatest ? (
              // Realized and unrealized as figures rather than as two stacked
              // bands: the split is the reason to look at PnL rather than at
              // net worth, and reading it off a stacked area is estimation.
              <MaskedFigure hidden={figure.hidden} onPeek={figure.onPeek}>
                <span className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="text-caption text-muted-foreground">
                    {t('v3.home.hero.realized')}{' '}
                    <Numeric
                      value={pnlLatest.realized}
                      currency={currency}
                      delta
                      indicator="sign"
                      compact
                    />
                  </span>
                  <span className="text-caption text-muted-foreground">
                    {t('v3.home.hero.unrealized')}{' '}
                    <Numeric
                      value={pnlLatest.unrealized}
                      currency={currency}
                      delta
                      indicator="sign"
                      compact
                    />
                  </span>
                </span>
              </MaskedFigure>
            ) : pnlState === 'loading' ? (
              <DeltaPending />
            ) : pnlState === 'failed' ? (
              <ChartLoadFailure onRetry={() => void pnlSeries.refetch()} />
            ) : (
              <span className="text-caption text-muted-foreground">
                {t('v3.home.hero.pnlNotComputed')}
              </span>
            )
          }
        />
      ) : (
        <StatTile
          emphasis="hero"
          label={t('v3.home.metric.netWorth')}
          labelAction={figureToggle}
          value={
            <MaskedFigure hidden={figure.hidden} onPeek={figure.onPeek}>
              <NetWorthTape value={total} currency={currency} />
            </MaskedFigure>
          }
          delta={
            deltaState === 'delta' && delta ? (
              <MaskedFigure hidden={figure.hidden} onPeek={figure.onPeek}>
                <span className="flex flex-wrap items-center gap-2">
                  <DeltaPill value={delta.absolute} currency={currency} />
                  {/* One decimal, and muted rather than toned: the pill beside it
                    already carries the direction in colour, and a second
                    coloured figure would make the reader check whether the two
                    disagree. It keeps its sign because muted ink cannot say
                    which way it went. */}
                  {delta.percent === null ? null : (
                    <Numeric
                      value={delta.percent}
                      format="percent"
                      decimals={1}
                      delta
                      indicator="sign"
                      className="text-caption text-muted-foreground"
                    />
                  )}
                  <span className="text-caption text-muted-foreground">
                    {t('v3.home.hero.vsPeriod', { period: t(period.suffixKey) })}
                  </span>
                </span>
              </MaskedFigure>
            ) : deltaState === 'loading' ? (
              <DeltaPending />
            ) : deltaState === 'failed' ? (
              <ChartLoadFailure onRetry={() => void series.refetch()} />
            ) : (
              <span className="text-caption text-muted-foreground">
                {t('v3.home.hero.noHistory')}
              </span>
            )
          }
        />
      )}

      {/* Under the figure and above the controls: it qualifies the *number*,
          which is the thing a reader takes away from this block in three
          seconds, and it has to be readable before they touch anything.
          Suppressed while the answer is still coming and while it has failed —
          the same rule the delta line follows, and for the same reason: a
          coverage claim under a stale figure describes a day nobody asked
          about. */}
      {quality && !loading && !failed && !isReturns ? <CoverageNote quality={quality} /> : null}

      {/* The export sits beside the metric control rather than in the block's
          header: it acts on the *chart's* data, and putting it next to the two
          controls that decide what the chart shows is where a reader looks for
          it. Icon-only, for the reason `V3DataView`'s is — a labelled fourth
          control in this row costs the segmented control its legibility at
          390px (SC-89). */}
      <div className="flex items-center gap-2">
        <Segmented
          value={metric}
          onValueChange={chart.chooseMetric}
          aria-label={t('v3.home.hero.choosePlot')}
          className="min-w-0 flex-1"
        >
          {chart.metrics.map((option) => (
            <SegmentedItem key={option.key} value={option.key}>
              {t(option.labelKey)}
            </SegmentedItem>
          ))}
        </Segmented>
        <HistoryExport currency={currency} periodKey={periodKey} />
      </div>

      {isReturns ? (
        <OpensPeek when={compact} label={t(OPEN_CHART_KEYS.returns)}>
          <ReturnsHeroChart
            comparison={comparison}
            comparisonPending={comparisonQuery.isLoading}
            comparisonFailed={comparisonQuery.isError && comparisonQuery.data === undefined}
            currency={currency}
          />
        </OpensPeek>
      ) : loading ? (
        <Skeleton aria-hidden="true" className="h-[200px] w-full" />
      ) : failed ? (
        // A chart of no points reads as "you have no history". An empty frame
        // that says why does not.
        <div
          role="alert"
          className="flex h-[200px] w-full flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border-strong px-4 text-center"
        >
          <p className="text-body text-muted-foreground">{t('v3.home.hero.chartFailed')}</p>
          <Button variant="outline" size="sm" onClick={() => void active.refetch()}>
            {t('v3.home.hero.retry')}
          </Button>
        </div>
      ) : (
        <OpensPeek when={compact} label={t(OPEN_CHART_KEYS[metric])}>
          <PortfolioChart
            metric={metric}
            netWorth={trend}
            pnl={pnl}
            currency={currency}
            granularity={granularity}
            amountsHidden={figure.hidden}
            label={t('v3.home.hero.chartLabel', {
              metric: t(HOME_METRIC_TITLE_KEYS[metric]),
              period: t(period.suffixKey),
            })}
          />
        </OpensPeek>
      )}

      {/* Why the curve stops before the right-hand edge (SC-115). Under the
          chart rather than inside it: it is about the *absence* of data, and
          there is nowhere in the plot area to put a label for days that have
          no points. Settings' Data-quality panel is where the same fact is
          explained per holding. */}
      {measuredThrough && !loading && !failed && !isReturns ? (
        <p className="text-caption text-muted-foreground">
          {t('v3.home.hero.noMeasurementSince', {
            date: formatChartDate(measuredThrough, 'daily'),
          })}
        </p>
      ) : null}

      {/* The period governs the headline, the delta and the chart together,
          which is what keeps them from ever describing different windows. */}
      <Segmented
        value={periodKey}
        onValueChange={chart.choosePeriod}
        aria-label={t('v3.home.hero.changePeriod')}
      >
        {HOME_PERIODS.map((option) => (
          <SegmentedItem key={option.key} value={option.key}>
            {t(option.labelKey)}
          </SegmentedItem>
        ))}
      </Segmented>
    </Block>
  );
}
