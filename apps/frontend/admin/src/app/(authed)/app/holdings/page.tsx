import { formatNumber, formatRelative } from '@scani/shared';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getAppDbStats } from '@/lib/clients/appDb';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function HoldingsPage() {
  const fetchedAt = new Date().toISOString();
  const stats = await getAppDbStats();
  if (!stats.ok) {
    return (
      <>
        <PageHeader title="Holdings" fetchedAt={fetchedAt} />
        <ErrorPanel service="App database" error={stats.error} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Holdings"
        description="Position counts, token catalog size, price freshness."
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Holdings" value={formatNumber(stats.data.holdings)} />
        <StatCard label="Tokens" value={formatNumber(stats.data.tokens)} />
        <StatCard
          label="Token price rows"
          value={formatNumber(stats.data.tokenPrices)}
          sub={`freshest ${formatRelative(stats.data.tokenPricesFreshestAt)}`}
        />
        <StatCard
          label="DB size"
          value={stats.data.dbSizePretty}
          sub={`${formatNumber(stats.data.dbSizeBytes)} bytes`}
        />
      </div>

      <SectionCard title="Coming in Phase 2" className="mt-6">
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>Holdings-by-source breakdown (blockchain vs CEX vs brokerage vs manual).</li>
          <li>Stale-balance probe (lastUpdated &gt; 24h on active holdings).</li>
          <li>
            Coverage quality from <code className="font-mono">portfolioValueDaily</code> rollup.
          </li>
          <li>Top tokens by holdings count.</li>
        </ul>
      </SectionCard>
    </>
  );
}
