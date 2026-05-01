import { Button } from '@scani/ui/ui/button';
import { LoadingSpinner } from '@scani/ui/ui/loading';
import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { ExchangeImportResult } from '../components/jobs/ExchangeImportResult';
import { FileImportResult } from '../components/jobs/FileImportResult';
import { GenericJobResult } from '../components/jobs/GenericJobResult';
import { JobHeader } from '../components/jobs/JobHeader';
import { ManualHoldingsCreateResult } from '../components/jobs/ManualHoldingsCreateResult';
import { ScreenshotParseResult } from '../components/jobs/ScreenshotParseResult';
import { WalletImportResult } from '../components/jobs/WalletImportResult';
import { useJobStatus } from '../hooks/useJobStatus';
import { V2_ROUTES } from '../lib/routes';

export function JobDetailPage() {
  const { jobId = '' } = useParams<{ jobId: string }>();
  // DB mirror is authoritative for history + shape.
  const jobQuery = trpc.jobs.getMine.useQuery({ jobId }, { enabled: Boolean(jobId) });
  // Live WS progress for the inline progress bar.
  const live = useJobStatus(jobId || null);

  if (!jobId) return null;
  if (jobQuery.isLoading) return <LoadingSpinner />;
  if (jobQuery.error || !jobQuery.data) {
    return (
      <div className="max-w-4xl mx-auto w-full p-4 space-y-3">
        <BackLink />
        <p className="text-sm text-destructive">Job not found.</p>
      </div>
    );
  }

  const job = jobQuery.data;
  // State merge policy: the DB row is authoritative for TERMINAL states
  // (completed/failed). Once a run finishes, stray late WS events (stale
  // buffered pub/sub messages, BullMQ retries on follow-up enqueues) must
  // not flip the UI backwards from "completed" to "active" — which is
  // exactly what a naive `live.state takes precedence` merge caused.
  const isTerminal = job.state === 'completed' || job.state === 'failed';
  const state = isTerminal ? job.state : live.state !== 'unknown' ? live.state : job.state;
  const result = job.result ?? live.result;

  // Outcome-aware chip: BullMQ says "completed" when the worker returned
  // without throwing, even if every per-file/per-row outcome inside the
  // result was a failure (screenshot-parse with 0 holdings extracted,
  // manual-holdings-create where every price fetch errored, …). A green
  // "Completed" chip on top of a red failure body is the awkwardness
  // users complained about; the chip below reflects what actually
  // happened from the user's perspective. JobBody still uses the
  // framework state because it needs to render the result component as
  // soon as the worker finishes (regardless of outcome).
  const chipState = deriveOutcomeState(job.jobName, state, result);

  return (
    <div className="max-w-4xl mx-auto w-full p-4 space-y-4">
      <BackLink />
      <JobHeader
        job={{
          jobId: job.jobId,
          jobName: job.jobName,
          state: chipState,
          attemptsMade: job.attemptsMade,
          attemptsAllowed: job.attemptsAllowed,
          payloadSummary: job.payloadSummary,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          error: job.error,
          statusMessage: live.statusMessage,
        }}
      />
      <JobBody
        jobName={job.jobName}
        state={state}
        result={result}
        jobId={job.jobId}
        actionTakenAt={job.actionTakenAt}
      />
    </div>
  );
}

// Map `(jobName, frameworkState, result)` to an outcome-aware state for
// the JobHeader chip. Framework state is left untouched for non-terminal
// runs and for jobs whose result we can't introspect.
function deriveOutcomeState(jobName: string, state: string, result: unknown): string {
  if (state !== 'completed') return state;
  if (!result || typeof result !== 'object') return state;
  const r = result as Record<string, unknown>;

  if (jobName === 'screenshot-parse' || jobName === 'file-import') {
    const summary = (r.summary ?? {}) as Record<string, unknown>;
    const successCount = Number(summary.successCount ?? 0);
    const failureCount = Number(summary.failureCount ?? 0);
    if (successCount === 0 && failureCount > 0) return 'failed';
  }

  if (jobName === 'manual-holdings-create') {
    const holdings = Array.isArray(r.holdings) ? r.holdings : [];
    if (
      holdings.length > 0 &&
      holdings.every((h) => Boolean((h as Record<string, unknown>).error))
    ) {
      return 'failed';
    }
  }

  return state;
}

function BackLink() {
  return (
    <Button variant="ghost" size="sm" asChild className="h-7 gap-1 -ml-2">
      <Link to={V2_ROUTES.jobs}>
        <ArrowLeft className="h-3.5 w-3.5" />
        All jobs
      </Link>
    </Button>
  );
}

function JobBody({
  jobName,
  state,
  result,
  jobId,
  actionTakenAt,
}: {
  jobName: string;
  state: string;
  result: unknown;
  jobId: string;
  actionTakenAt: Date | string | null;
}) {
  if (state !== 'completed') {
    return null;
  }
  switch (jobName) {
    case 'wallet-import':
      return <WalletImportResult result={result} jobId={jobId} actionTakenAt={actionTakenAt} />;
    case 'exchange-import':
      return <ExchangeImportResult result={result} />;
    case 'screenshot-parse':
      return <ScreenshotParseResult result={result} jobId={jobId} actionTakenAt={actionTakenAt} />;
    case 'file-import':
      return <FileImportResult result={result} jobId={jobId} />;
    case 'manual-holdings-create':
      return <ManualHoldingsCreateResult result={result} />;
    default:
      // Fallback covers `holding-price-update`, `user-data-delete` and
      // any future job type — structured summary, not raw JSON.
      return <GenericJobResult result={result} />;
  }
}
