import { useDirection } from '@scani/ui/lib/direction';
import { ChartFrame } from '@scani/ui/v3/components/charts/ChartFrame';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { resolveNumeric } from '@scani/ui/v3/lib/numeric';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';
import { cn } from '@/lib/utils';
import { axisFormat } from '../../lib/axis-format';
import { niceAxis } from '../../lib/nice-axis';
import {
  COMPARISON_SERIES,
  type ComparisonPoint,
  type ComparisonView,
} from '../../lib/returns-comparison';
import { formatChartDate } from './PortfolioChart';

/**
 * The reader's money against the same money in each benchmark (SC-1297).
 *
 * Four lines on one axis, all in the base currency, so they are directly
 * comparable — which is what makes a single axis correct here rather than a
 * compromise. The benchmark lines are counterfactuals: the reader's own
 * deposits and withdrawals routed into Bitcoin, into the S&P 500, and inflated
 * by US CPI. They are not "what BTC did"; that number is the caption on the
 * ahead/behind row beneath.
 *
 * ## The portfolio is ink, the benchmarks are colour
 *
 * `--foreground` for the reader's own line, chart-ramp slots for the three
 * ghosts. The hierarchy is the point: one of these four is the subject and the
 * other three are references. It also keeps the ramp's identity slots free for
 * the attribution bar above, which would otherwise mean "currency" in one hue
 * and "Bitcoin" in the next on a single card.
 *
 * Each ghost also carries its own dash, so the four are told apart with no
 * colour at all — the legend beneath repeats the dash for the same reason.
 *
 * ## A missing price is a HOLE
 *
 * `connectNulls={false}`, as `PortfolioChart` does. A benchmark day with no
 * price is absent from the payload and arrives here as `null`; bridging it
 * would draw a price we do not have, on a chart whose whole claim is that the
 * four series are measured the same way.
 */

const AXIS_TICK = { fontSize: 13, fill: 'hsl(var(--muted-foreground))' };
const AXIS_LINE = { stroke: 'hsl(var(--border))' };

const SERIES_KEYS = ['portfolio', 'btc', 'sp500', 'us_inflation'] as const;
type SeriesKey = (typeof SERIES_KEYS)[number];

interface TooltipEntry {
  dataKey?: string | number;
  value?: number | string | null;
}

/**
 * Every series for the day under the finger, in one box — the spec's reason
 * for a shared cursor rather than per-line hovers. Markup rather than
 * recharts' default so the figures go through `<Numeric>`.
 */
function ComparisonTooltip({
  active,
  label,
  payload,
  currency,
}: {
  active?: boolean;
  label?: string | number;
  payload?: readonly TooltipEntry[];
  currency: string;
}) {
  const { t } = useTranslation();
  if (!active || !payload || payload.length === 0) return null;

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 shadow-[var(--elevation-1)]">
      <p className="text-caption text-muted-foreground">
        {formatChartDate(String(label ?? ''), 'daily')}
      </p>
      <dl className="mt-1 flex flex-col gap-0.5">
        {SERIES_KEYS.flatMap((key) => {
          const entry = payload.find((item) => item.dataKey === key);
          if (entry?.value === undefined || entry.value === null) return [];
          return [
            <div key={key} className="flex items-baseline justify-between gap-4">
              <dt className="flex items-center gap-1.5 text-caption">
                <span
                  aria-hidden="true"
                  className="size-2 shrink-0 rounded-sm"
                  style={{ backgroundColor: COMPARISON_SERIES[key].color }}
                />
                {t(COMPARISON_SERIES[key].labelKey)}
              </dt>
              <dd>
                <Numeric value={entry.value} currency={currency} className="text-caption" />
              </dd>
            </div>,
          ];
        })}
      </dl>
    </div>
  );
}

