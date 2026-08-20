import { Button } from '@scani/ui/ui/button';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { Block } from '@scani/ui/v3/components/Block';
import { DeltaPill } from '@scani/ui/v3/components/charts/DeltaPill';
import { StatTile } from '@scani/ui/v3/components/charts/StatTile';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { useViewPreference } from '../../hooks/useViewPreference';
import {
  DEFAULT_HOME_PERIOD,
  HOME_METRIC_KEYS,
  HOME_METRICS,
  HOME_PERIOD_KEYS,
  HOME_PERIODS,
  heroDeltaState,
  homePeriodByKey,
  homePeriodRange,
  lastMeasuredBeforeToday,
  latestMeasured,
  latestPnl,
  latestPnlSource,
  netWorthChartPoints,
  rebasePnlSeries,
  resolvePeriodDelta,
  summariseQuality,
} from '../../lib/home';
import { todayDateString } from '../../lib/paymentTotals';
import { VIEW_PREFERENCE_KEYS } from '../../lib/view-preference';
import { CoverageNote } from './CoverageNote';
import { HistoryExport } from './HistoryExport';
import { NetWorthTape } from './NetWorthTape';
import { formatChartDate, PortfolioChart } from './PortfolioChart';

/**
 * "How much do I have" and "what changed" — the two questions §2.1 gives the
 * top of the screen, now answered with the chart the user actually opens the
 * app for rather than with a glyph of it.
 *
 * The block owns the period **and** the metric because both control the same
 * two figures. Hoisting either into `HomePage` would put the state one level
 * above the only thing that reads it, and the layout ticket (V3-37) is about to
 * move these blocks into a grid — a block that carries its own state moves as
 * one piece.
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

interface HeroBlockProps {
  /** From `dashboard.getOverview` — the live total, a day ahead of the rollup. */
  total: string | undefined;
  currency: string;
}

export function HeroBlock({ total, currency }: HeroBlockProps) {
  const { t } = useTranslation();
  // Both survive a reload (V3-48). The period was the arguable one: it seeds the
  // series fetch, so remembering 1Y changes what loads on first paint. It is
  // persisted anyway — the reader who works in years re-picks it on every visit
  // otherwise, and the extra cost is bounded because `granularity: 'auto'`
  // downsamples a longer window rather than returning more points.
  const [periodKey, setPeriodKey] = useViewPreference(
    VIEW_PREFERENCE_KEYS.homePeriod,
    DEFAULT_HOME_PERIOD.key,
    HOME_PERIOD_KEYS
  );
  const [metric, setMetric] = useViewPreference(
    VIEW_PREFERENCE_KEYS.homeMetric,
    'net-worth' as const,
    HOME_METRIC_KEYS
  );

  const period = homePeriodByKey(periodKey);
  // The window is pinned to the period rather than to the clock, so a refetch
  // does not shift the baseline out from under the delta on the screen. It is
  // resolved through `homePeriodRange` so `HomePage` can ask for the same
  // window — and therefore the same query — before this block exists (SC-164).
  const range = useMemo(() => homePeriodRange(period), [period]);

  const series = trpc.portfolio.getNetWorthSeries.useQuery({ ...range, granularity: 'auto' });
  const pnlSeries = trpc.portfolio.getPnLSeries.useQuery(
    { ...range, granularity: 'auto' },
    { enabled: metric === 'pnl' }
  );

  const points = series.data?.series ?? [];
  const today = todayDateString();
  const delta = resolvePeriodDelta(points, total);
  const trend = netWorthChartPoints(points, total, today, series.data?.unmeasuredDates);
  // Only for net worth: the PnL series still carries its uncovered days as
  // rows, so its curve breaks on its own and the axis needs no explaining.
  const measuredThrough = metric === 'pnl' ? null : lastMeasuredBeforeToday(trend, today);
  const pnl = rebasePnlSeries(pnlSeries.data?.series ?? []);
  const pnlLatest = latestPnl(pnl);

  const isPnl = metric === 'pnl';
  // What the figure above does not know, said next to it (SC-146, SC-149,
  // SC-151). Every omission it can report runs one way — dust nothing quotes,
  // a quote past our freshness window, a cost basis we could not fully rebuild
  // — so silence here is not neutral, it is optimistic.
  //
  // The source is the metric's own headline day, not simply the last row. The
  // rollup fills value before it fills PnL, so a PnL headline routinely states
  // an earlier day than the series ends on, and qualifying a different day than
  // the one on screen would be its own quiet lie.
  const qualitySource = isPnl
    ? latestPnlSource(pnlSeries.data?.series ?? [])
    : latestMeasured(points);
  const quality = summariseQuality(qualitySource, { includeBasis: isPnl });
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
      {isPnl ? (
        <StatTile
          emphasis="hero"
          label={t('v3.home.hero.pnlOverPeriod', { period: t(period.suffixKey) })}
          value={
            <Numeric value={pnlLatest?.total ?? null} currency={currency} delta indicator="sign" />
          }
          delta={
            pnlState === 'delta' && pnlLatest ? (
              // Realized and unrealized as figures rather than as two stacked
              // bands: the split is the reason to look at PnL rather than at
              // net worth, and reading it off a stacked area is estimation.
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
          value={<NetWorthTape value={total} currency={currency} />}
          delta={
            deltaState === 'delta' && delta ? (
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
      {quality && !loading && !failed ? <CoverageNote quality={quality} /> : null}

      {/* The export sits beside the metric control rather than in the block's
          header: it acts on the *chart's* data, and putting it next to the two
          controls that decide what the chart shows is where a reader looks for
          it. Icon-only, for the reason `V3DataView`'s is — a labelled fourth
          control in this row costs the segmented control its legibility at
          390px (SC-89). */}
      <div className="flex items-center gap-2">
        <Segmented
          value={metric}
          onValueChange={setMetric}
          aria-label={t('v3.home.hero.choosePlot')}
          className="min-w-0 flex-1"
        >
          {HOME_METRICS.map((option) => (
            <SegmentedItem key={option.key} value={option.key}>
              {t(option.labelKey)}
            </SegmentedItem>
          ))}
        </Segmented>
        <HistoryExport currency={currency} periodKey={periodKey} />
      </div>

      {loading ? (
        <Skeleton aria-hidden="true" className="h-[200px] w-full" />
      ) : failed ? (
        // A chart of no points reads as "you have no history". An empty frame
        // that says why does not.
        <div
          role="alert"
          className="flex h-[200px] w-full items-center justify-center rounded-lg border border-dashed border-border-strong px-4 text-center"
        >
          <p className="text-body text-muted-foreground">{t('v3.home.hero.chartFailed')}</p>
        </div>
      ) : (
        <PortfolioChart
          metric={metric}
          netWorth={trend}
          pnl={pnl}
          currency={currency}
          granularity={granularity}
          label={t('v3.home.hero.chartLabel', {
            metric: isPnl ? t('v3.home.metric.pnlFull') : t('v3.home.metric.netWorth'),
            period: t(period.suffixKey),
          })}
        />
      )}

      {/* Why the curve stops before the right-hand edge (SC-115). Under the
          chart rather than inside it: it is about the *absence* of data, and
          there is nowhere in the plot area to put a label for days that have
          no points. Settings' Data-quality panel is where the same fact is
          explained per holding. */}
      {measuredThrough && !loading && !failed ? (
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
        onValueChange={setPeriodKey}
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
