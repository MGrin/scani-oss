import { getFormatLocale } from '@scani/shared';
import { ChartFrame } from '@scani/ui/v3/components/charts/ChartFrame';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { resolveNumeric } from '@scani/ui/v3/lib/numeric';
import { useId } from 'react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import type { PnLChartPoint, TrendPoint } from '../../lib/home';

/**
 * The home screen's real chart — net worth or PnL over the selected period.
 *
 * V3-09 shipped a 56px sparkline here, on the reasoning that a phone answers
 * "what changed" with a shape and the chart lives one tap away. The user's
 * verdict was that the chart is the reason he opens the screen, so the shape is
 * promoted to a chart with axes and a tooltip. The sparkline component stays —
 * it is still right in a stat tile — but the hero no longer uses it.
 *
 * Two things are v3's answer rather than v2's:
 *
 * - **One area, not a stack.** v2's PnL chart stacks realized on unrealized in
 *   emerald and blue, which spends two categorical colours on a series whose
 *   whole meaning is good-or-bad. Here the curve is total PnL in `--gain` /
 *   `--loss` — status colour for a status series — and the split is printed as
 *   two figures beneath, where it can be read exactly instead of estimated off
 *   a band.
 * - **Colour comes from `hsl(var(--…))`, never a resolved hex.** See
 *   `ChartFrame`: that is what makes a theme flip repaint without a re-render.
 */

/**
 * `2026-08-12` → `12 Aug`, or `Aug 2026` once the window is long enough that a
 * day-of-month tick is noise.
 *
 * Through `Intl` and the resolved date locale, not a twelve-string table. The
 * table was English-only, so the axis under a Russian interface read
 * `Jul 20 … Aug 18` while every figure beside it was `383 936,00 €` (SC-201).
 * `monthName` had already replaced one such array elsewhere (SC-300); this was
 * the last one.
 *
 * **The English output changes**, from `Aug 12` to `12 Aug`. That is the axis
 * being brought into line with the rest of the app rather than a new opinion:
 * `APP_LOCALE` is `en-GB` and every other date on the screen has been
 * day-first since SC-175. The array was the one place still printing an
 * American order, and it did so in every language.
 *
 * `timeZone: 'UTC'` and a mid-day reference hour: the input is a calendar day
 * with no time, and a local-midnight `Date` in a negative offset renders the
 * day before.
 */
export function formatChartDate(iso: string, granularity: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  if (!year || !month || !day) return iso;
  const at = new Date(Date.UTC(year, month - 1, day, 12));
  return at.toLocaleDateString(getFormatLocale().dateLocale, {
    timeZone: 'UTC',
    month: 'short',
    ...(granularity === 'monthly' ? { year: 'numeric' } : { day: 'numeric' }),
  });
}

/**
 * 13px is `--text-caption-size`, the type floor — the axis was set at 11px,
 * which is below it on both axes and on the first screen of the app (SC-71
 * 6.1). Recharts wants a number, so this cannot read the token; the number and
 * its name are kept together here so a change to the scale is one grep away.
 */
const AXIS_TICK = { fontSize: 13, fill: 'hsl(var(--muted-foreground))' };
const AXIS_LINE = { stroke: 'hsl(var(--border))' };

interface TooltipEntry {
  dataKey?: string | number;
  value?: number | string | null;
}

interface ChartTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: readonly TooltipEntry[];
  currency: string;
  granularity: string;
}

/**
 * The tooltip is markup rather than recharts' default so its figures go through
 * `<Numeric>` — otherwise the one place a reader looks for an exact value is
 * the one place in v3 that formats money its own way.
 */
function ChartTooltip({ active, label, payload, currency, granularity }: ChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0];
  if (!point) return null;

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 shadow-[var(--elevation-1)]">
      <p className="text-caption text-muted-foreground">
        {formatChartDate(String(label ?? ''), granularity)}
      </p>
      <Numeric value={point.value ?? null} currency={currency} className="text-label" />
    </div>
  );
}

interface PortfolioChartProps {
  metric: 'net-worth' | 'pnl';
  netWorth: readonly TrendPoint[];
  pnl: readonly PnLChartPoint[];
  currency: string;
  granularity: string;
  /** Reads as a sentence — see `ChartFrame`. */
  label: string;
  height?: number;
}

/** First-to-last for net worth, sign-of-latest for PnL: in both cases the
 *  colour says what the period did, which is what the figure above says too. */
