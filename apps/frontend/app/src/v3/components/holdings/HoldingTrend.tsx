import { Sparkline } from '@scani/ui/v3/components/charts/Sparkline';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { DEFAULT_HOME_PERIOD, periodRange, sparklineSeries } from '../../lib/home';

/**
 * A holding's value over the last 30 days, as a glyph.
 *
 * v2's holding page renders two full recharts panels here — value over time
 * and PnL over time, each with axes, a tooltip and a range selector. §2.1 of
 * the research brief is that the answer to "what changed" on a phone is a
 * shape, and this is a sheet opened from a list: a chart with axes inside it
 * would be a page pretending to be a peek. The precise series stays reachable
 * on the v2 detail page until a v3 surface earns one.
 *
 * The series is scoped to the holding by the same `portfolio.getNetWorthSeries`
 * call the v2 chart makes, and the live value is appended to the rollup rows —
 * `sparklineSeries`' reasoning applies unchanged here: the nightly rollup lands
 * a day behind, so a trend that ended at yesterday's rollup would disagree with
 * the figure it sits under.
 *
 * Mounted only while the sheet is open, because `peek.render` is called for the
 * open record alone. A list of two hundred holdings issues no requests.
 */

interface HoldingTrendProps {
  holdingId: string;
  /** The holding's current value, appended as the last point. */
  value: number | null;
  /** Ticker, for the accessible name. */
  symbol: string;
}

export function HoldingTrend({ holdingId, value, symbol }: HoldingTrendProps) {
  const { t } = useTranslation();
  // Pinned on mount rather than recomputed per render, so a refetch cannot
  // shift the window under the shape already on screen.
  const range = useMemo(() => periodRange(DEFAULT_HOME_PERIOD, new Date()), []);

  const series = trpc.portfolio.getNetWorthSeries.useQuery({
    ...range,
    granularity: 'auto',
    scope: { kind: 'holding', id: holdingId },
  });

  const points = sparklineSeries(series.data?.series ?? [], value);

  // Nothing to draw is not the same as an empty box: a holding added this
  // morning has no history, and reserving 40px for a line that will never
  // appear pushes the facts below the fold to say nothing.
  if (points.length < 2) return null;

  return (
    <Sparkline
      data={points}
      height={40}
      label={t('v3.holdings.trendLabel', {
        symbol,
        period: t(DEFAULT_HOME_PERIOD.suffixKey),
      })}
    />
  );
}
