import { format } from 'date-fns';
import { Calendar } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MoneyDisplay } from '@/components/ui/money-display';
import { PageHeader } from '@/components/ui/page-header';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

type ChartResolution = 'best' | 'hourly' | 'daily' | 'weekly' | 'monthly';

const RESOLUTION_OPTIONS: { value: ChartResolution; label: string }[] = [
  { value: 'best', label: 'All Events' },
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

export function PortfolioHistory() {
  const [dateRange] = useState(() => {
    const endDate = new Date();
    const startDate = new Date();
    startDate.setMonth(startDate.getMonth() - 3); // Last 3 months by default
    return { startDate, endDate };
  });

  const [chartResolution, setChartResolution] = useState<ChartResolution>('daily');
  const [eventsOffset, setEventsOffset] = useState(0);
  const [allEvents, setAllEvents] = useState<
    Array<{
      timestamp: string;
      eventType: 'holding_update' | 'price_update';
      holdingId?: string;
      tokenId: string;
      tokenSymbol: string;
      tokenName: string;
      balance: string;
      price: string;
      value: string;
      baseCurrencySymbol: string;
    }>
  >([]);
  const eventsPerPage = 20;

  // Fetch chart data
  const { data: chartData, isLoading: chartLoading } = trpc.portfolioHistory.getChart.useQuery(
    {
      startDate: dateRange.startDate.toISOString(),
      endDate: dateRange.endDate.toISOString(),
      resolution: chartResolution,
    },
    {
      staleTime: Number.POSITIVE_INFINITY, // Cache indefinitely as past data never changes
      cacheTime: Number.POSITIVE_INFINITY,
    }
  );

  // Fetch events data
  const { data: eventsData, isLoading: eventsLoading } = trpc.portfolioHistory.getEvents.useQuery(
    {
      limit: eventsPerPage,
      offset: eventsOffset,
      startDate: dateRange.startDate.toISOString(),
      endDate: dateRange.endDate.toISOString(),
    },
    {
      staleTime: Number.POSITIVE_INFINITY, // Cache indefinitely
      cacheTime: Number.POSITIVE_INFINITY,
      enabled: true,
    }
  );

  // Accumulate events as new pages load
  useEffect(() => {
    if (eventsData?.events) {
      if (eventsOffset === 0) {
        // First page, replace all events
        setAllEvents(eventsData.events);
      } else {
        // Subsequent pages, append events
        setAllEvents((prev) => [...prev, ...eventsData.events]);
      }
    }
  }, [eventsData, eventsOffset]);

  // Fetch current portfolio value from dashboard (source of truth)
  const { data: dashboardOverview } = trpc.dashboard.getOverview.useQuery();
  const currentPortfolioValue = dashboardOverview?.portfolioValue?.totalValue
    ? Number.parseFloat(dashboardOverview.portfolioValue.totalValue)
    : null;

  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const currency = baseCurrency?.symbol || 'USD';
  const baseCurrencyToken = createCurrencyToken(currency);

  // Transform chart data for Recharts
  const formattedChartData = useMemo(() => {
    if (!chartData) return [];
    return chartData.map((point) => ({
      timestamp: new Date(point.timestamp).getTime(),
      value: Number(point.totalValue),
      displayDate: format(new Date(point.timestamp), 'MMM d, yyyy'),
    }));
  }, [chartData]);

  // Infinite scroll logic
  const eventsListRef = useRef<HTMLDivElement>(null);
  const hasMore = eventsData?.hasMore ?? false;

  useEffect(() => {
    const handleScroll = () => {
      if (!eventsListRef.current || !hasMore || eventsLoading) return;

      const { scrollTop, scrollHeight, clientHeight } = eventsListRef.current;
      if (scrollHeight - scrollTop <= clientHeight * 1.5) {
        // Load more when 150% scrolled
        setEventsOffset((prev) => prev + eventsPerPage);
      }
    };

    const listElement = eventsListRef.current;
    if (listElement) {
      listElement.addEventListener('scroll', handleScroll);
      return () => listElement.removeEventListener('scroll', handleScroll);
    }
  }, [hasMore, eventsLoading]);

  // Use current portfolio value from dashboard (same as shown everywhere else)
  // Fall back to last chart point only if dashboard data not yet loaded
  const displayValue =
    currentPortfolioValue ?? formattedChartData[formattedChartData.length - 1]?.value ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader title="Portfolio History" subtitle="Track your portfolio value over time" />

      {/* Portfolio Value Chart */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
          <CardTitle>Portfolio Value Over Time</CardTitle>
          <Select
            value={chartResolution}
            onValueChange={(value) => setChartResolution(value as ChartResolution)}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Resolution" />
            </SelectTrigger>
            <SelectContent>
              {RESOLUTION_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardHeader>
        <CardContent>
          {chartLoading ? (
            <div className="h-[400px] flex items-center justify-center">
              <Skeleton className="h-full w-full" />
            </div>
          ) : formattedChartData.length === 0 ? (
            <div className="h-[400px] flex items-center justify-center text-muted-foreground">
              <div className="text-center">
                <Calendar className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>No history data available yet</p>
                <p className="text-sm mt-1">History will appear as you update your holdings</p>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-muted-foreground">Current Portfolio Value</p>
                  <p className="text-3xl font-bold">
                    <MoneyDisplay value={displayValue} token={baseCurrencyToken} />
                  </p>
                </div>
                <div className="text-right">
                  <p className="text-sm text-muted-foreground">Time Period</p>
                  <p className="text-sm font-medium">
                    {format(dateRange.startDate, 'MMM d, yyyy')} -{' '}
                    {format(dateRange.endDate, 'MMM d, yyyy')}
                  </p>
                </div>
              </div>

              <ResponsiveContainer width="100%" height={400}>
                <AreaChart
                  data={formattedChartData}
                  margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
                >
                  <defs>
                    <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis
                    dataKey="timestamp"
                    type="number"
                    domain={['dataMin', 'dataMax']}
                    tickFormatter={(timestamp) => format(new Date(timestamp), 'MMM d')}
                    stroke="#9ca3af"
                  />
                  <YAxis
                    tickFormatter={(value) => `${currency}${(value / 1000).toFixed(0)}k`}
                    stroke="#9ca3af"
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'white',
                      border: '1px solid #e5e7eb',
                      borderRadius: '8px',
                    }}
                    formatter={(value: number) => [
                      `${currency}${value.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}`,
                      'Value',
                    ]}
                    labelFormatter={(timestamp) => format(new Date(timestamp), 'MMM d, yyyy HH:mm')}
                  />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#colorValue)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Events List */}
      <Card>
        <CardHeader>
          <CardTitle>Portfolio Events</CardTitle>
        </CardHeader>
        <CardContent>
          <div
            ref={eventsListRef}
            className="space-y-3 max-h-[600px] overflow-y-auto pr-2"
            style={{ scrollBehavior: 'smooth' }}
          >
            {eventsLoading && eventsOffset === 0 ? (
              // Initial loading state
              [1, 2, 3].map((i) => (
                <div key={i} className="flex items-center justify-between p-4 border rounded-lg">
                  <div className="space-y-2 flex-1">
                    <Skeleton className="h-4 w-32" />
                    <Skeleton className="h-3 w-48" />
                  </div>
                  <Skeleton className="h-6 w-24" />
                </div>
              ))
            ) : allEvents.length > 0 ? (
              <>
                {allEvents.map((event, index) => (
                  <div
                    key={`${event.timestamp}-${event.tokenId}-${index}`}
                    className="flex items-center justify-between p-4 border rounded-lg hover:bg-accent transition-colors"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium">{event.tokenSymbol}</p>
                        <span className="text-xs text-muted-foreground px-2 py-1 bg-secondary rounded">
                          {event.eventType === 'holding_update' ? 'Balance Update' : 'Price Update'}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mt-1">{event.tokenName}</p>
                      <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                        <span>Balance: {Number(event.balance).toLocaleString()}</span>
                        <span>
                          Price:{' '}
                          <MoneyDisplay
                            value={Number(event.price)}
                            token={baseCurrencyToken}
                            className="inline"
                          />
                        </span>
                        <span>{format(new Date(event.timestamp), 'MMM d, yyyy HH:mm')}</span>
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="font-semibold">
                        <MoneyDisplay value={Number(event.value)} token={baseCurrencyToken} />
                      </p>
                    </div>
                  </div>
                ))}

                {/* Loading more indicator */}
                {eventsLoading && eventsOffset > 0 && (
                  <div className="flex items-center justify-center p-4">
                    <Skeleton className="h-16 w-full" />
                  </div>
                )}

                {/* End of list indicator */}
                {!hasMore && (
                  <div className="text-center text-sm text-muted-foreground p-4">
                    No more events to load
                  </div>
                )}
              </>
            ) : (
              <div className="text-center text-muted-foreground p-8">
                <Calendar className="h-12 w-12 mx-auto mb-2 opacity-50" />
                <p>No events recorded yet</p>
                <p className="text-sm mt-1">Events will appear as you update your holdings</p>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
