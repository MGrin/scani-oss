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
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { trpc } from '@/lib/trpc';
import { useBaseCurrency } from '../../hooks/useBaseCurrency';
import type { useUserJobs } from '../../hooks/useUserJobs';
import { V2_ROUTES } from '../../lib/routes';
import type { NetWorthChartScope } from './NetWorthChart';

type Granularity = 'daily' | 'weekly' | 'monthly';

const RANGE_OPTIONS: { label: string; days: number }[] = [
  { label: '1W', days: 7 },
  { label: '1M', days: 30 },
  { label: '3M', days: 90 },
  { label: '6M', days: 180 },
  { label: '1Y', days: 365 },
];
const DEFAULT_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

interface PnLPoint {
  date: string;
  totalValue: string;
  costBasis: string | null;
  realizedPnl: string | null;
  unrealizedPnl: string | null;
  totalPnl: string | null;
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

export interface PnLChartProps {
  scope?: NetWorthChartScope;
  title?: string;
  // Hoisted from PortfolioCharts — see NetWorthChartProps for the
  // rationale (one `jobs.listMine` query per page, not per chart).
  chartAffectingActive: boolean;
  chartAffectingFailure: ReturnType<typeof useUserJobs>['chartAffectingFailure'];
}

export function PnLChart({
  scope,
  title,
  chartAffectingActive,
  chartAffectingFailure,
}: PnLChartProps) {
  const { symbol: baseSymbol, isLoading: baseLoading } = useBaseCurrency();
  const [windowDays, setWindowDays] = useState(DEFAULT_DAYS);

  const { from, to } = useMemo(() => {
    const now = new Date();
    return { from: new Date(now.getTime() - windowDays * DAY_MS), to: now };
  }, [windowDays]);

  const { data, isLoading, isFetching } = trpc.portfolio.getPnLSeries.useQuery(
    { from, to, granularity: 'auto', ...(scope ? { scope } : {}) },
    { enabled: !baseLoading }
  );

  const granularity = (data?.granularity as Granularity | undefined) ?? 'daily';

  const chartData = useMemo(() => {
    const rows = (data?.series ?? []) as PnLPoint[];
    const mapped = rows.map((r) => ({
      date: r.date,
      totalPnl: r.totalPnl != null ? Number(r.totalPnl) : null,
      realized: r.realizedPnl != null ? Number(r.realizedPnl) : null,
      unrealized: r.unrealizedPnl != null ? Number(r.unrealizedPnl) : null,
      cost: r.costBasis != null ? Number(r.costBasis) : null,
      value: Number(r.totalValue),
      coverageQuality: r.coverageQuality,
      holdingsTotal: r.holdingsTotal,
      holdingsKnown: r.holdingsWithKnownValue,
    }));
    // Re-base to the start of the selected window: the series carries
    // cumulative-since-inception PnL, so subtract the first in-range
    // point's cumulative values from every point. The chart then starts
    // at 0 and shows PnL *change over the window*, and the period
    // selector visibly drives both chart and headline. The identity
    // totalPnl = realized + unrealized is preserved (each component is
    // re-based against its own baseline).
    const base = mapped.find(
      (p) => p.totalPnl != null && p.realized != null && p.unrealized != null
    );
    if (!base) return mapped;
    const baseTotal = base.totalPnl ?? 0;
    const baseRealized = base.realized ?? 0;
    const baseUnrealized = base.unrealized ?? 0;
    return mapped.map((p) => ({
      ...p,
      totalPnl: p.totalPnl != null ? p.totalPnl - baseTotal : null,
      realized: p.realized != null ? p.realized - baseRealized : null,
      unrealized: p.unrealized != null ? p.unrealized - baseUnrealized : null,
    }));
  }, [data]);

  const isEmpty = !isLoading && chartData.length === 0;
  const headerTitle = title ?? 'PnL over time';
  const hasPnLData = chartData.some((p) => p.totalPnl != null);

  // PnL crosses zero. Domain auto-pads symmetrically so wins and
  // losses share visual weight; the y=0 reference line draws the
  // win/loss boundary.
  const yAxisDomain = useMemo<[number | string, number | string]>(() => {
    if (chartData.length === 0) return ['auto', 'auto'];
    let min = 0;
    let max = 0;
    for (const p of chartData) {
      if (p.totalPnl != null) {
        if (p.totalPnl < min) min = p.totalPnl;
        if (p.totalPnl > max) max = p.totalPnl;
      }
    }
    const span = max - min || Math.max(Math.abs(max), Math.abs(min)) || 1;
    const pad = span * 0.1;
    return [min - pad, max + pad];
  }, [chartData]);

  // Snapshot of the latest non-null point for a header summary.
  const latest = useMemo(() => {
    for (let i = chartData.length - 1; i >= 0; i--) {
      const p = chartData[i];
      if (p && p.totalPnl != null) return p;
    }
    return null;
  }, [chartData]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 gap-3 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <CardTitle className="text-sm font-medium">{headerTitle}</CardTitle>
          {(isFetching && !isLoading) || chartAffectingActive ? (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground shrink-0" />
          ) : null}
          {latest && (
            <span
              className={`ml-2 inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                (latest.totalPnl ?? 0) >= 0
                  ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'bg-rose-500/15 text-rose-600 dark:text-rose-400'
              }`}
              title={`realized ${latest.realized ?? 0}, unrealized ${latest.unrealized ?? 0}`}
            >
              {(latest.totalPnl ?? 0) >= 0 ? '+' : ''}
              {formatCurrency(String(latest.totalPnl ?? 0), baseSymbol)}
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
            No PnL history in this range. Pick a longer period or wait for the rollup to finish.
          </div>
        ) : !hasPnLData ? (
          <div className="h-[220px] flex items-center justify-center text-sm text-muted-foreground text-center px-4">
            PnL not yet computed for this range. The next portfolio-history backfill will populate
            it.
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
                  domain={yAxisDomain}
                />
                {/* y=0 reference draws the win/loss boundary. */}
                <ReferenceLine y={0} stroke="hsl(var(--muted-foreground))" strokeDasharray="2 2" />
                <Tooltip
                  formatter={(v, name) => {
                    const key = String(name ?? '');
                    const label =
                      key === 'realized'
                        ? 'Realized'
                        : key === 'unrealized'
                          ? 'Unrealized'
                          : key === 'totalPnl'
                            ? 'Total PnL'
                            : key;
                    return [formatCurrency(String(v ?? 0), baseSymbol), label] as [string, string];
                  }}
                  labelFormatter={(label) => String(label ?? '')}
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                  }}
                />
                {/* Stacked-area: realized + unrealized = totalPnl. Different
                    colours for gain (emerald) vs loss (rose). The single
                    totalPnl line on top makes the curve readable when both
                    components share signs. */}
                <Area
                  type="monotone"
                  dataKey="realized"
                  stackId="pnl"
                  stroke="#10b981"
                  fill="#10b981"
                  fillOpacity={0.2}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                  baseValue={0}
                />
                <Area
                  type="monotone"
                  dataKey="unrealized"
                  stackId="pnl"
                  stroke="#3b82f6"
                  fill="#3b82f6"
                  fillOpacity={0.2}
                  strokeWidth={1.5}
                  isAnimationActive={false}
                  baseValue={0}
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