export function ReturnsComparisonChart({
  comparison,
  currency,
  height = 200,
  framed = true,
}: {
  comparison: ComparisonView;
  currency: string;
  height?: number;
  /**
   * The rule above the chart and the padding around it belong to the CARD.
   * In the hero (SC-1301) the block already owns both, and a second border
   * there draws a divider across the middle of one block.
   */
  framed?: boolean;
}) {
  const { t } = useTranslation();
  // See `PortfolioChart`: recharts places the axis gutter from a coordinate,
  // so it follows the document only when told to (SC-969).
  const isRtl = useDirection() === 'rtl';

  const drawn: SeriesKey[] = ['portfolio', ...comparison.lines];
  const values = comparison.points.flatMap((point) =>
    drawn.map((key) => point[key]).filter((value): value is number => value !== null)
  );
  // Round ticks at an even step (SC-1430), and the label precision follows
  // the ticks that are printed, not the raw series — as in `PortfolioChart`.
  const nice = niceAxis(values);
  const axis = axisFormat(nice ? nice.ticks : values);

  return (
    <div className={cn('flex flex-col gap-3', framed && 'border-t border-border px-4 py-3')}>
      <ChartFrame label={t('v3.home.returns.chart.label')} height={height}>
        <LineChart
          data={comparison.points as ComparisonPoint[]}
          margin={{ top: 8, bottom: 0, right: isRtl ? 0 : 4, left: isRtl ? 4 : 0 }}
        >
          <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
          <XAxis
            dataKey="date"
            tick={AXIS_TICK}
            tickFormatter={(value: string) => formatChartDate(value, 'daily')}
            minTickGap={28}
            axisLine={AXIS_LINE}
            tickLine={false}
          />
          <YAxis
            orientation={isRtl ? 'right' : 'left'}
            tick={AXIS_TICK}
            tickFormatter={(value: number) => resolveNumeric(value, { currency, ...axis }).text}
            width={64}
            axisLine={false}
            tickLine={false}
            // Anchoring at zero would flatten four lines that start from the
            // same opening value into one band at the top of the plot.
            domain={nice?.domain ?? ['dataMin', 'dataMax']}
            ticks={nice?.ticks}
          />
          <Tooltip
            cursor={{ stroke: 'hsl(var(--border-strong))' }}
            content={(props) => (
              <ComparisonTooltip
                {...(props as Omit<React.ComponentProps<typeof ComparisonTooltip>, 'currency'>)}
                currency={currency}
              />
            )}
          />
          {drawn.map((key) => (
            <Line
              key={key}
              dataKey={key}
              type="monotone"
              stroke={COMPARISON_SERIES[key].color}
              strokeWidth={key === 'portfolio' ? 2.5 : 1.75}
              strokeDasharray={COMPARISON_SERIES[key].dash}
              isAnimationActive={false}
              // A day the benchmark had no price is a hole, never a bridge.
              connectNulls={false}
              dot={false}
              activeDot={{
                r: 3,
                fill: COMPARISON_SERIES[key].color,
                stroke: 'hsl(var(--card))',
                strokeWidth: 2,
              }}
            />
          ))}
        </LineChart>
      </ChartFrame>

      {/* Four lines is one past the point where direct labels collide on a
          phone, so identity lives in a legend and the exact values live in the
          tooltip — never in colour alone, which is what the dashes are for. */}
      <ul className="flex flex-wrap gap-x-4 gap-y-1">
        {drawn.map((key) => (
          <li key={key} className="flex items-center gap-1.5 text-caption text-muted-foreground">
            <svg aria-hidden="true" width="16" height="2" className="shrink-0 overflow-visible">
              <line
                x1="0"
                y1="1"
                x2="16"
                y2="1"
                stroke={COMPARISON_SERIES[key].color}
                strokeWidth={key === 'portfolio' ? 2.5 : 1.75}
                strokeDasharray={COMPARISON_SERIES[key].dash}
              />
            </svg>
            {t(COMPARISON_SERIES[key].labelKey)}
          </li>
        ))}
      </ul>

      {comparison.truncated ? (
        <p className="text-caption text-muted-foreground">{t('v3.home.returns.chart.truncated')}</p>
      ) : null}
    </div>
  );
}
