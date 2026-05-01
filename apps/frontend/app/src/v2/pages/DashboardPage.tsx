import { Card, CardContent, CardHeader } from '@scani/ui/ui/card';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { Building2, PieChart, Wallet } from 'lucide-react';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { AssetAllocationChart } from '../components/dashboard/AssetAllocationChart';
import { NetWorthChart } from '../components/dashboard/NetWorthChart';
import { PortfolioSummary } from '../components/dashboard/PortfolioSummary';
import { StatCard } from '../components/dashboard/StatCard';
import { TopHoldingsList } from '../components/dashboard/TopHoldingsList';
import { VaultProgressList } from '../components/dashboard/VaultProgressList';
import { V2_ROUTES } from '../lib/routes';

function StatSkeleton() {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <Skeleton className="h-4 w-24" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-8 w-20 mb-2" />
      </CardContent>
    </Card>
  );
}

export function DashboardPage() {
  const { data: overview, isLoading: overviewLoading } = trpc.dashboard.getOverview.useQuery();
  const { data: vaults } = trpc.vaults.getAll.useQuery();
  const { data: baseCurrency } = trpc.users.getBaseCurrency.useQuery();

  const currency = baseCurrency?.symbol || 'USD';
  const totalValue = Number.parseFloat(overview?.portfolioValue.totalValue || '0');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Dashboard</h2>
        <p className="text-muted-foreground mt-1">Your portfolio overview</p>
      </div>

      {/* Stat cards */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {overviewLoading ? (
          <>
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
            <StatSkeleton />
          </>
        ) : (
          <>
            <PortfolioSummary value={totalValue} currency={currency} />
            <Link to={V2_ROUTES.institutions}>
              <StatCard
                label="Institutions"
                value={overview?.counts.institutions ?? 0}
                icon={Building2}
              />
            </Link>
            <Link to={V2_ROUTES.accounts}>
              <StatCard label="Accounts" value={overview?.counts.accounts ?? 0} icon={Wallet} />
            </Link>
            <Link to={V2_ROUTES.holdings}>
              <StatCard label="Holdings" value={overview?.counts.holdings ?? 0} icon={PieChart} />
            </Link>
          </>
        )}
      </div>

      {/* Net worth history — full width above asset allocation */}
      <NetWorthChart />

      {/* Charts + Lists */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <AssetAllocationChart />
          {vaults && <VaultProgressList vaults={vaults} />}
        </div>
        <div className="space-y-4">
          <TopHoldingsList
            holdings={overview?.topHoldings ?? []}
            totalValue={totalValue}
            currency={currency}
          />
        </div>
      </div>
    </div>
  );
}
