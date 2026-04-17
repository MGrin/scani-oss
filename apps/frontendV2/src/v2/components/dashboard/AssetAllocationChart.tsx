import { useCallback, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { useBaseCurrency } from '../../hooks/useBaseCurrency';
import { STORAGE_KEYS } from '../../lib/constants';
import { formatCompact, formatMoney } from '../../lib/format';

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
type ChartType = 'donut' | 'bar' | 'list';

const DIMENSION_OPTIONS: { value: Dimension; label: string }[] = [
  { value: 'token_type', label: 'Type' },
  { value: 'institution', label: 'Institution' },
  { value: 'account', label: 'Account' },
  { value: 'group', label: 'Group' },
];

const CHART_TYPE_OPTIONS: { value: ChartType; label: string }[] = [
  { value: 'donut', label: 'Donut' },
  { value: 'bar', label: 'Bar' },
  { value: 'list', label: 'List' },
];

interface PersistedChartState {
  chartType: ChartType;
  dimension: Dimension;
}

function loadPersistedState(): PersistedChartState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.dashboardChart);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.chartType === 'string' && typeof parsed.dimension === 'string') {
      return parsed as PersistedChartState;
    }
  } catch {
    // ignore
  }
  return null;
}

function persistState(state: PersistedChartState) {
  try {
    localStorage.setItem(STORAGE_KEYS.dashboardChart, JSON.stringify(state));
  } catch {
    // ignore quota exceeded
  }
}

interface ChartEntry {
  [key: string]: unknown;
  id: string;
  name: string;
  monetaryValue: number;
  percentage: number;
  fill: string;
}

