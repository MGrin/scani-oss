import { Card, CardContent } from '@/components/ui/card';
import { JobStateChip } from './JobStateChip';
import { JobSummary } from './JobSummary';
import { jobLabelFor } from './jobLabels';
import { relativeTime } from './relativeTime';

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
}

/** Generic top-of-page block for /jobs/:jobId. The job-type-specific body renders below. */
export function JobHeader({ job }: { job: JobHeaderJob }) {
  const { label, icon: Icon } = jobLabelFor(job.jobName);
  const isRunning = job.state === 'active' || job.state === 'progress' || job.state === 'queued';

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
          <div className="space-y-1">
            {/* Indeterminate bar: our worker pipeline doesn't emit progress
                percentages, so a 1/3-width filler slides back and forth to
                signal "still working". `animate-loading-bar` is defined in
                tailwind.config.js and runs from -100% → 150% → -100%. */}
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-primary/20">
              <div className="absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary animate-loading-bar" />
            </div>
            <div className="text-[10px] text-muted-foreground">
              attempt {job.attemptsMade || 1} / {job.attemptsAllowed}
            </div>
          </div>
        )}

        <div className="text-[10px] text-muted-foreground flex flex-wrap gap-3">
          <span>Created {relativeTime(job.createdAt)}</span>
          {job.startedAt && <span>Started {relativeTime(job.startedAt)}</span>}
          {job.finishedAt && <span>Finished {relativeTime(job.finishedAt)}</span>}
        </div>

        {job.state === 'failed' && job.error && (
          <div className="text-xs text-destructive rounded-md border border-destructive/40 bg-destructive/5 p-2 font-mono whitespace-pre-wrap">
            {job.error}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
