import { formatCompact, formatCurrency } from '@scani/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { useMemo, useState } from 'react';
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

// Per-holding balance/value history sparkline. Reads
// `portfolio.getHoldingHistory` which today returns an empty series —
// the UI is wired so that once BalanceAtTimeService per-holding is
// plumbed through the tRPC endpoint (straightforward extension of the
// existing portfolio.ts router), this chart starts showing data with
// no further frontend changes.

interface Props {
  holdingId: string;
}

const RANGES = [
  { v: '30d', d: 30, l: '30D' },
  { v: '90d', d: 90, l: '90D' },
  { v: '1Y', d: 365, l: '1Y' },
  { v: 'ALL', d: 365 * 5, l: 'ALL' },
] as const;

export function HoldingHistoryChart({ holdingId }: Props) {
  const [days, setDays] = useState(90);
  const { symbol } = useBaseCurrency();
  const from = useMemo(() => new Date(Date.now() - days * 24 * 60 * 60 * 1000), [days]);
  const to = useMemo(() => new Date(), []);

  const { data, isLoading } = trpc.portfolio.getHoldingHistory.useQuery({
    holdingId,
    from,
    to,
  });

  const series = (data?.series as Array<{ date: string; value: number }>) ?? [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm">Holding value over time</CardTitle>
        <div className="flex gap-1">
          {RANGES.map((r) => (
            <button
              key={r.v}
              type="button"
              onClick={() => setDays(r.d)}
              className={`px-2 py-1 text-xs rounded ${
                days === r.d
                  ? 'bg-primary text-primary-foreground'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {r.l}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Skeleton className="h-[180px] w-full" />
        ) : series.length === 0 ? (
          <div className="h-[180px] flex items-center justify-center text-xs text-muted-foreground text-center px-4">
            No history for this holding yet. Connect transactions or upload a statement that covers
            this account to populate the chart.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <AreaChart data={series} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} minTickGap={24} />
              <YAxis
                tick={{ fontSize: 10 }}
                width={56}
                tickFormatter={(v) => formatCompact(v, symbol)}
              />
              <Tooltip
                formatter={(v) =>
                  [formatCurrency(String(v ?? 0), symbol), 'Value'] as [string, string]
                }
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
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </CardContent>
    </Card>
  );
}
