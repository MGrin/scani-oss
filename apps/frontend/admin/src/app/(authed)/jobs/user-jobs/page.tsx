import { formatNumber, formatRelative } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { StatCard } from '@/components/StatCard';
import { getUserJobsStats, type UserJobState } from '@/lib/clients/db/userJobsStats';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const STATE_TONE: Record<UserJobState, 'default' | 'destructive' | 'outline' | 'secondary'> = {
  queued: 'outline',
  active: 'secondary',
  progress: 'secondary',
  completed: 'default',
  failed: 'destructive',
};

export default async function UserJobsPage() {
  const fetchedAt = new Date().toISOString();
  const stats = await getUserJobsStats();
  if (!stats.ok) {
    return (
      <>
        <PageHeader title="User jobs" fetchedAt={fetchedAt} />
        <ErrorPanel service="User jobs" error={stats.error} />
      </>
    );
  }
  const { total, byState, byName, staleActive, recent } = stats.data;

  return (
    <>
      <PageHeader
        title="User jobs"
        description={
          <>
            <code className="font-mono">user_jobs</code> ledger — Scani's per-user mirror of the
            BullMQ queue. The reconciler sweeps rows stuck in{' '}
            <code className="font-mono">queued</code> or <code className="font-mono">active</code>{' '}
            past 15 minutes.
          </>
        }
        fetchedAt={fetchedAt}
      />

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard label="Total" value={formatNumber(total)} />
        <StatCard label="Queued" value={formatNumber(byState.queued)} />
        <StatCard label="Active" value={formatNumber(byState.active + byState.progress)} />
        <StatCard label="Completed" value={formatNumber(byState.completed)} />
        <StatCard label="Failed" value={formatNumber(byState.failed)} />
        <StatCard label="Stale (>15m)" value={formatNumber(staleActive.length)} />
      </div>

      <SectionCard
        title="By job name (last 7 days)"
        description="Top job-name buckets by total count."
        className="mt-6"
        flushBody
      >
        {byName.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Job name</TableHead>
                <TableHead className="text-right">Count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {byName.map((r) => (
                <TableRow key={r.name}>
                  <TableCell className="font-mono">{r.name}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(r.count)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">
            No user_jobs activity in the last 7 days.
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Stale active jobs"
        description="In queued / active / progress state but older than 15 minutes since start."
        className="mt-6"
        flushBody
      >
        {staleActive.length > 0 ? (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Job ID</TableHead>
                  <TableHead>Name</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Attempts</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {staleActive.map((j) => (
                  <TableRow key={j.jobId}>
                    <TableCell className="font-mono text-xs">{j.jobId}</TableCell>
                    <TableCell className="font-mono text-xs">{j.jobName}</TableCell>
                    <TableCell>
                      <Badge variant={STATE_TONE[j.state]}>{j.state}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(j.createdAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {j.startedAt ? formatRelative(j.startedAt) : '—'}
                    </TableCell>
                    <TableCell>{j.attemptsMade}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">
            No stuck jobs — reconciler is keeping up.
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="Recent jobs"
        description="Most recent 25 entries regardless of state."
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
                  <TableHead>State</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Finished</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recent.map((j) => (
                  <TableRow key={j.jobId}>
                    <TableCell className="font-mono text-xs">{j.jobId}</TableCell>
                    <TableCell className="font-mono text-xs">{j.jobName}</TableCell>
                    <TableCell>
                      <Badge variant={STATE_TONE[j.state]}>{j.state}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(j.createdAt)}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {j.finishedAt ? formatRelative(j.finishedAt) : '—'}
                    </TableCell>
                    <TableCell>{j.attemptsMade}</TableCell>
                    <TableCell className="max-w-xs truncate text-xs text-destructive">
                      {j.error ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : (
          <div className="p-4 text-xs text-muted-foreground">No user_jobs yet.</div>
        )}
      </SectionCard>
    </>
  );
}
