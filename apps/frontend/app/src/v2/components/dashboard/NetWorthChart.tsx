import { formatCompact, formatCurrency } from '@scani/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { trpc } from '@/lib/trpc';
import { useBaseCurrency } from '../../hooks/useBaseCurrency';
import { useUserJobs } from '../../hooks/useUserJobs';
import { V2_ROUTES } from '../../lib/routes';

type Granularity = 'daily' | 'weekly' | 'monthly';

// Range presets. 2Y was removed because the data layer caps lookback
// at 365 days (PORTFOLIO_HISTORY_BACKFILL.LOOKBACK_DEFAULT_DAYS) — a
// 2Y selector promised data we couldn't deliver and made the curve
// flatline at the import boundary.
const RANGE_OPTIONS: { label: string; days: number }[] = [
  { label: '1W', days: 7 },
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
];

const DEFAULT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

interface SeriesPoint {
  date: string;
  totalValue: string;
  coverageQuality: string;
  holdingsWithKnownValue: number;
  holdingsTotal: number;
}

const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function formatTick(iso: string, granularity: Granularity): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const month = MONTH_SHORT[m - 1] ?? '';
  if (granularity === 'monthly') return `${month} ${y}`;
  return `${month} ${d}`;
}

export function NetWorthChart() {
  const { symbol: baseSymbol, isLoading: baseLoading } = useBaseCurrency();
  // Surface backfill / tx-import progress to the chart. While any
  // chart-affecting job is running, the curve we render is stale —
  // signal that with the inline spinner; on a recent failure, show a
  // warning banner so the user knows the curve is incomplete.
  const { chartAffectingActive, chartAffectingFailure } = useUserJobs();

  // Static range — no zoom, no pan, no drag. The previous version
  // wired wheel/drag/touch handlers to scroll and zoom the chart, but
  // it was buggy on touchpads (vertical-scroll inertia bled into the
  // page) and slow (debounced tRPC re-fetches on every wheel tick).
  // Range presets cover the actual use-case.
  const [windowDays, setWindowDays] = useState(DEFAULT_DAYS);

  const { from, to } = useMemo(() => {
    const now = new Date();
    return {
      from: new Date(now.getTime() - windowDays * DAY_MS),
      to: now,
    };
  }, [windowDays]);

  const { data, isLoading, isFetching } = trpc.portfolio.getNetWorthSeries.useQuery(
    { from, to, granularity: 'auto' },
    { enabled: !baseLoading }
  );

  const granularity = (data?.granularity as Granularity | undefined) ?? 'daily';

  const chartData = useMemo(() => {
    const rows = (data?.series ?? []) as SeriesPoint[];
    return rows.map((r) => ({
      date: r.date,
      value: Number(r.totalValue),
      coverageQuality: r.coverageQuality,
      holdingsTotal: r.holdingsTotal,
      holdingsKnown: r.holdingsWithKnownValue,
    }));
  }, [data]);

  // Coverage summary surfaced in a single chip + tooltip — replaces
  // the previous solid-blue-vs-dashed-grey two-line approach, which
  // users found confusing (the grey segments looked like errors but
  // were merely "≥ 1 holding has no historical price").
  const coverage = useMemo(() => {
    if (chartData.length === 0) return null;
    const fullCount = chartData.filter((p) => p.coverageQuality === 'full').length;
    const total = chartData.length;
    const ratio = fullCount / total;
    return {
      fullCount,
      total,
      ratio,
      label: ratio === 1 ? 'Full coverage' : `${Math.round(ratio * 100)}% of days at full coverage`,
    };
  }, [chartData]);

  // Pad the YAxis domain by 5% on both sides of the data range so the
  // curve doesn't kiss the top/bottom edges. Falls back to ['auto',
  // 'auto'] when the dataset is empty (Recharts handles the empty
  // case fine, but a tuple keeps the prop type stable).
  const yAxisDomain = useMemo<[number | string, number | string]>(() => {
    if (chartData.length === 0) return ['auto', 'auto'];
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (const p of chartData) {
      if (p.value < min) min = p.value;
      if (p.value > max) max = p.value;
    }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return ['auto', 'auto'];
    const span = max - min || Math.abs(max) || 1;
    const pad = span * 0.05;
    return [Math.max(0, min - pad), max + pad];
  }, [chartData]);

  const isEmpty = !isLoading && chartData.length === 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle className="text-sm font-medium">Net worth over time</CardTitle>
          {(isFetching && !isLoading) || chartAffectingActive ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />
          ) : null}
          {chartAffectingActive && (
            <span className="text-[10px] text-muted-foreground">updating…</span>
          )}
          {coverage && (
            <span
              className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                coverage.ratio === 1
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : coverage.ratio >= 0.8
                    ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                    : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
              }`}
              title={`${coverage.fullCount}/${coverage.total} days have prices for every holding`}
            >
              {coverage.label}
            </span>
          )}
        </div>
        <div className="flex gap-1 flex-wrap">
          {RANGE_OPTIONS.map((opt) => {
            const isActive = windowDays === opt.days;
            return (
              <button
                type="button"
                key={opt.label}
                onClick={() => setWindowDays(opt.days)}
                className={`px-2 py-1 text-xs rounded ${
                  isActive
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted text-muted-foreground hover:bg-muted/80'
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading || baseLoading ? (
          <Skeleton className="h-[220px] w-full" />
        ) : isEmpty ? (
          <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground text-center px-4">
            No portfolio value in this range. Pick a longer period or wait for the history backfill
            to finish.
          </div>
        ) : (
          <div className="h-[220px] w-full">
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: string) => formatTick(v, granularity)}
                  minTickGap={32}
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(v: number) => formatCompact(v, baseSymbol)}
                  width={72}
                  // Auto-scale to data range instead of anchoring at 0.
                  // For a portfolio fluctuating between 100k-150k the
                  // 0-baseline default flattened the curve and made
                  // movements invisible. 5% padding keeps the line off
                  // the chart edges so peaks/troughs aren't clipped.
                  domain={yAxisDomain}
                  allowDataOverflow={false}
                />
                <Tooltip
                  formatter={(v) =>
                    [formatCurrency(String(v ?? 0), baseSymbol), 'Value'] as [string, string]
                  }
                  labelFormatter={(label, payload) => {
                    const p = payload?.[0]?.payload as
                      | {
                          date: string;
                          coverageQuality: string;
                          holdingsKnown: number;
                          holdingsTotal: number;
                        }
                      | undefined;
                    if (!p) return String(label ?? '');
                    const coverageNote =
                      p.coverageQuality === 'full'
                        ? '· full coverage'
                        : `· ${p.holdingsKnown}/${p.holdingsTotal} priced`;
                    return `${p.date}  ${coverageNote}`;
                  }}
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="value"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.15}
                  strokeWidth={2}
                  isAnimationActive={false}
                  // Anchor the fill to the chart's data minimum, not y=0.
                  // Without this Recharts fills all the way down to
                  // y=0 even when the YAxis domain starts at 100k,
                  // producing a giant solid block under the curve.
                  baseValue="dataMin"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
        {chartAffectingFailure && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
            <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
            <div className="space-y-0.5">
              <div className="font-medium">Chart may be incomplete</div>
              <div className="text-muted-foreground">
                A recent {chartAffectingFailure.jobName.replace(/-/g, ' ')} job failed; the curve
                below excludes data that job would have produced.
                <Link
                  to={V2_ROUTES.jobDetail(chartAffectingFailure.jobId)}
                  className="ml-1 underline hover:text-foreground"
                >
                  Open job
                </Link>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
