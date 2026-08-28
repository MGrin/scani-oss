import { cn } from '@scani/ui/lib/cn';
import { MIRROR_IN_RTL } from '@scani/ui/lib/direction';
import { Button } from '@scani/ui/ui/button';
import { Skeleton } from '@scani/ui/ui/skeleton';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { ArrowLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { useJobStatus } from '@/v3/hooks/useJobStatus';
import { JobDetailHeader } from '../components/jobs/JobDetailHeader';
import { resolveV3ReviewRenderer } from '../lib/job-result';
import { deriveJobOutcomeState } from '../lib/jobs';
import { V3_ROUTES } from '../lib/routes';

/**
 * One job, and whatever its result turns out to be.
 *
 * The body is the reason this is a page and not a peek: `resolveReviewRenderer`
 * picks a per-job-name component that can be a table of extracted holdings with
 * a confirm step on it. That does not fit in a sheet resting at half a phone,
 * and the confirm inside it is the thing the whole review feed exists to reach.
 *
 * The registry and `useJobStatus` are imported from v2 unchanged — the review
 * renderers are the *result* contract with the worker, not presentation v3 gets
 * to restyle unilaterally, and re-implementing them here would fork it. The one
 * exception goes through `resolveV3ReviewRenderer`, which overrides
 * `document-parse` alone; see that module for why that job kind's onward path
 * differs between the generations rather than merely its styling.
 *
 * The state merge is v2's and load-bearing: the DB row wins for terminal states.
 * Live WS events keep arriving after a run finishes (buffered pub/sub, BullMQ
 * retries on a follow-up enqueue), and a naive "live wins" merge flips a
 * finished job back to "active" on screen.
 */
export function JobDetailPage() {
  const { t } = useTranslation();
  const { jobId = '' } = useParams<{ jobId: string }>();
  const jobQuery = trpc.jobs.getMine.useQuery({ jobId }, { enabled: Boolean(jobId) });
  const live = useJobStatus(jobId || null);

  if (jobQuery.isLoading) {
    return (
      <PageLayout measure="wide">
        <BackLink />
        <Skeleton className="h-32 w-full" aria-hidden="true" />
      </PageLayout>
    );
  }

  if (jobQuery.error || !jobQuery.data) {
    return (
      <PageLayout measure="wide">
        <BackLink />
        <p className="text-body text-muted-foreground">{t('v3.jobs.detail.notFound')}</p>
      </PageLayout>
    );
  }

  const job = jobQuery.data;
  const isTerminal = job.state === 'completed' || job.state === 'failed';
  const state = isTerminal ? job.state : live.state !== 'unknown' ? live.state : job.state;
  const result = job.result ?? live.result;

  return (
    <PageLayout measure="wide">
      <BackLink />
      <JobDetailHeader
        job={{
          jobId: job.jobId,
          jobName: job.jobName,
          state: deriveJobOutcomeState(job.jobName, state, result),
          frameworkState: state,
          attemptsMade: job.attemptsMade,
          attemptsAllowed: job.attemptsAllowed,
          payloadSummary: job.payloadSummary,
          createdAt: job.createdAt,
          startedAt: job.startedAt,
          finishedAt: job.finishedAt,
          actionTakenAt: job.actionTakenAt,
          userFacingError: job.userFacingError,
          deadAt: job.deadAt,
          failureReason: job.failureReason,
          retry: job.retry,
          statusMessage: live.statusMessage,
        }}
      />
      {state === 'completed'
        ? resolveV3ReviewRenderer(job.jobName).render({
            result,
            jobId: job.jobId,
            actionTakenAt: job.actionTakenAt,
            reviewOutcome: job.reviewOutcome,
          })
        : null}
    </PageLayout>
  );
}

function BackLink() {
  const { t } = useTranslation();
  return (
    <Button variant="ghost" size="sm" asChild className="-ms-2 self-start">
      <Link to={V3_ROUTES.jobs}>
        <ArrowLeft className={cn(MIRROR_IN_RTL, 'me-2 size-4')} aria-hidden="true" />
        {t('v3.jobs.detail.backToJobs')}
      </Link>
    </Button>
  );
}
