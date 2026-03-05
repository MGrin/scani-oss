import { Vault } from 'lucide-react';
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
import { PortfolioValueCard } from '@/components/ui/portfolio-value-card';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { SummaryCard } from '@/components/ui/summary-card';
import { trpc } from '@/lib/trpc';
import { createCurrencyToken } from '@/lib/utils';

export function Dashboard() {
  // Fetch dashboard data
  const { data: overview, isLoading: overviewLoading } = trpc.dashboard.getOverview.useQuery();
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();
  const { data: vaults } = trpc.vaults.getAll.useQuery();

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
            <PortfolioValueCard
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

      {/* Asset Allocation, Vaults & Top Holdings */}
      <div className="flex flex-col gap-4 md:flex-row md:align-center md:justify-stretch">
        <div className="w-full flex flex-col gap-4">
          <AssetAllocationCard
            className="w-full h-fit"
            initialAllocation={overview?.assetAllocation}
          />

          {/* Vaults */}
          {vaults && vaults.length > 0 && (
            <Card className="w-full">
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    <Vault className="h-4 w-4" />
                    Vaults
                  </CardTitle>
                  <Link
                    to="/vaults"
                    className="text-sm text-muted-foreground hover:text-foreground transition-colors"
                  >
                    View all
                  </Link>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {vaults.map((vault) => {
                  const progressClamped = Math.min(vault.progress, 100);
                  return (
                    <Link
                      key={vault.id}
                      to={`/vaults/${vault.id}`}
                      className="block hover:bg-accent/50 -mx-2 px-2 py-2 rounded-md transition-colors"
                    >
                      <div className="flex items-center gap-2 mb-1.5">
                        <div
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ backgroundColor: vault.color }}
                        />
                        <span className="text-sm font-medium truncate flex-1">{vault.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {vault.progress.toFixed(0)}%
                        </span>
                      </div>
                      <Progress value={progressClamped} className="h-1.5 mb-1" />
                      <div className="flex justify-between text-xs text-muted-foreground">
                        <span>
                          {vault.currencySymbol}{' '}
                          {Number.parseFloat(vault.currentAmount).toLocaleString(undefined, {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 0,
                          })}
                        </span>
                        <span>
                          of {vault.currencySymbol}{' '}
                          {Number.parseFloat(vault.targetAmount).toLocaleString(undefined, {
                            minimumFractionDigits: 0,
                            maximumFractionDigits: 0,
                          })}
                        </span>
                      </div>
                    </Link>
                  );
                })}
              </CardContent>
            </Card>
          )}
        </div>

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
