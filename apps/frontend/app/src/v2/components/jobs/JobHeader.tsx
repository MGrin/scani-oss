import { formatRelative } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent } from '@scani/ui/ui/card';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { RotateCcw, Trash2, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { V2_ROUTES } from '../../lib/routes';
import { JobStateChip } from './JobStateChip';
import { JobSummary } from './JobSummary';
import { jobLabelFor } from './jobLabels';

export interface JobHeaderJob {
  jobId: string;
  jobName: string;
  state: string;
  attemptsMade: number;
  attemptsAllowed: number;
  payloadSummary: unknown;
  createdAt: string | Date;
  startedAt: string | Date | null;
  finishedAt: string | Date | null;
  error: string | null;
  /**
   * Latest worker-emitted phase message. Optional. Surfaced above the
   * indeterminate bar so long polls (IBKR Flex Query generation) can
   * communicate "Waiting for IBKR — generating report (attempt N/24)…".
   */
  statusMessage?: string | null;
}

/** Generic top-of-page block for /jobs/:jobId. The job-type-specific body renders below. */
export function JobHeader({ job }: { job: JobHeaderJob }) {
  const { label, icon: Icon } = jobLabelFor(job.jobName);
  const isRunning = job.state === 'active' || job.state === 'progress' || job.state === 'queued';
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const retryMutation = trpc.jobs.retry.useMutation({
    onSuccess: () => {
      showSuccess('Job re-queued');
      utils.jobs.getMine.invalidate({ jobId: job.jobId });
      utils.jobs.listMine.invalidate();
    },
    onError: (err) => showError(err, 'Retrying job'),
  });
  const cancelMutation = trpc.jobs.cancel.useMutation({
    onSuccess: () => {
      showSuccess('Job cancelled');
      utils.jobs.getMine.invalidate({ jobId: job.jobId });
      utils.jobs.listMine.invalidate();
    },
    onError: (err) => showError(err, 'Cancelling job'),
  });
  const removeMutation = trpc.jobs.remove.useMutation({
    onSuccess: () => {
      showSuccess('Job removed');
      utils.jobs.listMine.invalidate();
      navigate(V2_ROUTES.jobs);
    },
    onError: (err) => showError(err, 'Removing job'),
  });

  return (
    <Card>
      <CardContent className="p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Icon className="h-5 w-5 text-muted-foreground shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold truncate">{label}</h2>
              <JobSummary jobName={job.jobName} payloadSummary={job.payloadSummary} />
            </div>
          </div>
          <JobStateChip state={job.state} />
        </div>

        {isRunning && (
          <div className="space-y-2">
            {job.statusMessage && (
              <p className="text-xs text-muted-foreground">{job.statusMessage}</p>
            )}
            {/* Indeterminate bar: our worker pipeline doesn't emit progress
                percentages, so a 1/3-width filler slides back and forth to
                signal "still working". `animate-loading-bar` is defined in
                tailwind.config.js and runs from -100% → 150% → -100%. */}
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-primary/20">
              <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary animate-loading-bar" />
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="text-[10px] text-muted-foreground">
                attempt {job.attemptsMade || 1} / {job.attemptsAllowed}
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5"
                disabled={cancelMutation.isPending}
                onClick={() => cancelMutation.mutate({ jobId: job.jobId })}
              >
                <X className="h-3.5 w-3.5" />
                {cancelMutation.isPending ? 'Cancelling…' : 'Cancel'}
              </Button>
            </div>
          </div>
        )}

        <div className="text-[10px] text-muted-foreground flex flex-wrap gap-3">
          <span>Created {formatRelative(job.createdAt)}</span>
          {job.startedAt && <span>Started {formatRelative(job.startedAt)}</span>}
          {job.finishedAt && <span>Finished {formatRelative(job.finishedAt)}</span>}
        </div>

        {job.state === 'failed' && (
          <div className="space-y-2">
            {job.error && (
              <div className="text-xs text-destructive rounded-md border border-destructive/40 bg-destructive/5 p-2 font-mono whitespace-pre-wrap">
                {job.error}
              </div>
            )}
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5"
                disabled={retryMutation.isPending}
                onClick={() => retryMutation.mutate({ jobId: job.jobId })}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {retryMutation.isPending ? 'Re-queueing…' : 'Retry'}
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 gap-1.5"
                disabled={removeMutation.isPending}
                onClick={() => removeMutation.mutate({ jobId: job.jobId })}
              >
                <Trash2 className="h-3.5 w-3.5" />
                {removeMutation.isPending ? 'Removing…' : 'Remove'}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
