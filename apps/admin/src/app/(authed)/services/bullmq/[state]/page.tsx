import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ErrorPanel } from '@/components/ErrorPanel';
import { Section } from '@/components/Section';
import { type JobState, listJobs } from '@/lib/clients/bullmq';
import { formatNumber, formatRelative } from '@/lib/format';

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
  const result = await listJobs(state, offset, PAGE_SIZE);
  if (!result.ok) return <ErrorPanel service={`BullMQ ${state}`} error={result.error} />;
  const { total, items } = result.data;

  const nextOffset = offset + PAGE_SIZE;
  const prevOffset = Math.max(0, offset - PAGE_SIZE);

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">
        <Link href="/services/bullmq" className="text-neutral-500 hover:text-neutral-300">
          BullMQ
        </Link>{' '}
        <span className="text-neutral-600">/</span> {prettyState(state)}
      </h1>
      <p className="text-xs text-neutral-400 mb-6">
        {formatNumber(total)} job{total === 1 ? '' : 's'} in this state · showing {offset + 1}–
        {Math.min(offset + PAGE_SIZE, total)}
      </p>

      <Section title="Jobs">
        {items.length === 0 ? (
          <p className="text-sm text-neutral-500">No jobs in this state.</p>
        ) : (
          <>
            <table className="w-full text-sm">
              <thead className="text-xs text-neutral-500">
                <tr>
                  <th className="text-left pb-2">Job ID</th>
                  <th className="text-left pb-2">Name</th>
                  <th className="text-left pb-2">Attempts</th>
                  <th className="text-left pb-2">
                    {state === 'waiting' || state === 'delayed' ? 'Enqueued' : 'Finished'}
                  </th>
                  <th className="text-left pb-2 max-w-md">Reason</th>
                </tr>
              </thead>
              <tbody>
                {items.map((job) => (
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
                      {(() => {
                        const ts =
                          state === 'waiting' || state === 'delayed'
                            ? job.timestamp
                            : job.finishedOn;
                        return ts ? formatRelative(new Date(ts)) : '—';
                      })()}
                    </td>
                    <td className="py-2 text-xs truncate max-w-md text-red-400">
                      {job.failedReason ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="mt-4 flex items-center justify-between text-xs">
              {offset > 0 ? (
                <Link
                  href={`/services/bullmq/${state}?offset=${prevOffset}`}
                  className="text-emerald-400 hover:underline"
                >
                  ← previous
                </Link>
              ) : (
                <span className="text-neutral-700">← previous</span>
              )}
              {nextOffset < total ? (
                <Link
                  href={`/services/bullmq/${state}?offset=${nextOffset}`}
                  className="text-emerald-400 hover:underline"
                >
                  next →
                </Link>
              ) : (
                <span className="text-neutral-700">next →</span>
              )}
            </div>
          </>
        )}
      </Section>
    </div>
  );
}

function prettyState(state: JobState): string {
  return state[0]?.toUpperCase() + state.slice(1);
}
