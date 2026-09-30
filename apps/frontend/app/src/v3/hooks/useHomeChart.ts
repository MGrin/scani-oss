import { useEffect, useMemo, useState } from 'react';
import { trpc } from '@/lib/trpc';
import {
  DEFAULT_HOME_PERIOD,
  HOME_METRIC_KEYS,
  HOME_METRICS,
  HOME_PERIOD_KEYS,
  type HomeMetric,
  type HomePeriod,
  homePeriodByKey,
  homePeriodRange,
  resolveHomeMetric,
  returnsWindowRequest,
} from '../lib/home';
import { type ReturnsView, type ReturnsWindowRequest, returnsView } from '../lib/returns';
import { readReturnsAvailability, writeReturnsAvailability } from '../lib/returns-availability';
import { VIEW_PREFERENCE_KEYS } from '../lib/view-preference';
import { useViewPreference } from './useViewPreference';

export interface HomeChart {
  /** Never `returns` while the tab is not offered. */
  metric: HomeMetric;
  chooseMetric: (next: string) => void;
  /** `HOME_METRICS` without Returns when there is no returns history. */
  metrics: readonly { key: HomeMetric; labelKey: string }[];
  periodKey: string;
  choosePeriod: (next: string) => void;
  period: HomePeriod;
  range: { from: Date; to: Date };
  returns: {
    /**
     * Exactly the days the chart draws (SC-1305). This used to be one of three
     * NAMED windows, picked by a table that mapped every range under a year
     * onto `1y` — so 1M, 3M and 6M were one request and the period control
     * changed nothing a reader could see.
     */
    request: ReturnsWindowRequest;
    /** Null until `getReturns` answers, or when there is too little history. */
    view: ReturnsView | null;
    pending: boolean;
  };
}

const WITHOUT_RETURNS = HOME_METRICS.filter((option) => option.key !== 'returns');

export function useHomeChart(): HomeChart {
  // Both survive a reload (V3-48). The period was the arguable one: it seeds
  // the series fetch, so remembering 1Y changes what loads on first paint. It
  // is persisted anyway — the reader who works in years re-picks it on every
  // visit otherwise, and the extra cost is bounded because `granularity:
  // 'auto'` downsamples a longer window rather than returning more points.
  const [periodKey, choosePeriod] = useViewPreference(
    VIEW_PREFERENCE_KEYS.homePeriod,
    DEFAULT_HOME_PERIOD.key,
    HOME_PERIOD_KEYS
  );
  const [chosen, chooseMetric] = useViewPreference(
    VIEW_PREFERENCE_KEYS.homeMetric,
    'net-worth' as const,
    HOME_METRIC_KEYS
  );

  const period = homePeriodByKey(periodKey);
  // The window is pinned to the period rather than to the clock, so a refetch
  // does not shift the baseline out from under the delta on the screen. It is
  // resolved through `homePeriodRange` so `HomePage` can ask for the same
  // window — and therefore the same query — before `HeroBlock` exists (SC-164).
  const range = useMemo(() => homePeriodRange(period), [period]);
  const request = useMemo(() => returnsWindowRequest(period), [period]);

  // Every load pays for this one and only this one.
  const historyQuery = trpc.portfolio.hasReturns.useQuery({ window: request, scope: undefined });

  // The last answer this browser was given, read DURING RENDER so the tab strip
  // is right at first paint rather than ~465ms later (SC-1307). `useState` with
  // a lazy initialiser, exactly as `useViewPreference` reads a stored choice:
  // an effect would run after the paint this exists to fix.
  const [remembered] = useState(readReturnsAvailability);

  const answered = historyQuery.data?.hasReturns;
  const offer = resolveHomeMetric({
    chosen,
    // The probe OUTRANKS the hint the moment it answers, so an account whose
    // history went away loses the tab rather than keeping one onto an empty
    // state. `?? false` is the first-ever visit: unknown is not "has none", but
    // it is the only safe way to render one.
    hasReturns: answered ?? remembered ?? false,
    returnsPending: historyQuery.isLoading,
    shown: false,
  });

  const returnsQuery = trpc.portfolio.getReturns.useQuery(
    { window: request, scope: undefined },
    // `resolveHomeMetric` only ever answers `returns` for a reader who chose
    // it, so this is exactly "the tab is on".
    { enabled: offer.metric === 'returns' }
  );
  const view = returnsView(returnsQuery.data?.returns, returnsQuery.data?.benchmarks);

  // The engine may WITHHOLD the figure (rebuilding, too little history —
  // SC-1396) while the probe says history exists. It cannot withdraw a tab the
  // probe confirmed: that took the tab away the moment it was tapped (SC-1406).
  // The tab stays and the returns view explains why there is no figure.
  const confirmed = answered === true;
  const { metric, offered } =
    returnsQuery.data === undefined
      ? offer
      : resolveHomeMetric({
          chosen,
          hasReturns: view?.money != null,
          returnsPending: false,
          shown: confirmed,
        });

  // Remember what the strip SETTLED on, not what the probe first said. The
  // engine outranks the probe above, so recording the probe's answer would
  // store `true` for a reader the engine then withdrew the tab from — turning
  // this load's withdrawal into next load's pop-OUT, which is the same defect
  // in the other direction.
  const settled = returnsQuery.data !== undefined ? view?.money != null || confirmed : answered;
  useEffect(() => {
    if (settled !== undefined) writeReturnsAvailability(settled);
  }, [settled]);

  return {
    metric,
    chooseMetric,
    metrics: offered ? HOME_METRICS : WITHOUT_RETURNS,
    periodKey,
    choosePeriod,
    period,
    range,
    returns: { request, view, pending: offer.metric === 'returns' && returnsQuery.isLoading },
  };
}