export function AssetAllocationChart() {
  const persisted = useMemo(() => loadPersistedState(), []);
  const [dimension, setDimension] = useState<Dimension>(persisted?.dimension ?? 'token_type');
  const [chartType, setChartType] = useState<ChartType>(persisted?.chartType ?? 'donut');
  const { symbol: currencySymbol } = useBaseCurrency();

  const { data: allocation, isLoading } = trpc.dashboard.getAssetAllocation.useQuery({
    dimension,
  });

  const persist = useCallback(
    (updates: Partial<PersistedChartState>) => {
      const state: PersistedChartState = {
        chartType: updates.chartType ?? chartType,
        dimension: updates.dimension ?? dimension,
      };
      persistState(state);
    },
    [chartType, dimension]
  );

  const handleDimensionChange = useCallback(
    (d: Dimension) => {
      setDimension(d);
      persist({ dimension: d });
    },
    [persist]
  );

  const handleChartTypeChange = useCallback(
    (ct: ChartType) => {
      setChartType(ct);
      persist({ chartType: ct });
    },
    [persist]
  );

  const chartData: ChartEntry[] = useMemo(() => {
    if (!allocation?.items) return [];
    const sorted = [...allocation.items].sort((a, b) => Number(b.value) - Number(a.value));
    const MAX_SLICES = 8;
    if (sorted.length <= MAX_SLICES) {
      return sorted.map((item, index) => ({
        id: item.id,
        name: item.name,
        monetaryValue: Number(item.value) || 0,
        percentage: Number(item.percentage) || 0,
        fill: COLORS[index % COLORS.length] ?? '#3b82f6',
      }));
    }
    const top = sorted.slice(0, MAX_SLICES - 1);
    const rest = sorted.slice(MAX_SLICES - 1);
    const otherValue = rest.reduce((sum, item) => sum + (Number(item.value) || 0), 0);
    const otherPct = rest.reduce((sum, item) => sum + (Number(item.percentage) || 0), 0);
    return [
      ...top.map((item, index) => ({
        id: item.id,
        name: item.name,
        monetaryValue: Number(item.value) || 0,
        percentage: Number(item.percentage) || 0,
        fill: COLORS[index % COLORS.length] ?? '#3b82f6',
      })),
      {
        id: '__other__',
        name: `Other (${rest.length})`,
        monetaryValue: otherValue,
        percentage: otherPct,
        fill: '#94a3b8',
      },
    ];
  }, [allocation?.items]);

  const currency = allocation?.baseCurrency || currencySymbol;

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
                onClick={() => handleDimensionChange(opt.value)}
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
        <div className="flex justify-end mt-1">
          <div className="flex rounded border border-border overflow-hidden">
            {CHART_TYPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => handleChartTypeChange(opt.value)}
                className={`px-2 py-1 text-[10px] leading-none transition-colors border-r last:border-r-0 border-border ${
                  chartType === opt.value
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
        ) : chartType === 'donut' ? (
          <DonutView data={chartData} currency={currency} />
        ) : chartType === 'bar' ? (
          <BarView data={chartData} currency={currency} />
        ) : (
          <ListView data={chartData} currency={currency} />
        )}
      </CardContent>
    </Card>
  );
}

function Legend({ data, currency }: { data: ChartEntry[]; currency: string }) {
  return (
    <div className="mt-2 max-h-[120px] overflow-y-auto space-y-1">
      {data.map((entry) => (
        <div key={entry.id} className="flex items-center justify-between text-xs">
          <span className="flex items-center gap-1.5 min-w-0">
            <span
              className="h-2.5 w-2.5 rounded-sm shrink-0"
              style={{ backgroundColor: entry.fill }}
            />
            <span className="truncate">{entry.name}</span>
          </span>
          <span className="text-muted-foreground tabular-nums shrink-0 ml-2">
            {formatMoney(entry.monetaryValue, currency, { decimals: 0 })}
          </span>
        </div>
      ))}
    </div>
  );
}

function DonutView({ data, currency }: { data: ChartEntry[]; currency: string }) {
  return (
    <div>
      <ResponsiveContainer width="100%" height={180}>
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={40}
            outerRadius={75}
            paddingAngle={2}
            dataKey="monetaryValue"
          >
            {data.map((entry) => (
              <Cell key={entry.id} fill={entry.fill} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value: number) => [formatMoney(value, currency, { decimals: 0 }), 'Value']}
            contentStyle={{
              backgroundColor: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '6px',
              fontSize: '12px',
            }}
          />
        </PieChart>
      </ResponsiveContainer>
      <Legend data={data} currency={currency} />
    </div>
  );
}

function BarView({ data, currency }: { data: ChartEntry[]; currency: string }) {
  return (
    <div>
      <ResponsiveContainer width="100%" height={data.length * 32 + 24}>
        <BarChart data={data} layout="vertical" margin={{ left: 0, right: 8, top: 4, bottom: 4 }}>
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="hsl(var(--border))" />
          <XAxis
            type="number"
            tickFormatter={(v: number) => formatCompact(v, currency)}
            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            width={100}
            tick={{ fontSize: 10, fill: 'hsl(var(--muted-foreground))' }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            formatter={(value: number) => [formatMoney(value, currency, { decimals: 0 }), 'Value']}
            contentStyle={{
              backgroundColor: 'hsl(var(--card))',
              border: '1px solid hsl(var(--border))',
              borderRadius: '6px',
              fontSize: '12px',
            }}
          />
          <Bar dataKey="monetaryValue" radius={[0, 4, 4, 0]}>
            {data.map((entry) => (
              <Cell key={entry.id} fill={entry.fill} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function ListView({ data, currency }: { data: ChartEntry[]; currency: string }) {
  const maxValue = Math.max(...data.map((d) => d.monetaryValue));

  return (
    <div className="space-y-2">
      {data.map((entry) => (
        <div key={entry.id} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 min-w-0">
              <span
                className="h-2.5 w-2.5 rounded-sm shrink-0"
                style={{ backgroundColor: entry.fill }}
              />
              <span className="truncate">{entry.name}</span>
            </span>
            <span className="tabular-nums shrink-0 ml-2 font-medium">
              {formatMoney(entry.monetaryValue, currency, { decimals: 0 })}
            </span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${maxValue > 0 ? (entry.monetaryValue / maxValue) * 100 : 0}%`,
                backgroundColor: entry.fill,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
