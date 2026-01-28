import { useNavigate } from 'react-router-dom';
import { Area, AreaChart, ResponsiveContainer } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MoneyDisplay } from '@/components/ui/money-display';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

interface PortfolioValueCardProps {
  value: number;
  currency: string;
}

export function PortfolioValueCard({ value, currency }: PortfolioValueCardProps) {
  const navigate = useNavigate();

  // Fetch mini chart data (last 30 days)
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);

  // biome-ignore lint/suspicious/noExplicitAny: tRPC types not yet generated, will be available after backend build
  const { data: chartData, isLoading } = (trpc as any).portfolioHistory.getChart.useQuery(
    {
      startDate: startDate.toISOString(),
      endDate: endDate.toISOString(),
      maxPoints: 50, // Just need a few points for mini chart
    },
    {
      staleTime: 5 * 60 * 1000, // 5 minutes
      cacheTime: 10 * 60 * 1000,
    }
  );

  const chartPoints =
    chartData?.map((point: { totalValue: string }) => ({
      value: Number(point.totalValue),
    })) || [];

  return (
    <Card
      className="cursor-pointer hover:shadow-lg transition-shadow relative overflow-hidden"
      onClick={() => navigate('/portfolio-history')}
    >
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2 relative z-10">
        <CardTitle className="text-sm font-medium">Total Portfolio Value</CardTitle>
      </CardHeader>
      <CardContent className="relative z-10">
        <MoneyDisplay
          value={value}
          token={createCurrencyToken(currency)}
          className="text-2xl font-bold"
        />
        {!isLoading && chartPoints.length > 0 && (
          <p className="text-xs text-muted-foreground mt-1">Click to view full history</p>
        )}
      </CardContent>

      {/* Background mini chart */}
      {!isLoading && chartPoints.length > 1 && (
        <div className="absolute inset-0 opacity-10 pointer-events-none">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartPoints} margin={{ top: 0, right: 0, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="miniGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.8} />
                  <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area
                type="monotone"
                dataKey="value"
                stroke="#3b82f6"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#miniGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {isLoading && (
        <div className="absolute inset-0 opacity-5 pointer-events-none">
          <Skeleton className="h-full w-full" />
        </div>
      )}
    </Card>
  );
}
