import { Link } from 'react-router-dom';
import {
  AccountBadge,
  AssetAllocationCard,
  InstitutionBadge,
  TokenTypeBadge,
} from '@/components/features';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MoneyDisplay } from '@/components/ui/money-display';
import { PageHeader } from '@/components/ui/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { SummaryCard } from '@/components/ui/summary-card';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

export function Dashboard() {
  // Fetch dashboard data
  const { data: overview, isLoading: overviewLoading } = trpc.dashboard.getOverview.useQuery();
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();

  const currency = baseCurrency?.symbol || 'USD';
  const baseCurrencyToken = createCurrencyToken(currency);

  return (
    <div className="space-y-6">
      <PageHeader title="Dashboard" subtitle="Your portfolio overview" />

      {/* Key Metrics */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {overviewLoading ? (
          // Show skeleton summary cards while loading
          <>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <Skeleton className="h-4 w-32" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-24 mb-2" />
                <Skeleton className="h-3 w-16" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-16 mb-2" />
                <Skeleton className="h-3 w-20" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <Skeleton className="h-4 w-20" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-16 mb-2" />
                <Skeleton className="h-3 w-16" />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <Skeleton className="h-4 w-20" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-16 mb-2" />
                <Skeleton className="h-3 w-16" />
              </CardContent>
            </Card>
          </>
        ) : (
          <>
            <SummaryCard
              type="currency"
              title="Total Portfolio Value"
              value={parseFloat(overview?.portfolioValue.totalValue || '0')}
              currency={currency}
            />

            <Link to="/institutions">
              <SummaryCard
                type="count"
                title="Institutions"
                value={overview?.counts.institutions || 0}
                label="institutions"
              />
            </Link>

            <Link to="/accounts">
              <SummaryCard
                type="count"
                title="Accounts"
                value={overview?.counts.accounts || 0}
                label="accounts"
              />
            </Link>

            <Link to="/holdings">
              <SummaryCard
                type="count"
                title="Holdings"
                value={overview?.counts.holdings || 0}
                label="holdings"
              />
            </Link>
          </>
        )}
      </div>

      {/* Asset Allocation & Top Holdings */}
      <div className="flex flex-col gap-4 md:flex-row md:align-center md:justify-stretch">
        <AssetAllocationCard
          className="w-full h-fit"
          initialAllocation={overview?.assetAllocation}
        />

        <Card className="w-full">
          <CardHeader>
            <CardTitle>Top Holdings</CardTitle>
          </CardHeader>
          <CardContent>
            {overviewLoading ? (
              <div className="space-y-4">
                {[1, 2, 3].map((i) => (
                  <div key={i} className="flex items-center justify-between">
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-16" />
                      <Skeleton className="h-3 w-32" />
                    </div>
                    <Skeleton className="h-4 w-20" />
                  </div>
                ))}
              </div>
            ) : overview?.topHoldings && overview.topHoldings.length > 0 ? (
              <div className="space-y-4">
                {overview.topHoldings.map((holding) => (
                  <div
                    key={holding.id}
                    className="flex items-center justify-between border-b last:border-b-0 pb-2"
                  >
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <div className="font-medium">{holding.symbol}</div>
                        <TokenTypeBadge tokenTypeCode={holding.tokenTypeCode} />
                      </div>
                      <div className="text-sm text-muted-foreground mt-1">{holding.name}</div>
                      <div className="flex flex-col md:flex-row items-start md:items-center gap-2 mt-1">
                        <AccountBadge
                          accountId={holding.accountId}
                          accountName={holding.accountName}
                          accountTypeCode={holding.accountTypeCode}
                        />
                        <InstitutionBadge
                          institutionId={holding.institutionId}
                          institutionName={holding.institutionName}
                          institutionWebsite={holding.institutionWebsite ?? undefined}
                        />
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium">
                        <MoneyDisplay value={holding.value} token={baseCurrencyToken} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-sm text-muted-foreground">No holdings yet</div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
