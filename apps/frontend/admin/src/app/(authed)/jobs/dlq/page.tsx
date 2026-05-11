import { formatNumber, formatRelative } from '@scani/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import Link from 'next/link';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getDlqOverview } from '@/lib/clients/bullmq';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

export default async function DlqPage() {
  const fetchedAt = new Date().toISOString();
  const overview = await getDlqOverview();
  if (!overview.ok) {
    return (
      <>
        <PageHeader title="Dead-letter queue" fetchedAt={fetchedAt} />
        <ErrorPanel service="BullMQ DLQ" error={overview.error} />
      </>
    );
  }
  const { queue, depth, recent } = overview.data;

  return (
    <>
      <PageHeader
        title="Dead-letter queue"
        description={
          <>
            Jobs that exhausted their retry attempts on{' '}
            <code className="font-mono text-xs">scani-jobs</code> and got pushed to{' '}
            <code className="font-mono text-xs">{queue}</code>. Replay action lives behind an
            HMAC-signed proxy and ships in Phase 4.
          </>
        }
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Depth" value={formatNumber(depth)} />
        <StatCard label="Queue" value={<span className="font-mono text-sm">{queue}</span>} />
        <StatCard label="Sampled here" value={`${recent.length}`} />
      </div>

      <SectionCard
        title="Recent DLQ entries"
        description="Most recent 25 failures. Click an ID to see the full job detail."
        className="mt-6"
        flushBody
      >
        {recent.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job ID</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Finished</TableHead>
                  <TableHead>Reason</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((job) => (
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
        ) : (
          <div className="p-4 text-xs text-muted-foreground">DLQ is empty. Nothing to replay.</div>
        )}
      </SectionCard>
    </>
  );
}
