import { describeJobFailure, isJobAwaitingFailureDecision } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { Check, RotateCcw, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { jobLabelFor } from '../../lib/job-labels';
import {
  isJobRunning,
  jobFailureSentence,
  jobNeedsAction,
  summariseJobPayload,
} from '../../lib/jobs';
import { formatRelative } from '../../lib/relative-time';
import { V3_ROUTES } from '../../lib/routes';
import { JobStateBadge } from './JobStateBadge';

/**
 * What a job *is*, plus the three things you can do to it — the top of
 * `/v3/jobs/:jobId`, above whatever result renderer the job's own name selects.
 *
 * The actions are state-gated rather than always present, because two of the
 * three are destructive-ish and none applies to a run in the state the others
 * are for: a running job can be cancelled, a failed one retried or removed, a
 * completed one neither. v2 puts retry and remove on every *list row* as well,
 * which is where a mis-tap costs the most; here they live on the record.
 */

export interface JobDetailHeaderJob {
  jobId: string;
  jobName: string;
  /** Already outcome-derived — see `deriveJobOutcomeState`. */
  state: string;
  /** The framework state, for the running/failed action gates. */
  frameworkState: string;
  attemptsMade: number;
  attemptsAllowed: number;
  payloadSummary: unknown;
  createdAt: string | Date;
  startedAt: string | Date | null;
  finishedAt: string | Date | null;
  actionTakenAt: string | Date | null;
  userFacingError: string | null;
  /** Set once the queue has given up (SC-153). */
  deadAt?: string | Date | null;
  failureReason?: string | null;
  /** Whether re-running is actually possible, answered by the server against
   *  Redis rather than assumed from the state. Retry needs the original
   *  payload and only the BullMQ entry has it, so for an evicted job the
   *  button cannot work — and a button that cannot work is the defect this
   *  ticket is about wearing a different hat. */
  retry?: { available: boolean; reason?: string; queueHasJob?: boolean };
  /** Latest worker-emitted phase message — long polls (an IBKR Flex query
   *  generating a report) say what they are waiting on. */
  statusMessage?: string | null;
}

/** Why Retry is not on offer — the server decided this, the page only says it.
 *  Each one ends with what to do instead, because "you cannot retry" alone
 *  leaves someone on a page with a dead import and no next move. */
const RETRY_UNAVAILABLE_KEYS: Record<string, string> = {
  cancelled: 'v3.jobs.retryUnavailable.cancelled',
  never_delivered: 'v3.jobs.retryUnavailable.neverDelivered',
  still_retrying: 'v3.jobs.retryUnavailable.stillRetrying',
  evicted: 'v3.jobs.retryUnavailable.evicted',
  not_failed: 'v3.jobs.retryUnavailable.notFailed',
};

/** Reasons whose own failure sentence already tells the reader what to do.
 *  Repeating "start it again from where you began it" twice in one card is
 *  noise, and noise is what taught people to skim this block. */
const SENTENCE_SAYS_IT = new Set(['never_delivered', 'cancelled']);

export function JobDetailHeader({ job }: { job: JobDetailHeaderJob }) {
  const { t } = useTranslation();
  const { label, icon: Icon } = jobLabelFor(t, job.jobName);
  const identity = { jobId: job.jobId, jobName: job.jobName, createdAt: job.createdAt };
  const running = isJobRunning({ ...identity, state: job.frameworkState });
  const failed = job.frameworkState === 'failed';
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const needsReview = jobNeedsAction({
    ...identity,
    state: job.frameworkState,
    actionTakenAt: job.actionTakenAt,
  });

  const settle = () => {
    void utils.jobs.getMine.invalidate({ jobId: job.jobId });
    void utils.jobs.listMine.invalidate();
    void utils.review.listPending.invalidate();
  };

  const retry = trpc.jobs.retry.useMutation({
    onSuccess: () => showSuccess(t('v3.jobs.toast.requeued')),
    onError: (error) => showError(error, t('v3.jobs.toast.retrying')),
    onSettled: settle,
  });

  const cancel = trpc.jobs.cancel.useMutation({
    onSuccess: () => showSuccess(t('v3.jobs.toast.cancelled')),
    onError: (error) => showError(error, t('v3.jobs.toast.cancelling')),
    onSettled: settle,
  });

  const discard = trpc.jobs.markActionTaken.useMutation({
    onSuccess: () => showSuccess(t('v3.jobs.toast.discarded')),
    onError: (error) => showError(error, t('v3.jobs.toast.discarding')),
    onSettled: settle,
  });

  // Same mutation as `discard`, different sentence: "nothing was imported" is
  // true of a discarded parse and beside the point for a failure the user is
  // acknowledging. react-query fixes the callback at hook creation, so the two
  // meanings need two hooks rather than one with a conditional toast.
  const dismissFailure = trpc.jobs.markActionTaken.useMutation({
    onSuccess: () => showSuccess(t('v3.jobs.toast.dismissed')),
    onError: (error) => showError(error, t('v3.jobs.toast.dismissing')),
    onSettled: settle,
  });

  const remove = trpc.jobs.remove.useMutation({
    onSuccess: () => {
      showSuccess(t('v3.jobs.detail.removed'));
      navigate(V3_ROUTES.jobs, { replace: true });
    },
    onError: (error) => showError(error, t('v3.jobs.toast.removing')),
    onSettled: settle,
  });

  const detail = summariseJobPayload(t, job.jobName, job.payloadSummary);
  // One description, shared with the chip and with the list, so this page and
  // the row that led here cannot disagree about what happened.
  const failure = describeJobFailure({
    ...job,
    state: job.frameworkState,
    queueHasJob: job.retry?.queueHasJob,
  });
  const retryable = job.retry?.available ?? false;
  const retryReason = job.retry?.reason ?? 'evicted';
  const awaitingDecision = isJobAwaitingFailureDecision({
    ...job,
    state: job.frameworkState,
  });

  return (
    <Block className="flex flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            <h1 className="truncate text-title">{label}</h1>
            {detail ? (
              <p className="truncate text-caption text-muted-foreground">{detail}</p>
            ) : null}
          </div>
        </div>
        <span className="shrink-0">
          <JobStateBadge
            state={job.state}
            needsAction={jobNeedsAction({
              ...identity,
              state: job.state,
              actionTakenAt: job.actionTakenAt,
            })}
            failure={{ ...job, state: job.frameworkState, queueHasJob: job.retry?.queueHasJob }}
          />
        </span>
      </div>

      {running ? (
        <div className="flex flex-col gap-2">
          {job.statusMessage ? (
            <p className="text-caption text-muted-foreground">{job.statusMessage}</p>
          ) : null}
          {/* Indeterminate: the worker pipeline emits phases, not percentages,
              so a determinate bar would have to invent a number. */}
          <div
            role="progressbar"
            aria-label={t('v3.jobs.running', { label })}
            className="relative h-1 w-full overflow-hidden rounded-full bg-surface-hover"
          >
            <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary motion-safe:animate-loading-bar" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-caption text-muted-foreground">
              {t('v3.jobs.detail.attempt', {
                attempt: job.attemptsMade || 1,
                allowed: job.attemptsAllowed,
              })}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({ jobId: job.jobId })}
            >
              <X className="mr-2 size-4" aria-hidden="true" />
              {cancel.isPending ? t('v3.jobs.detail.cancelPending') : t('v3.jobs.detail.cancel')}
            </Button>
          </div>
        </div>
      ) : null}

      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-caption text-muted-foreground">
        <span>{t('v3.jobs.detail.createdAt', { when: formatRelative(t, job.createdAt) })}</span>
        {job.startedAt ? (
          <span>{t('v3.jobs.detail.startedAt', { when: formatRelative(t, job.startedAt) })}</span>
        ) : null}
        {job.finishedAt ? (
          <span>{t('v3.jobs.detail.finishedAt', { when: formatRelative(t, job.finishedAt) })}</span>
        ) : null}
      </dl>

      {/* The state that used to offer nothing. `running` gets Cancel and
          `failed` gets Retry/Remove, but a completed job still waiting on a
          review had no action at all — so a parse the user did not want
          could only be cleared by importing it (SC-138). Discard is that
          missing exit: it stamps the review as handled, writes no holdings,
          and leaves the run itself intact for Remove to delete. */}
      {needsReview ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-caption text-muted-foreground">{t('v3.jobs.awaitingYou')}</p>
          <ConfirmAction
            label={t('v3.jobs.discard.trigger')}
            confirmLabel={t('v3.jobs.discard.commit')}
            destructive
            open={confirmingDiscard}
            onOpenChange={setConfirmingDiscard}
            isPending={discard.isPending}
            consequence={t('v3.jobs.discard.consequence', { label: label.toLowerCase() })}
            onConfirm={() => discard.mutate({ jobId: job.jobId, outcome: 'discarded' })}
          />
        </div>
      ) : null}

      {failed ? (
        <div className="flex flex-col gap-2">
          {/* The sentence, before the stack trace. What someone opening this
              page needs first is whether anything is still going to happen,
              and the error text answers a different question — one they
              usually cannot act on. */}
          {failure ? <p className="text-body">{jobFailureSentence(t, failure)}</p> : null}
          {job.userFacingError ? (
            // Only ever a sentence a processor marked `userFacing(...)` — the
            // provider's own rejection, or copy written for whoever started
            // this job (SC-551). It used to be `job.error`, the raw throw, and
            // the comment here claimed it was "a stack trace or an upstream
            // API's message" worth pasting into an issue. It was also a
            // `DrizzleQueryError`'s full `select … from "holdings"`, rendered
            // to the person whose job it was.
            //
            // `whitespace-pre-wrap` and the mono face stay: an upstream
            // rejection code is still something people copy verbatim.
            <p className="whitespace-pre-wrap rounded-md border border-border-strong bg-surface-hover p-2 font-mono text-caption">
              {job.userFacingError}
            </p>
          ) : null}
          {/* Not merely disabled: a greyed-out Retry still reads as "this is
              the way back", and for an evicted job it is not — starting the
              import again is. Saying so is the whole affordance. */}
          {retryable || SENTENCE_SAYS_IT.has(retryReason) ? null : (
            <p className="text-caption text-muted-foreground">
              {t(RETRY_UNAVAILABLE_KEYS[retryReason] ?? 'v3.jobs.retryUnavailable.notFailed')}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            {retryable ? (
              <Button
                variant="outline"
                size="sm"
                disabled={retry.isPending}
                onClick={() => retry.mutate({ jobId: job.jobId })}
              >
                <RotateCcw className="mr-2 size-4" aria-hidden="true" />
                {retry.isPending ? t('v3.jobs.detail.retryPending') : t('v3.jobs.detail.retry')}
              </Button>
            ) : null}
            {/* The non-destructive way out of the review feed. Remove deletes
                the run and its error with it; someone who has read the error
                and decided to live with it should not have to destroy the
                record to stop being asked about it (the same gap SC-138 found
                on the import side). */}
            {awaitingDecision ? (
              <Button
                variant="ghost"
                size="sm"
                disabled={dismissFailure.isPending}
                onClick={() => dismissFailure.mutate({ jobId: job.jobId, outcome: 'discarded' })}
              >
                <Check className="mr-2 size-4" aria-hidden="true" />
                {dismissFailure.isPending
                  ? t('v3.jobs.detail.dismissPending')
                  : t('v3.jobs.detail.dismiss')}
              </Button>
            ) : null}
            {/* Confirmed, unlike its neighbour: `Retry` re-queues something
                that already failed and can be pressed again, while this
                deletes the run — the payload, the error and whatever the
                worker recorded about it — and there is no second copy. SC-63
                found the same shape on the holdings bulk bar; the answer is
                the same component, and here it can be inline because this row
                already wraps. */}
            <ConfirmAction
              label={t('v3.jobs.remove.trigger')}
              confirmLabel={t('v3.jobs.remove.commit')}
              destructive
              open={confirmingRemove}
              onOpenChange={setConfirmingRemove}
              isPending={remove.isPending}
              consequence={t('v3.jobs.remove.consequence', { label: label.toLowerCase() })}
              onConfirm={() => remove.mutate({ jobId: job.jobId })}
            />
          </div>
        </div>
      ) : null}
    </Block>
  );
}
