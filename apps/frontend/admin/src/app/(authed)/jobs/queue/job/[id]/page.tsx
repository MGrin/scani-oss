import { formatRelative } from '@scani/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ErrorPanel } from '@/components/ErrorPanel';
import { PageHeader } from '@/components/PageHeader';
import { SectionCard } from '@/components/SectionCard';
import { getJobDetail } from '@/lib/clients/bullmq';
import { JobActions } from './JobActions';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

interface PageProps {
  params: { id: string };
}

export default async function JobDetailPage({ params }: PageProps) {
  const id = decodeURIComponent(params.id);
  const fetchedAt = new Date().toISOString();
  const result = await getJobDetail(id);
  if (!result.ok) {
    return (
      <>
        <PageHeader title={`Queue / ${id}`} fetchedAt={fetchedAt} />
        <ErrorPanel service="BullMQ job" error={result.error} />
      </>
    );
  }
  if (!result.data) return notFound();
  const job = result.data;

  return (
    <>
      <PageHeader
        title={
          <>
            <Link href="/jobs/queue" className="text-muted-foreground hover:text-foreground">
              Queue
            </Link>{' '}
            <span className="text-muted-foreground/70">/</span>{' '}
            <span className="font-mono text-base">{job.id}</span>
          </>
        }
        description={
          <>
            {job.name} · {job.state} · attempt {job.attemptsMade} of{' '}
            {String((job.opts as { attempts?: number } | null)?.attempts ?? 1)}
          </>
        }
        fetchedAt={fetchedAt}
      />

      <SectionCard title="Actions">
        <JobActions jobId={job.id} state={job.state} />
      </SectionCard>

      <SectionCard title="Timeline" className="mt-6">
        <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
          <DlRow
            label="Enqueued"
            value={job.timestamp ? formatRelative(new Date(job.timestamp)) : '—'}
          />
          <DlRow
            label="Started"
            value={job.processedOn ? formatRelative(new Date(job.processedOn)) : '—'}
          />
          <DlRow
            label="Finished"
            value={job.finishedOn ? formatRelative(new Date(job.finishedOn)) : '—'}
          />
          <DlRow
            label="Progress"
            value={job.progress !== null ? `${Math.round(job.progress * 100)}%` : '—'}
          />
        </dl>
      </SectionCard>

      {job.failedReason ? (
        <SectionCard title="Failure" className="mt-6">
          <pre className="rounded-md border border-destructive/60 bg-destructive/10 p-3 text-xs text-destructive-foreground whitespace-pre-wrap">
            {job.failedReason}
          </pre>
          {job.stacktrace ? (
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                Stack traces ({job.stacktrace.length} attempt
                {job.stacktrace.length === 1 ? '' : 's'})
              </summary>
              <pre className="mt-2 whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">
                {job.stacktrace.join('\n---\n')}
              </pre>
            </details>
          ) : null}
        </SectionCard>
      ) : null}

      <SectionCard title="Payload" className="mt-6">
        <pre className="whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs text-foreground/80">
          {JSON.stringify(job.data, null, 2)}
        </pre>
        <p className="mt-2 text-xs text-muted-foreground">
          Sensitive-looking keys (apiKey, password, token, credentials…) are redacted for display.
        </p>
      </SectionCard>

      {job.returnvalue != null ? (
        <SectionCard title="Result" className="mt-6">
          <pre className="whitespace-pre-wrap rounded-md bg-muted/40 p-3 text-xs text-foreground/80">
            {JSON.stringify(job.returnvalue, null, 2)}
          </pre>
        </SectionCard>
      ) : null}
    </>
  );
}

function DlRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-1">{value}</dd>
    </div>
  );
}
