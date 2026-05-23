import { formatRelative } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@scani/ui/ui/card';
import { PageLoader } from '@scani/ui/ui/loading';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { AlertCircle, RotateCcw, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { JobStateChip } from '../components/jobs/JobStateChip';
import { JobSummary } from '../components/jobs/JobSummary';
import { jobLabelFor } from '../components/jobs/jobLabels';
import { useUserJobs } from '../hooks/useUserJobs';
import { V2_ROUTES } from '../lib/routes';

const ACTIVE = new Set(['queued', 'active', 'progress']);

// Keep this aligned with ACTION_REQUIRED_JOB_NAMES in useUserJobs —
// these are the job types whose result requires a follow-up user
// confirmation before the holdings count toward the portfolio.
const ACTION_REQUIRED_JOB_NAMES = new Set(['screenshot-parse', 'file-import', 'wallet-import']);

function needsAction(job: { state: string; jobName: string; actionTakenAt: unknown }): boolean {
  return (
    job.state === 'completed' && ACTION_REQUIRED_JOB_NAMES.has(job.jobName) && !job.actionTakenAt
  );
}

export function JobsPage() {
  const { jobs, isLoading } = useUserJobs();

  if (isLoading) return <PageLoader />;

  // Surface action-required jobs at the top in their own section so the
  // user can't miss them. They still appear in the regular Completed
  // section below, tagged with a "Needs review" chip.
  const pendingAction = jobs.filter(needsAction);
  const active = jobs.filter((j) => ACTIVE.has(j.state));
  const completed = jobs.filter((j) => j.state === 'completed');
  const failed = jobs.filter((j) => j.state === 'failed');

  return (
    <div className="max-w-4xl mx-auto w-full px-0 sm:px-4 py-2 sm:py-4 space-y-4">
      {pendingAction.length > 0 && (
        <JobSection title="Needs your review" jobs={pendingAction} emptyText="" accent="warning" />
      )}
      <JobSection title="Active" jobs={active} emptyText="Nothing running right now." />
      <JobSection title="Completed" jobs={completed} emptyText="No completed jobs yet." />
      <JobSection title="Failed" jobs={failed} emptyText="No failed jobs." />
    </div>
  );
}

type Job = ReturnType<typeof useUserJobs>['jobs'][number];

function JobSection({
  title,
  jobs,
  emptyText,
  accent,
}: {
  title: string;
  jobs: Job[];
  emptyText: string;
  accent?: 'warning';
}) {
  return (
    <Card className={accent === 'warning' ? 'border-amber-500/50 bg-amber-500/5' : undefined}>
      <CardHeader>
        <CardTitle className="text-sm flex items-center justify-between">
          <span className="flex items-center gap-1.5">
            {accent === 'warning' && <AlertCircle className="h-3.5 w-3.5 text-amber-600" />}
            {title}
          </span>
          <span className="text-xs text-muted-foreground">{jobs.length}</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {jobs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{emptyText}</p>
        ) : (
          <div className="divide-y">
            {jobs.map((job) => (
              <JobRow key={job.jobId} job={job} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function JobRow({ job }: { job: Job }) {
  const { label, icon: Icon } = jobLabelFor(job.jobName);
  const pending = needsAction(job);
  const isFailed = job.state === 'failed';
  return (
    <Link
      to={V2_ROUTES.jobDetail(job.jobId)}
      className="flex items-start gap-2.5 py-2.5 hover:bg-accent/50 -mx-2 px-2 rounded-md"
    >
      <Icon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-sm font-medium truncate">{label}</span>
          {pending && (
            <Badge
              variant="outline"
              className="gap-1 h-5 px-1.5 text-[10px] border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300"
            >
              <AlertCircle className="h-2.5 w-2.5" />
              Needs review
            </Badge>
          )}
        </div>
        <JobSummary jobName={job.jobName} payloadSummary={job.payloadSummary} />
        {/* Meta row wraps under the label on narrow screens so nothing
            gets clipped when both a state chip and timestamp are present.
            Retry button appears here too on mobile. */}
        <div className="flex items-center gap-2 pt-0.5 sm:hidden">
          <JobStateChip state={job.state} />
          <span className="text-[10px] text-muted-foreground">{formatRelative(job.createdAt)}</span>
          {isFailed && <RetryButton jobId={job.jobId} />}
          {isFailed && <RemoveButton jobId={job.jobId} />}
        </div>
      </div>
      <div className="shrink-0 hidden sm:flex items-center gap-2">
        {isFailed && <RetryButton jobId={job.jobId} />}
        {isFailed && <RemoveButton jobId={job.jobId} />}
        <span className="text-[10px] text-muted-foreground">{formatRelative(job.createdAt)}</span>
        <JobStateChip state={job.state} />
      </div>
    </Link>
  );
}

/**
 * Retry button for failed jobs. Swallows the outer <Link>'s click so the
 * user stays on the list while the mutation runs, then toasts the
 * outcome and invalidates `jobs.listMine` — the row flips out of Failed
 * and back into Active on the next tick.
 */
function RetryButton({ jobId }: { jobId: string }) {
  const utils = trpc.useUtils();
  const retryMutation = trpc.jobs.retry.useMutation({
    onSuccess: () => {
      showSuccess('Job re-queued');
      utils.jobs.listMine.invalidate();
    },
    onError: (err) => showError(err, 'Retrying job'),
  });
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-6 gap-1 text-[11px] px-2"
      disabled={retryMutation.isPending}
      onClick={(e) => {
        // The row is a <Link>, so without stopping propagation the
        // click would navigate to the detail page while also firing
        // the mutation.
        e.preventDefault();
        e.stopPropagation();
        retryMutation.mutate({ jobId });
      }}
    >
      <RotateCcw className="h-3 w-3" />
      Retry
    </Button>
  );
}

function RemoveButton({ jobId }: { jobId: string }) {
  const utils = trpc.useUtils();
  const removeMutation = trpc.jobs.remove.useMutation({
    onSuccess: () => {
      showSuccess('Job removed');
      utils.jobs.listMine.invalidate();
    },
    onError: (err) => showError(err, 'Removing job'),
  });
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="h-6 gap-1 text-[11px] px-2"
      disabled={removeMutation.isPending}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        removeMutation.mutate({ jobId });
      }}
    >
      <Trash2 className="h-3 w-3" />
      Remove
    </Button>
  );
}
