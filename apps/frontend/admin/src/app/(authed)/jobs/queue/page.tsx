import { formatNumber, formatRelative } from '@scani/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import Link from 'next/link';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
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

export default async function QueuePage() {
  const fetchedAt = new Date().toISOString();
  const overview = await getQueueOverview();
  if (!overview.ok) {
    return (
      <>
        <PageHeader title="BullMQ · scani-jobs" fetchedAt={fetchedAt} />
        <ErrorPanel service="BullMQ" error={overview.error} />
      </>
    );
  }
  const { counts, byName, recentFailures } = overview.data;

  return (
    <>
      <PageHeader
        title="BullMQ · scani-jobs"
        description="Background job queue · Redis-backed (Upstash) · one worker process, concurrency 4."
        fetchedAt={fetchedAt}
      />

      <SectionCard title="Queue state">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {STATE_ORDER.map((s) => (
            <Link key={s.key} href={`/jobs/queue/${s.key}`} className="block">
              <StatCard
                label={s.label}
                value={formatNumber(counts[s.key])}
                className="transition-colors hover:border-primary/40"
              />
            </Link>
          ))}
        </div>
      </SectionCard>

      <SectionCard title="By job name" className="mt-6" flushBody>
        {byName.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No jobs observed in recent samples.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job name</TableHead>
                <TableHead className="text-right">Recent count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byName.map((row) => (
                <TableRow key={row.name}>
                  <TableCell className="font-mono">{row.name}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(row.count)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <SectionCard title="Recent failures" className="mt-6" flushBody>
        {recentFailures.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No failed jobs.</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job ID</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Failed</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentFailures.map((job) => (
                  <TableRow key={job.id}>
                    <TableCell>
                      <Link
                        href={`/jobs/queue/job/${encodeURIComponent(job.id)}`}
                        className="font-mono text-xs text-primary hover:underline"
                      >
                        {job.id}
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">{job.name}</TableCell>
                    <TableCell>{job.attemptsMade}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {job.finishedOn ? formatRelative(new Date(job.finishedOn)) : '—'}
                    </TableCell>
                    <TableCell className="max-w-md truncate text-xs text-destructive">
                      {job.failedReason ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>
    </>
  );
}
