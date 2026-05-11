import { formatNumber, formatRelative } from '@scani/shared';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import Link from 'next/link';
import { ActionDialog } from '@/components/ActionDialog';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getDlqOverview } from '@/lib/clients/bullmq';
import { writesEnabled } from '@/lib/writes';

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
  const writes = writesEnabled();

  return (
    <>
      <PageHeader
        title="Dead-letter queue"
        description={
          <>
            Jobs that exhausted their retry attempts on{' '}
            <code className="font-mono text-xs">scani-jobs</code> and got pushed to{' '}
            <code className="font-mono text-xs">{queue}</code>. Replay re-enqueues the job back on{' '}
            <code className="font-mono text-xs">scani-jobs</code> via an HMAC-signed backend call.
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
                  <TableHead className="text-right">Action</TableHead>
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
                    <TableCell className="text-right">
                      <ActionDialog
                        endpoint="/api/admin/dlq/replay"
                        payload={{ jobId: job.id }}
                        label="Replay"
                        title={`Replay ${job.id}?`}
                        description={
                          <>
                            Re-enqueues job <span className="font-mono">{job.name}</span> back on{' '}
                            <span className="font-mono">scani-jobs</span> with attempt count reset.
                            The DLQ entry stays for audit; if it succeeds again you'll have a fresh
                            successful run.
                          </>
                        }
                        confirmLabel="Replay job"
                        enabled={writes}
                      />
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
