import { Decimal, FinancialMath } from '@scani/shared';
import {
  BarChart3,
  Calculator,
  DollarSign,
  PieChart,
  TrendingDown,
  TrendingUp,
  Wallet,
} from 'lucide-react';
import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  ResponsiveContainer,
  PieChart as RPieChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ColoredMonetaryValue, MonetaryValue } from '@/components/ui/monetary-value';
import { PageHeader } from '@/components/ui/page-header';
import { Progress } from '@/components/ui/progress';
import { SummaryCard } from '@/components/ui/summary-cards';
import type { ApiHolding, ApiToken } from '@/lib/api-types';
import { trpc } from '@/lib/trpc';

interface AssetAllocation {
  type: string;
  name: string;
  value: number;
  percentage: number;
  count: number;
  color: string;
}

interface MonthlyFlow {
  month: string;
  income: number;
  expenses: number;
  netFlow: number;
}

export function Analytics() {
  const { isLoading: accountsLoading } = trpc.accounts.getAll.useQuery();
  const { data: holdings, isLoading: holdingsLoading } = trpc.holdings.getAll.useQuery();
  const { data: transactions, isLoading: transactionsLoading } =
    trpc.transactions.getAll.useQuery();
  const { data: tokens } = trpc.tokens.getAll.useQuery();
  const { data: userPrefs } = trpc.users.getCurrent.useQuery();

  // Create lookup maps
  const tokensMap = tokens
    ? Object.fromEntries(tokens.map((token: ApiToken) => [token.id, token]))
    : {};

  // Calculate total net worth from holdings
  const totalNetWorth = useMemo(() => {
    if (!holdings) return new Decimal('0');
    return FinancialMath.sum(
      holdings.map((holding: ApiHolding) => FinancialMath.abs(holding.balance ?? 0))
    );
  }, [holdings]);

  // Asset allocation by token type
  const assetAllocation = useMemo((): AssetAllocation[] => {
    if (!holdings || !tokens) return [];

    // Generate colors dynamically based on token type string (similar to institution types)
    const generateTypeColor = (type: string): string => {
      let hash = 0;
      for (let i = 0; i < type.length; i++) {
        hash = type.charCodeAt(i) + ((hash << 5) - hash);
      }

      // Generate HSL color with good saturation and lightness for visibility
      const hue = Math.abs(hash) % 360;
      return `hsl(${hue}, 70%, 50%)`;
    };

    const allocationMap = new Map<string, { value: number; count: number; name: string }>();

    holdings.forEach((holding: ApiHolding) => {
      const token = tokensMap[holding.tokenId];
      if (!token) return;

      const tokenType = token.type ?? 'unknown';
      const value = FinancialMath.abs(holding.balance ?? 0);
      const existing = allocationMap.get(tokenType) || {
        value: 0,
        count: 0,
        name: tokenType,
      };

      allocationMap.set(tokenType, {
        value: FinancialMath.toNumber(FinancialMath.add(existing.value, value)),
        count: existing.count + 1,
        name: tokenType.charAt(0).toUpperCase() + tokenType.slice(1),
      });
    });

    const totalValue = FinancialMath.toNumber(totalNetWorth);

    return Array.from(allocationMap.entries())
      .map(([type, data]) => ({
        type,
        name: data.name,
        value: data.value,
        percentage: totalValue > 0 ? (data.value / totalValue) * 100 : 0,
        count: data.count,
        color: generateTypeColor(type),
      }))
      .sort((a, b) => b.value - a.value);
  }, [holdings, tokens, tokensMap, totalNetWorth]);

  // Monthly cash flow analysis
  const monthlyFlows = useMemo((): MonthlyFlow[] => {
    if (!transactions) return [];

    const flowMap = new Map<string, { income: number; expenses: number }>();
    const currentDate = new Date();

    // Generate last 6 months
    for (let i = 5; i >= 0; i--) {
      const date = new Date(currentDate.getFullYear(), currentDate.getMonth() - i, 1);
      const key = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;
      flowMap.set(key, { income: 0, expenses: 0 });
    }

    transactions.forEach((transaction) => {
      const date = new Date(transaction.timestamp);
      const key = `${date.getFullYear()}-${(date.getMonth() + 1).toString().padStart(2, '0')}`;

      if (!flowMap.has(key)) return;

      const flow = flowMap.get(key);
      if (!flow) return;
      const amount = FinancialMath.toNumber(FinancialMath.abs(transaction.amount));

      if (['deposit', 'sell', 'dividend', 'interest'].includes(transaction.type)) {
        flow.income += amount;
      } else if (['withdrawal', 'buy', 'fee'].includes(transaction.type)) {
        flow.expenses += amount;
      }
    });

    return Array.from(flowMap.entries()).map(([key, flow]) => {
      const [year, month] = key.split('-');
      const date = new Date(Number(year), Number(month) - 1);
      return {
        month: date.toLocaleDateString('en-US', {
          month: 'short',
          year: 'numeric',
        }),
        income: flow.income,
        expenses: flow.expenses,
        netFlow: flow.income - flow.expenses,
      };
    });
  }, [transactions]);

  // Performance metrics
  const performanceMetrics = useMemo(() => {
    if (!holdings || !transactions) return null;

    // TODO: Calculate cost basis from transactions instead of storing it
    const totalCostBasis = 0; // Placeholder until we implement cost basis calculation

    const currentValue = FinancialMath.toNumber(totalNetWorth);
    const totalGainLoss = currentValue - totalCostBasis;
    const totalGainLossPercentage = totalCostBasis > 0 ? (totalGainLoss / totalCostBasis) * 100 : 0;

    const totalTransactionFees = transactions.reduce((sum, transaction) => {
      return FinancialMath.toNumber(FinancialMath.add(sum, transaction.fee || 0));
    }, 0);

    return {
      totalCostBasis,
      currentValue,
      totalGainLoss,
      totalGainLossPercentage,
      totalTransactionFees,
    };
  }, [holdings, transactions, totalNetWorth]);

  if (accountsLoading || holdingsLoading || transactionsLoading || !tokens) {
    return (
      <div className="space-y-4">
        <PageHeader
          title="Analytics"
          subtitle="Insights into your financial portfolio"
          loading={true}
        />
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Card key={i}>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Loading...</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="h-6 bg-muted animate-pulse rounded"></div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  // Check if user has data
  const hasData = holdings && holdings.length > 0 && transactions && transactions.length > 0;

  if (!hasData) {
    return (
      <div className="space-y-4">
        <PageHeader title="Analytics" subtitle="Insights into your financial portfolio" />

        <Card className="p-8">
          <div className="text-center">
            <BarChart3 className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Data Available</h3>
            <p className="text-muted-foreground mb-4">
              You need to add accounts, holdings, and transactions before you can view analytics.
            </p>
            <div className="flex justify-center space-x-3">
              <Button
                onClick={() => {
                  window.location.href = '/institutions';
                }}
              >
                Add Institution
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  window.location.href = '/accounts';
                }}
              >
                Add Account
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  window.location.href = '/transactions';
                }}
              >
                Add Transaction
              </Button>
            </div>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Analytics"
        subtitle="Insights into your financial portfolio"
        secondaryActions={
          <div className="text-sm text-muted-foreground">
            Last updated: {new Date().toLocaleDateString('en-US')}
          </div>
        }
      />

      {/* Key Metrics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          type="currency"
          title="Net Worth"
          value={FinancialMath.toNumber(totalNetWorth)}
          currency={userPrefs?.baseCurrency?.symbol}
          subtitle={`Across ${holdings?.length || 0} holdings`}
          icon={Wallet}
        />

        {performanceMetrics && (
          <>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Gain/Loss</CardTitle>
                {performanceMetrics.totalGainLoss >= 0 ? (
                  <TrendingUp className="h-4 w-4 text-green-600" />
                ) : (
                  <TrendingDown className="h-4 w-4 text-red-600" />
                )}
              </CardHeader>
              <CardContent>
                <ColoredMonetaryValue
                  type="currency"
                  value={performanceMetrics.totalGainLoss}
                  currency={userPrefs?.baseCurrency?.symbol}
                  size="xl"
                  className="font-bold"
                  showSign={true}
                />
                <p className="text-xs text-muted-foreground">
                  {performanceMetrics.totalGainLossPercentage >= 0 ? '+' : ''}
                  {performanceMetrics.totalGainLossPercentage.toFixed(2)}%
                </p>
              </CardContent>
            </Card>

            <SummaryCard
              type="currency"
              title="Cost Basis"
              value={performanceMetrics.totalCostBasis}
              currency={userPrefs?.baseCurrency?.symbol}
              subtitle="Total invested"
              icon={Calculator}
            />

            <SummaryCard
              type="currency"
              title="Transaction Fees"
              value={performanceMetrics.totalTransactionFees}
              currency={userPrefs?.baseCurrency?.symbol}
              subtitle="Total fees paid"
              icon={DollarSign}
              className="[&_.value]:text-red-600"
            />
          </>
        )}
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {/* Asset Allocation */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <PieChart className="h-5 w-5" />
              <span>Asset Allocation</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-center">
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <RPieChart>
                    <Pie
                      data={assetAllocation}
                      dataKey="value"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      outerRadius={80}
                      label={(entry) =>
                        `${entry.name} (${(entry as AssetAllocation).percentage.toFixed(1)}%)`
                      }
                    >
                      {assetAllocation.map((entry) => (
                        <Cell key={entry.type} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value: number) =>
                        FinancialMath.formatCurrency(value, {
                          currency: userPrefs?.baseCurrency?.symbol,
                        })
                      }
                    />
                  </RPieChart>
                </ResponsiveContainer>
              </div>
              <div className="space-y-4">
                {assetAllocation.map((asset) => (
                  <div key={asset.type} className="space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <div
                          className="w-4 h-4 rounded-full"
                          style={{ backgroundColor: asset.color }}
                        />
                        <span className="font-medium">{asset.name}</span>
                        <span className="text-sm text-muted-foreground">
                          ({asset.count} holdings)
                        </span>
                      </div>
                      <div className="text-right">
                        <MonetaryValue
                          type="currency"
                          value={asset.value}
                          currency={userPrefs?.baseCurrency?.symbol}
                          className="font-semibold"
                        />
                        <div className="text-sm text-muted-foreground">
                          {asset.percentage.toFixed(1)}%
                        </div>
                      </div>
                    </div>
                    <Progress value={asset.percentage} className="h-2" />
                  </div>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Monthly Cash Flow */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center space-x-2">
              <BarChart3 className="h-5 w-5" />
              <span>Monthly Cash Flow</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthlyFlows}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="month" />
                  <YAxis
                    tickFormatter={(val) =>
                      FinancialMath.formatCurrency(val, {
                        currency: userPrefs?.baseCurrency?.symbol,
                      })
                    }
                  />
                  <Tooltip
                    formatter={(value: number) =>
                      FinancialMath.formatCurrency(value, {
                        currency: userPrefs?.baseCurrency?.symbol,
                      })
                    }
                  />
                  <Bar dataKey="income" fill="#16a34a" name="Income" />
                  <Bar dataKey="expenses" fill="#dc2626" name="Expenses" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Insights */}
      {performanceMetrics && (
        <Card>
          <CardHeader>
            <CardTitle>Insights & Recommendations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {performanceMetrics.totalGainLoss > 0 ? (
              <Alert>
                <TrendingUp className="h-4 w-4" />
                <AlertTitle>Portfolio Performance</AlertTitle>
                <AlertDescription>
                  Great job! Your portfolio is showing positive returns of{' '}
                  <MonetaryValue
                    type="currency"
                    value={performanceMetrics.totalGainLoss}
                    currency={userPrefs?.baseCurrency?.symbol}
                    className="inline"
                  />{' '}
                  ({performanceMetrics.totalGainLossPercentage.toFixed(2)}%).
                </AlertDescription>
              </Alert>
            ) : performanceMetrics.totalGainLoss < 0 ? (
              <Alert>
                <TrendingDown className="h-4 w-4" />
                <AlertTitle>Portfolio Review</AlertTitle>
                <AlertDescription>
                  Your portfolio is currently down{' '}
                  <MonetaryValue
                    type="currency"
                    value={Math.abs(performanceMetrics.totalGainLoss)}
                    currency={userPrefs?.baseCurrency?.symbol}
                    className="inline"
                  />{' '}
                  ({Math.abs(performanceMetrics.totalGainLossPercentage).toFixed(2)}
                  %). Consider reviewing your investment strategy and diversification.
                </AlertDescription>
              </Alert>
            ) : null}

            {assetAllocation.some((asset) => asset.percentage > 70) && (
              <Alert>
                <PieChart className="h-4 w-4" />
                <AlertTitle>Diversification Opportunity</AlertTitle>
                <AlertDescription>
                  You have a high concentration in one asset type. Consider diversifying across
                  different asset classes to reduce risk.
                </AlertDescription>
              </Alert>
            )}

            {performanceMetrics.totalTransactionFees > performanceMetrics.totalGainLoss * 0.1 && (
              <Alert>
                <Calculator className="h-4 w-4" />
                <AlertTitle>Transaction Costs</AlertTitle>
                <AlertDescription>
                  Your transaction fees represent a significant portion of your gains. Consider
                  reducing trading frequency or finding lower-cost investment options.
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
