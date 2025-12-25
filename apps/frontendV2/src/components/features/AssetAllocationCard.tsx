import type { AssetAllocationDimension } from '@scani/shared';
import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MoneyDisplay } from '@/components/ui/money-display';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useAssetAllocationPreferences } from '@/hooks';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

type VisualizationType = 'list' | 'bar' | 'donut';

interface AssetAllocationCardProps {
  className?: string;
  /**
   * Pre-fetched asset allocation data (from dashboard.getOverview)
   * Used for token_type dimension to avoid duplicate API call
   */
  initialAllocation?: {
    items: Array<{
      id: string;
      code: string;
      name: string;
      value: string;
      percentage: string;
    }>;
    totalValue: string;
    baseCurrency: string;
  };
}

const DIMENSION_LABELS: Record<AssetAllocationDimension, string> = {
  token: 'Token',
  token_type: 'Token Type',
  account: 'Account',
  account_type: 'Account Type',
  institution: 'Institution',
  institution_type: 'Institution Type',
  group: 'Group',
};

const COLORS = [
  '#3b82f6', // blue-500
  '#10b981', // emerald-500
  '#f59e0b', // amber-500
  '#ef4444', // red-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#06b6d4', // cyan-500
  '#f97316', // orange-500
  '#84cc16', // lime-500
  '#6366f1', // indigo-500
];

export function AssetAllocationCard({ className, initialAllocation }: AssetAllocationCardProps) {
  const { dimension, visualizationType, setDimension, setVisualizationType } =
    useAssetAllocationPreferences();

  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();

  // Only fetch if not token_type (which is provided via initialAllocation)
  const { data: fetchedAllocation, isLoading } = trpc.dashboard.getAssetAllocation.useQuery(
    { dimension },
    { enabled: dimension !== 'token_type' || !initialAllocation }
  );

  // Use initial data for token_type, fetched data for other dimensions
  const allocation =
    dimension === 'token_type' && initialAllocation ? initialAllocation : fetchedAllocation;

  const currency = baseCurrency?.symbol || 'USD';
  const baseCurrencyToken = createCurrencyToken(currency);

  // Transform data for charts
  const chartData = useMemo(() => {
    if (!allocation?.items) return [];
    return allocation.items.map((item, index) => ({
      id: item.id,
      name: item.name,
      value: Number(item.value) || 0,
      percentage: Number(item.percentage) || 0,
      fill: COLORS[index % COLORS.length],
    }));
  }, [allocation?.items]);

  const renderVisualization = () => {
    if (isLoading) {
      return (
        <div className="space-y-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center justify-between">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-12" />
            </div>
          ))}
        </div>
      );
    }

    if (!allocation?.items || allocation.items.length === 0) {
      return <div className="text-sm text-muted-foreground">No assets yet</div>;
    }

    switch (visualizationType) {
      case 'list':
        return (
          <div className="space-y-4">
            {allocation.items.map((item, index) => (
              <div key={item.id} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: COLORS[index % COLORS.length] }}
                  />
                  <span className="text-sm font-medium">{item.name}</span>
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium">{item.percentage}%</div>
                  <div className="text-xs text-muted-foreground">
                    <MoneyDisplay value={item.value} token={baseCurrencyToken} showSymbol={false} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        );

      case 'bar':
        return (
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={chartData} margin={{ top: 10, right: 10, left: 10, bottom: 60 }}>
              <XAxis
                dataKey="name"
                angle={-45}
                textAnchor="end"
                height={80}
                tick={{ fontSize: 12 }}
              />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip
                formatter={(
                  value: number,
                  _name: string,
                  props?: { payload?: { name: string } }
                ) => {
                  const item = allocation?.items.find((i) => i.name === props?.payload?.name);
                  const currencyValue = item ? Number(item.value) : 0;
                  return [
                    `${value.toFixed(2)}% (${
                      baseCurrency?.symbol || 'USD'
                    } ${currencyValue.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })})`,
                    'Allocation',
                  ];
                }}
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '6px',
                }}
              />
              <Legend wrapperStyle={{ fontSize: '12px' }} />
              <Bar dataKey="percentage" name="Allocation %" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        );

      case 'donut':
        return (
          <ResponsiveContainer width="100%" height={300}>
            <PieChart>
              <Pie
                data={chartData}
                cx="50%"
                cy="50%"
                innerRadius={60}
                outerRadius={100}
                paddingAngle={2}
                dataKey="percentage"
                label={(props) => {
                  const payload = props.payload as {
                    name: string;
                    percentage: number;
                  };
                  return `${payload.name}: ${payload.percentage.toFixed(1)}%`;
                }}
                labelLine={{ stroke: 'hsl(var(--foreground))', strokeWidth: 1 }}
              >
                {chartData.map((entry) => (
                  <Cell key={entry.id} fill={entry.fill} />
                ))}
              </Pie>
              <Tooltip
                formatter={(value: number, _name: string, props?: { name?: string }) => {
                  const item = allocation?.items.find((i) => i.name === props?.name);
                  const currencyValue = item ? Number(item.value) : 0;
                  return [
                    `${value.toFixed(2)}% (${
                      baseCurrency?.symbol || 'USD'
                    } ${currencyValue.toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })})`,
                    'Allocation',
                  ];
                }}
                contentStyle={{
                  backgroundColor: 'hsl(var(--card))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: '6px',
                }}
              />
            </PieChart>
          </ResponsiveContainer>
        );

      default:
        return null;
    }
  };

  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <CardTitle>Asset Allocation</CardTitle>
          <div className="flex flex-col sm:flex-row gap-2">
            <Select
              value={dimension}
              onValueChange={(value) => setDimension(value as AssetAllocationDimension)}
            >
              <SelectTrigger className="w-full sm:w-[180px]">
                <SelectValue placeholder="Select dimension" />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(DIMENSION_LABELS).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              value={visualizationType}
              onValueChange={(value) => setVisualizationType(value as VisualizationType)}
            >
              <SelectTrigger className="w-full sm:w-[140px]">
                <SelectValue placeholder="Visualization" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="list">List</SelectItem>
                <SelectItem value="bar">Bar Chart</SelectItem>
                <SelectItem value="donut">Donut Chart</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>{renderVisualization()}</CardContent>
    </Card>
  );
}