function resolveTone(metric: 'net-worth' | 'pnl', points: readonly (number | null)[]): string {
  const known = points.filter((value): value is number => value !== null);
  if (known.length === 0) return 'hsl(var(--neutral))';

  const last = known[known.length - 1] as number;
  const reference = metric === 'pnl' ? 0 : (known[0] as number);
  if (last === reference) return 'hsl(var(--neutral))';
  return last > reference ? 'hsl(var(--gain))' : 'hsl(var(--loss))';
}

/**
 * The indices whose neighbours are both breaks — points a line cannot draw.
 *
 * `connectNulls={false}` renders a run of one as nothing at all: there is no
 * segment to stroke and dots are off, so the point vanishes. Today's live total
 * is exactly that point on an account whose rollup is behind (SC-115), which is
 * the "chart stops short of the axis" the ticket describes — the last thing it
 * has to say is drawn in no pixels.
 */
function isolatedIndices(values: readonly (number | null)[]): Set<number> {
  const isolated = new Set<number>();
  values.forEach((value, index) => {
    if (value === null) return;
    if (values[index - 1] === undefined || values[index - 1] === null) {
      if (values[index + 1] === undefined || values[index + 1] === null) isolated.add(index);
    }
  });
  return isolated;
}

export function PortfolioChart({
  metric,
  netWorth,
  pnl,
  currency,
  granularity,
  label,
  height = 200,
}: PortfolioChartProps) {
  // One gradient per instance: two charts on one page sharing an id would make
  // the second one paint with the first one's colour.
  const gradientId = useId();

  const isPnl = metric === 'pnl';
  const data = isPnl ? pnl : netWorth;
  const dataKey = isPnl ? 'total' : 'value';
  const values = isPnl ? pnl.map((point) => point.total) : netWorth.map((point) => point.value);
  const color = resolveTone(metric, values);
  const isolated = isolatedIndices(values);

  return (
    <ChartFrame label={label} height={height}>
      <AreaChart data={[...data]} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.28} />
            <stop offset="100%" stopColor={color} stopOpacity={0.02} />
          </linearGradient>
        </defs>
        {/* Horizontal rules only. Vertical ones add a second grid the eye has
            to filter out to read a trend that is entirely about height. */}
        <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
        <XAxis
          dataKey="date"
          tick={AXIS_TICK}
          tickFormatter={(value: string) => formatChartDate(value, granularity)}
          minTickGap={28}
          axisLine={AXIS_LINE}
          tickLine={false}
        />
        <YAxis
          tick={AXIS_TICK}
          // Compact through `<Numeric>`'s own formatter, so an axis tick and
          // the figure above the chart round the same way.
          tickFormatter={(value: number) => resolveNumeric(value, { currency, compact: true }).text}
          // Grown with the tick size above: a compact figure set at the type
          // floor no longer fits the 56px this gutter used to be.
          width={64}
          axisLine={false}
          tickLine={false}
          // Without an explicit domain recharts anchors at zero, which flattens
          // a net worth moving 120k → 124k into a straight line.
          domain={isPnl ? ['auto', 'auto'] : ['dataMin', 'dataMax']}
        />
        {/* PnL crosses zero and net worth does not, so only PnL earns the
            win/loss boundary. */}
        {isPnl ? <ReferenceLine y={0} stroke="hsl(var(--border-strong))" /> : null}
        <Tooltip
          cursor={{ stroke: 'hsl(var(--border-strong))' }}
          content={(props) => (
            <ChartTooltip
              {...(props as Omit<ChartTooltipProps, 'currency' | 'granularity'>)}
              currency={currency}
              granularity={granularity}
            />
          )}
        />
        <Area
          dataKey={dataKey}
          type="monotone"
          stroke={color}
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          isAnimationActive={false}
          // A gap in the rollup is a gap in what we know; bridging it would
          // draw a straight line through days nobody measured.
          connectNulls={false}
          // Off everywhere except where a point has no line to belong to: a dot
          // per day is noise on a 200-point curve, and no dot at all loses the
          // one point that has nothing beside it.
          dot={(props: { cx?: number; cy?: number; index?: number }) =>
            props.index !== undefined &&
            isolated.has(props.index) &&
            props.cx !== undefined &&
            props.cy !== undefined ? (
              <circle
                key={`isolated-${props.index}`}
                cx={props.cx}
                cy={props.cy}
                r={3}
                fill={color}
                stroke="hsl(var(--card))"
                strokeWidth={2}
              />
            ) : (
              <g key={`no-dot-${props.index}`} />
            )
          }
          activeDot={{ r: 3, fill: color, stroke: 'hsl(var(--card))', strokeWidth: 2 }}
        />
      </AreaChart>
    </ChartFrame>
  );
}
