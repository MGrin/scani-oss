import { formatNumber, formatRelative } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@scani/ui/ui/table';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { type JobState, listJobs } from '@/lib/clients/bullmq';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

const VALID_STATES = new Set<JobState>(['waiting', 'active', 'delayed', 'failed', 'completed']);
const PAGE_SIZE = 50;

interface PageProps {
  params: { state: string };
  searchParams?: { offset?: string };
}

export default async function JobStateListPage({ params, searchParams }: PageProps) {
  const state = params.state as JobState;
  if (!VALID_STATES.has(state)) return notFound();

  const offset = Math.max(0, Number.parseInt(searchParams?.offset ?? '0', 10) || 0);
  const fetchedAt = new Date().toISOString();
  const result = await listJobs(state, offset, PAGE_SIZE);
  if (!result.ok) {
    return (
      <>
        <PageHeader title={`Queue / ${prettyState(state)}`} fetchedAt={fetchedAt} />
        <ErrorPanel service={`BullMQ ${state}`} error={result.error} />
      </>
    );
  }
  const { total, items } = result.data;
  const nextOffset = offset + PAGE_SIZE;
  const prevOffset = Math.max(0, offset - PAGE_SIZE);

  return (
    <>
      <PageHeader
        title={
          <>
            <Link href="/jobs/queue" className="text-muted-foreground hover:text-foreground">
              Queue
            </Link>{' '}
            <span className="text-muted-foreground/70">/</span> {prettyState(state)}
          </>
        }
        description={
          <>
            {formatNumber(total)} job{total === 1 ? '' : 's'} · showing {offset + 1}–
            {Math.min(offset + PAGE_SIZE, total)}
          </>
        }
        fetchedAt={fetchedAt}
      />

      <SectionCard title="Jobs" flushBody>
        {items.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No jobs in this state.</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Job ID</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Attempts</TableHead>
                    <TableHead>
                      {state === 'waiting' || state === 'delayed' ? 'Enqueued' : 'Finished'}
                    </TableHead>
                    <TableHead>Reason</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((job) => (
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
                        {(() => {
                          const ts =
                            state === 'waiting' || state === 'delayed'
                              ? job.timestamp
                              : job.finishedOn;
                          return ts ? formatRelative(new Date(ts)) : '—';
                        })()}
                      </TableCell>
                      <TableCell className="max-w-md truncate text-xs text-destructive">
                        {job.failedReason ?? '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="flex items-center justify-between border-t border-border/60 p-3">
              {offset > 0 ? (
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/jobs/queue/${state}?offset=${prevOffset}`}>← Previous</Link>
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground/50">← Previous</span>
              )}
              {nextOffset < total ? (
                <Button asChild variant="ghost" size="sm">
                  <Link href={`/jobs/queue/${state}?offset=${nextOffset}`}>Next →</Link>
                </Button>
              ) : (
                <span className="text-xs text-muted-foreground/50">Next →</span>
              )}
            </div>
          </>
        )}
      </SectionCard>
    </>
  );
}

function prettyState(state: JobState): string {
  return state[0]?.toUpperCase() + state.slice(1);
}
