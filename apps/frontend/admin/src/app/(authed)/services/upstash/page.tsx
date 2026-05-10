import { formatBytes, formatNumber, formatRelative } from '@scani/shared';
import { ErrorPanel } from '@/components/ErrorPanel';
import { MetricTile } from '@/components/MetricTile';
import { Section } from '@/components/Section';
import { getQueueDepths, getUpstashDatabases, getUpstashStats } from '@/lib/clients/upstash';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function UpstashPage() {
  const [dbs, queue] = await Promise.all([getUpstashDatabases(), getQueueDepths()]);

  if (!dbs.ok) return <ErrorPanel service="Upstash" error={dbs.error} />;

  const statsResults = await Promise.all(
    dbs.data.map(async (d) => ({ db: d, stats: await getUpstashStats(d.id) }))
  );

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">Upstash Redis</h1>
      <p className="text-xs text-muted-foreground mb-6">
        Backs BullMQ (scani-jobs), rate limiter, and WebSocket pub/sub fan-out
      </p>

      <Section title="BullMQ queue — scani-jobs">
        {queue.ok ? (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
            <MetricTile label="Waiting" value={queue.data.waiting} />
            <MetricTile label="Active" value={queue.data.active} />
            <MetricTile label="Delayed" value={queue.data.delayed} />
            <MetricTile label="Failed" value={queue.data.failed} />
            <MetricTile label="Completed" value={formatNumber(queue.data.completed)} />
          </div>
        ) : (
          <ErrorPanel service="Queue depths" error={queue.error} />
        )}
      </Section>

      <Section title="Databases">
        <div className="space-y-6">
          {statsResults.map(({ db, stats }) => (
            <div key={db.id}>
              <h3 className="text-sm font-semibold mb-3">
                {db.name}{' '}
                <span className="text-muted-foreground font-normal">
                  · {db.type} · {db.region} · TLS {db.tls ? 'on' : 'off'} · {db.state}
                </span>
              </h3>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                <MetricTile
                  label="Total commands"
                  value={formatNumber(db.totalCommands)}
                  sub={stats.ok ? `${formatNumber(stats.data.dailyCommands)} monthly` : undefined}
                />
                <MetricTile label="Daily bandwidth" value={formatBytes(db.totalDailyBandwidth)} />
                <MetricTile label="Connections" value={formatNumber(db.totalConnections)} />
                <MetricTile label="Created" value={formatRelative(new Date(db.createdAt * 1000))} />
              </div>

              <div className="mt-3 text-xs text-muted-foreground font-mono">
                {db.endpoint}:{db.port}
              </div>
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}
