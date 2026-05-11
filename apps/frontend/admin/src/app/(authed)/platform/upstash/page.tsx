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
            {stats.ok ? (
              <>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard
                    label="Monthly requests"
                    value={formatNumber(stats.data.monthlyRequests)}
                    sub={
                      stats.data.dailyRequests > 0
                        ? `${formatNumber(stats.data.dailyRequests)} today`
                        : undefined
                    }
                  />
                  <StatCard
                    label="Monthly bandwidth"
                    value={formatBytes(stats.data.monthlyBandwidthBytes)}
                    sub={
                      stats.data.dailyBandwidthBytes > 0
                        ? `${formatBytes(stats.data.dailyBandwidthBytes)} today`
                        : undefined
                    }
                  />
                  <StatCard
                    label="Monthly connections"
                    value={formatNumber(stats.data.monthlyConnections)}
                    sub={
                      stats.data.dailyConnections > 0
                        ? `${formatNumber(stats.data.dailyConnections)} today`
                        : undefined
                    }
                  />
                  <StatCard label="Keyspace" value={formatNumber(stats.data.keyspace)} />
                </div>
                <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <StatCard label="Storage" value={formatBytes(stats.data.storageBytes)} />
                  <StatCard
                    label="Read latency"
                    value={`${stats.data.readLatencyMean.toFixed(2)} ms`}
                  />
                  <StatCard
                    label="Write latency"
                    value={`${stats.data.writeLatencyMean.toFixed(2)} ms`}
                  />
                  <StatCard label="Created" value={formatRelative(new Date(db.createdAt * 1000))} />
                </div>
              </>
            ) : (
              <ErrorPanel service={`${db.name} stats`} error={stats.error} />
            )}
            <div className="mt-3 font-mono text-xs text-muted-foreground">
              {db.endpoint}:{db.port}
            </div>
          </SectionCard>
        ))}
      </div>
    </>
  );
}
