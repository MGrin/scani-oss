import { getFormatLocale } from '@scani/shared';
import { useDirection } from '@scani/ui/lib/direction';
import { ChartFrame } from '@scani/ui/v3/components/charts/ChartFrame';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { resolveNumeric } from '@scani/ui/v3/lib/numeric';
import { useTranslation } from 'react-i18next';
import { CartesianGrid, Line, LineChart, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';
import type { ProjectedPoint } from '../../lib/forecast';

/**
 * The projected balance — and the one component in v3 that must NOT look like
 * the rest of them.
 *
 * SC-461's third constraint: *a projection is a claim about the future; never
 * render it in the same visual language as a measured figure*. `PortfolioChart`
 * is what a measured series looks like here — a filled area under a gradient,
 * stroked in `--gain` or `--loss` according to what the period did. Every one
 * of those choices is withdrawn here, and each withdrawal says something:
 *
 * - **A dashed line, not a solid one.** The single most legible "this is not
 *   observed" mark there is, and it survives greyscale, colour-blindness and a
 *   phone in sunlight — which colour alone does not.
 * - **No fill.** The area under `PortfolioChart` reads as substance
 *   accumulated. There is nothing under this line but an assumption.
 * - **`--neutral`, always.** Not `--gain` when the line rises. A forecast has
 *   no measured direction to praise, and tinting one green is the interface
 *   agreeing with a guess. `--loss` appears exactly once on this chart: on the
 *   zero rule, where the claim being made is a real event with a date.
 * - **A visible dot per month.** The series has six to twelve points and the
 *   walk is monthly (see `lib/forecast.ts`); drawing it as a smooth curve
 *   would imply a daily resolution the data does not have.
 *
 * Colour still comes from `hsl(var(--…))` rather than a resolved hex, for the
 * reason `ChartFrame` gives: that is what makes a theme flip repaint.
 */

const AXIS_TICK = { fontSize: 13, fill: 'hsl(var(--muted-foreground))' };
const AXIS_LINE = { stroke: 'hsl(var(--border))' };

/** The dash the whole surface is keyed to. Long-short, so it reads as
 *  deliberate at 2px rather than as a rendering artefact. */
const PROJECTED_DASH = '6 4';

/** `2026-08` → `Aug 2026`, through `Intl` and the resolved date locale —
 *  never a twelve-string table, which is the bug SC-201 removed from the
 *  portfolio axis. */
export function formatProjectionMonth(month: string): string {
  const [year, monthNumber] = month.split('-').map(Number);
  if (!year || !monthNumber) return month;
  return new Date(Date.UTC(year, monthNumber - 1, 15)).toLocaleDateString(
    getFormatLocale().dateLocale,
    { timeZone: 'UTC', month: 'short', year: 'numeric' }
  );
}

interface TooltipEntry {
  value?: number | string | null;
}

function ProjectionTooltip({
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
  const point = payload[0];
  if (!point) return null;

  return (
    <div className="rounded-md border border-border bg-popover px-3 py-2 shadow-[var(--elevation-1)]">
      <p className="text-caption text-muted-foreground">
        {formatProjectionMonth(String(label ?? ''))}
      </p>
      <Numeric value={point.value ?? null} currency={currency} className="text-label" />
      {/* The word is on the tooltip too. A reader who hovers one point is
          reading an exact figure, which is precisely the moment a projection
          is most likely to be mistaken for a measurement. */}
      <p className="text-caption text-muted-foreground">{t('v3.money.forecast.projectedMark')}</p>
    </div>
  );
}

interface ProjectionChartProps {
  points: readonly ProjectedPoint[];
  /** The liquid balance the walk starts from — drawn as the anchor at month 0. */
  opening: string;
  currency: string;
  /** Reads as a sentence — see `ChartFrame`. */
  label: string;
  height?: number;
}

export function ProjectionChart({
  points,
  opening,
  currency,
  label,
  height = 200,
}: ProjectionChartProps) {
  // The opening balance is the one MEASURED point on this chart, so the line
  // starts there rather than at the end of month one — otherwise the first
  // segment hides the first month's movement inside the y-intercept.
  const data = [
    { month: 'now', balance: Number(opening) },
    ...points.map((point) => ({ month: point.month, balance: point.balance.toNumber() })),
  ];
  const crossesZero = points.some((point) => point.balance.lessThanOrEqualTo(0));

  // See `PortfolioChart`: recharts places the axis gutter from a coordinate, so
  // it follows the document only when told to (SC-969). The trailing margin
  // moves with it — it is there so the first and last dots are not clipped, and
  // under RTL the free edge is the other one.
  const isRtl = useDirection() === 'rtl';

  return (
    <ChartFrame label={label} height={height}>
      <LineChart
        data={data}
        margin={{ top: 8, bottom: 0, right: isRtl ? 0 : 8, left: isRtl ? 8 : 0 }}
      >
        <CartesianGrid vertical={false} stroke="hsl(var(--border))" strokeDasharray="2 4" />
        <XAxis
          dataKey="month"
          tick={AXIS_TICK}
          tickFormatter={(value: string) => (value === 'now' ? '' : formatProjectionMonth(value))}
          minTickGap={20}
          axisLine={AXIS_LINE}
          tickLine={false}
        />
        <YAxis
          orientation={isRtl ? 'right' : 'left'}
          tick={AXIS_TICK}
          tickFormatter={(value: number) => resolveNumeric(value, { currency, compact: true }).text}
          axisLine={false}
          tickLine={false}
          width={64}
          // Anchored at zero, and stated rather than inherited from recharts'
          // default — `<Sparkline>` deliberately does the OPPOSITE
          // (`['dataMin','dataMax']`) because a flat-looking trend is the bug
          // there. Here zero is the whole question: the distance between the
          // line and the axis IS the runway. Auto-scaling would draw a book
          // going £208K → £261K as a dramatic climb and one going £10K → £9K
          // as a crash, and the second is the reader who needs this screen.
          // `'auto'` on the top so a projection that dips below zero still
          // shows how far below.
          domain={[Math.min(0, ...data.map((point) => point.balance)), 'auto']}
        />
        {/* Zero is the only thing on this chart worth a status colour, and only
            when the line actually reaches it. A permanent red rule under a
            healthy book is decoration that cries wolf. */}
        {crossesZero ? <ReferenceLine y={0} stroke="hsl(var(--loss))" strokeWidth={1.5} /> : null}
        <Tooltip
          content={<ProjectionTooltip currency={currency} />}
          cursor={{ stroke: 'hsl(var(--border))' }}
        />
        <Line
          dataKey="balance"
          type="linear"
          stroke="hsl(var(--neutral))"
          strokeWidth={2}
          strokeDasharray={PROJECTED_DASH}
          isAnimationActive={false}
          dot={{ r: 3, fill: 'hsl(var(--neutral))', stroke: 'hsl(var(--card))', strokeWidth: 1.5 }}
          activeDot={{ r: 5 }}
        />
      </LineChart>
    </ChartFrame>
  );
}
