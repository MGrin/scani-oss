import { formatBytes, formatNumber, formatRelative } from '@scani/shared';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getUpstashDatabases, getUpstashStats } from '@/lib/clients/upstash';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function UpstashPage() {
  const fetchedAt = new Date().toISOString();
  const dbs = await getUpstashDatabases();
  if (!dbs.ok) {
    return (
      <>
        <PageHeader title="Upstash Redis" fetchedAt={fetchedAt} />
        <ErrorPanel service="Upstash" error={dbs.error} />
      </>
    );
  }

  const statsResults = await Promise.all(
    dbs.data.map(async (d) => ({ db: d, stats: await getUpstashStats(d.id) }))
  );

  return (
    <>
      <PageHeader
        title="Upstash Redis"
        description="Backs BullMQ (scani-jobs), rate-limiter, and WebSocket pub/sub fan-out."
        fetchedAt={fetchedAt}
      />

      <div className="flex flex-col gap-6">
        {statsResults.map(({ db, stats }) => (
          <SectionCard
            key={db.id}
            title={db.name}
            description={
              <>
                {db.type} · {db.region} · TLS {db.tls ? 'on' : 'off'} · {db.state}
              </>
            }
          >
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard
                label="Total commands"
                value={formatNumber(db.totalCommands)}
                sub={stats.ok ? `${formatNumber(stats.data.dailyCommands)} monthly` : undefined}
              />
              <StatCard label="Daily bandwidth" value={formatBytes(db.totalDailyBandwidth)} />
              <StatCard label="Connections" value={formatNumber(db.totalConnections)} />
              <StatCard label="Created" value={formatRelative(new Date(db.createdAt * 1000))} />
            </div>
            <div className="mt-3 font-mono text-xs text-muted-foreground">
              {db.endpoint}:{db.port}
            </div>
          </SectionCard>
        ))}
      </div>
    </>
  );
}
