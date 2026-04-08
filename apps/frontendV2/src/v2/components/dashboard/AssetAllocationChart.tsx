import { useMemo, useState } from 'react';
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';

const COLORS = [
  '#3b82f6',
  '#10b981',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#06b6d4',
  '#f97316',
  '#84cc16',
  '#6366f1',
];

type Dimension = 'token_type' | 'institution' | 'account' | 'group';

const DIMENSION_OPTIONS: { value: Dimension; label: string }[] = [
  { value: 'token_type', label: 'Type' },
  { value: 'institution', label: 'Institution' },
  { value: 'account', label: 'Account' },
  { value: 'group', label: 'Group' },
];

export function AssetAllocationChart() {
  const [dimension, setDimension] = useState<Dimension>('token_type');
  const { data: allocation, isLoading } = trpc.dashboard.getAssetAllocation.useQuery({
    dimension,
  });

  const chartData = useMemo(() => {
    if (!allocation?.items) return [];
    // Group small slices into "Other" to keep chart readable
    const sorted = [...allocation.items].sort(
      (a, b) => Number(b.percentage) - Number(a.percentage)
    );
    const MAX_SLICES = 8;
    if (sorted.length <= MAX_SLICES) {
      return sorted.map((item, index) => ({
        id: item.id,
        name: item.name,
        value: Number(item.percentage) || 0,
        fill: COLORS[index % COLORS.length],
      }));
    }
    const top = sorted.slice(0, MAX_SLICES - 1);
    const rest = sorted.slice(MAX_SLICES - 1);
    const otherValue = rest.reduce((sum, item) => sum + (Number(item.percentage) || 0), 0);
    return [
      ...top.map((item, index) => ({
        id: item.id,
        name: item.name,
        value: Number(item.percentage) || 0,
        fill: COLORS[index % COLORS.length],
      })),
      {
        id: '__other__',
        name: `Other (${rest.length})`,
        value: otherValue,
        fill: '#94a3b8',
      },
    ];
  }, [allocation?.items]);

  return (
    <Card>
      <CardHeader className="px-4 pt-3 pb-1">
        <div className="flex flex-wrap items-center justify-between gap-1">
          <CardTitle className="text-sm font-semibold">Allocation</CardTitle>
          <div className="flex rounded border border-border overflow-hidden">
            {DIMENSION_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => setDimension(opt.value)}
                className={`px-2 py-1 text-[10px] leading-none transition-colors border-r last:border-r-0 border-border ${
                  dimension === opt.value
                    ? 'bg-accent text-accent-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex items-center justify-between">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-4 w-12" />
              </div>
            ))}
          </div>
        ) : chartData.length === 0 ? (
          <p className="text-sm text-muted-foreground">No assets yet</p>
        ) : (
          <div>
            <ResponsiveContainer width="100%" height={180}>
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={40}
                  outerRadius={75}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {chartData.map((entry) => (
                    <Cell key={entry.id} fill={entry.fill} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value: number) => [`${value.toFixed(1)}%`, 'Allocation']}
                  contentStyle={{
                    backgroundColor: 'hsl(var(--card))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: '6px',
                    fontSize: '12px',
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            {/* Custom compact legend */}
            <div className="mt-2 max-h-[120px] overflow-y-auto space-y-1">
              {chartData.map((entry) => (
                <div key={entry.id} className="flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 min-w-0">
                    <span
                      className="h-2.5 w-2.5 rounded-sm shrink-0"
                      style={{ backgroundColor: entry.fill }}
                    />
                    <span className="truncate">{entry.name}</span>
                  </span>
                  <span className="text-muted-foreground tabular-nums shrink-0 ml-2">
                    {entry.value.toFixed(1)}%
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
