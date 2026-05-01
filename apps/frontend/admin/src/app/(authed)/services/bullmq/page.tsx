import { formatNumber, formatRelative } from '@scani/shared';
import Link from 'next/link';
import { ErrorPanel } from '@/components/ErrorPanel';
import { MetricTile } from '@/components/MetricTile';
import { Section } from '@/components/Section';
import { getQueueOverview } from '@/lib/clients/bullmq';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const STATE_ORDER: Array<{
  key: 'waiting' | 'active' | 'delayed' | 'failed' | 'completed';
  label: string;
}> = [
  { key: 'waiting', label: 'Waiting' },
  { key: 'active', label: 'Active' },
  { key: 'delayed', label: 'Delayed' },
  { key: 'failed', label: 'Failed' },
  { key: 'completed', label: 'Completed' },
];

export default async function BullMQDashboardPage() {
  const overview = await getQueueOverview();
  if (!overview.ok) return <ErrorPanel service="BullMQ" error={overview.error} />;
  const { counts, byName, recentFailures } = overview.data;

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">BullMQ · scani-jobs</h1>
      <p className="text-xs text-neutral-400 mb-6">
        Background job queue · Redis-backed (Upstash) · one worker process, concurrency 4
      </p>

      <Section title="Queue state">
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
          {STATE_ORDER.map((s) => (
            <Link key={s.key} href={`/services/bullmq/${s.key}`} className="block">
              <MetricTile label={s.label} value={formatNumber(counts[s.key])} />
            </Link>
          ))}
        </div>
      </Section>

      <Section title="By job name">
        {byName.length === 0 ? (
          <p className="text-sm text-neutral-500">No jobs observed in recent samples.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-neutral-500">
              <tr>
                <th className="text-left pb-2">Job name</th>
                <th className="text-right pb-2">Recent count</th>
              </tr>
            </thead>
            <tbody>
              {byName.map((row) => (
                <tr key={row.name} className="border-t border-neutral-900">
                  <td className="py-2 font-mono text-xs">{row.name}</td>
                  <td className="py-2 text-right">{formatNumber(row.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Recent failures">
        {recentFailures.length === 0 ? (
          <p className="text-sm text-neutral-500">No failed jobs. 🎉</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs text-neutral-500">
              <tr>
                <th className="text-left pb-2">Job ID</th>
                <th className="text-left pb-2">Name</th>
                <th className="text-left pb-2">Attempts</th>
                <th className="text-left pb-2">Failed</th>
                <th className="text-left pb-2">Reason</th>
              </tr>
            </thead>
            <tbody>
              {recentFailures.map((job) => (
                <tr key={job.id} className="border-t border-neutral-900">
                  <td className="py-2">
                    <Link
                      href={`/services/bullmq/job/${encodeURIComponent(job.id)}`}
                      className="font-mono text-xs text-emerald-400 hover:underline"
                    >
                      {job.id}
                    </Link>
                  </td>
                  <td className="py-2 font-mono text-xs">{job.name}</td>
                  <td className="py-2">{job.attemptsMade}</td>
                  <td className="py-2 text-xs text-neutral-400">
                    {job.finishedOn ? formatRelative(new Date(job.finishedOn)) : '—'}
                  </td>
                  <td className="py-2 text-xs truncate max-w-md text-red-400">
                    {job.failedReason ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>
    </div>
  );
}
