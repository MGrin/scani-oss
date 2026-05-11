import { formatNumber } from '@scani/shared';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getAppDbStats } from '@/lib/clients/appDb';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function UsersPage() {
  const fetchedAt = new Date().toISOString();
  const stats = await getAppDbStats();
  if (!stats.ok) {
    return (
      <>
        <PageHeader title="Users" fetchedAt={fetchedAt} />
        <ErrorPanel service="App database" error={stats.error} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Users"
        description="Account totals from the production database. Signup velocity + recent-signups list arrive in Phase 2."
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Total users" value={formatNumber(stats.data.users)} />
        <StatCard label="Active sessions" value={formatNumber(stats.data.activeSessions)} />
        <StatCard label="Vaults (portfolios)" value={formatNumber(stats.data.vaults)} />
        <StatCard label="Accounts" value={formatNumber(stats.data.accounts)} />
      </div>

      <SectionCard title="Coming in Phase 2" className="mt-6">
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          <li>Signup-velocity chart (7d / 30d).</li>
          <li>Recent signups table (anonymized email + base currency + creation time).</li>
          <li>Breakdown by base currency.</li>
          <li>Inactive-user reaper hook (no holdings + no integrations + N days idle).</li>
        </ul>
      </SectionCard>
    </>
  );
}
