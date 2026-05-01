import { formatRelative } from '@scani/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ErrorPanel } from '@/components/ErrorPanel';
import { Section } from '@/components/Section';
import { getJobDetail } from '@/lib/clients/bullmq';
import { JobActions } from './JobActions';

export const runtime = 'edge';
export const dynamic = 'force-dynamic';

interface PageProps {
  params: { id: string };
}

export default async function JobDetailPage({ params }: PageProps) {
  const id = decodeURIComponent(params.id);
  const result = await getJobDetail(id);
  if (!result.ok) return <ErrorPanel service="BullMQ job" error={result.error} />;
  if (!result.data) return notFound();
  const job = result.data;

  return (
    <div>
      <h1 className="text-xl font-semibold mb-1">
        <Link href="/services/bullmq" className="text-neutral-500 hover:text-neutral-300">
          BullMQ
        </Link>{' '}
        <span className="text-neutral-600">/</span>{' '}
        <span className="font-mono text-sm">{job.id}</span>
      </h1>
      <p className="text-xs text-neutral-400 mb-6">
        {job.name} · {job.state} · attempt {job.attemptsMade} of{' '}
        {String((job.opts as { attempts?: number } | null)?.attempts ?? 1)}
      </p>

      <Section title="Actions">
        <JobActions jobId={job.id} state={job.state} />
      </Section>

      <Section title="Timeline">
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
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
      </Section>

      {job.failedReason ? (
        <Section title="Failure">
          <pre className="rounded-md bg-red-950/30 border border-red-900 p-3 text-xs text-red-300 whitespace-pre-wrap">
            {job.failedReason}
          </pre>
          {job.stacktrace ? (
            <details className="mt-3 text-xs">
              <summary className="cursor-pointer text-neutral-500 hover:text-neutral-300">
                Stack traces ({job.stacktrace.length} attempt
                {job.stacktrace.length === 1 ? '' : 's'})
              </summary>
              <pre className="mt-2 rounded-md bg-neutral-900 p-3 text-xs text-neutral-400 whitespace-pre-wrap">
                {job.stacktrace.join('\n---\n')}
              </pre>
            </details>
          ) : null}
        </Section>
      ) : null}

      <Section title="Payload">
        <pre className="rounded-md bg-neutral-900 p-3 text-xs text-neutral-300 whitespace-pre-wrap">
          {JSON.stringify(job.data, null, 2)}
        </pre>
        <p className="mt-2 text-xs text-neutral-500">
          Sensitive-looking keys (apiKey, password, token, credentials…) are redacted for display.
        </p>
      </Section>

      {job.returnvalue != null ? (
        <Section title="Result">
          <pre className="rounded-md bg-neutral-900 p-3 text-xs text-neutral-300 whitespace-pre-wrap">
            {JSON.stringify(job.returnvalue, null, 2)}
          </pre>
        </Section>
      ) : null}
    </div>
  );
}

function DlRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-neutral-500">{label}</dt>
      <dd className="mt-1">{value}</dd>
    </div>
  );
}
