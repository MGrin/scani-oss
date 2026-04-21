import { AlertCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { LoadingSpinner } from '@/components/ui/loading';
import { JobStateChip } from '../components/jobs/JobStateChip';
import { JobSummary } from '../components/jobs/JobSummary';
import { jobLabelFor } from '../components/jobs/jobLabels';
import { relativeTime } from '../components/jobs/relativeTime';
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

  if (isLoading) return <LoadingSpinner />;

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
            gets clipped when both a state chip and timestamp are present. */}
        <div className="flex items-center gap-2 pt-0.5 sm:hidden">
          <JobStateChip state={job.state} />
          <span className="text-[10px] text-muted-foreground">{relativeTime(job.createdAt)}</span>
        </div>
      </div>
      <div className="shrink-0 hidden sm:flex items-center gap-2">
        <span className="text-[10px] text-muted-foreground">{relativeTime(job.createdAt)}</span>
        <JobStateChip state={job.state} />
      </div>
    </Link>
  );
}
