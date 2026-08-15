import { describeJobFailure, type JobFailureFacts } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';

type JobState = 'queued' | 'active' | 'progress' | 'completed' | 'failed' | string;

const LABELS: Record<string, string> = {
  queued: 'Queued',
  active: 'Active',
  progress: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};

/**
 * v2 is permanent chrome, not a migration affordance (see `App.tsx`), so it
 * gets the same distinction v3 does: "Failed" alone covers a job retrying in
 * ten seconds and a job that is permanently dead, and the second one is the
 * whole point of SC-153. `failure` is optional so the callers that only have a
 * state keep working, unchanged.
 */
export function JobStateChip({ state, failure }: { state: JobState; failure?: JobFailureFacts }) {
  const described = failure?.state === 'failed' ? describeJobFailure(failure) : null;
  const label = described?.label ?? LABELS[state] ?? state;
  if (state === 'completed') {
    return (
      <Badge
        variant="secondary"
        className="gap-1 h-5 px-1.5 text-[10px] bg-green-500/15 text-green-600 dark:text-green-400"
      >
        <CheckCircle2 className="h-3 w-3" />
        {label}
      </Badge>
    );
  }
  if (state === 'failed') {
    // A retry that is genuinely coming is the system working, not an alarm —
    // same treatment as a running job, for the same reason as v3.
    if (described?.willRetry) {
      return (
        <Badge variant="secondary" className="gap-1 h-5 px-1.5 text-[10px]">
          <Loader2 className="h-3 w-3 animate-spin" />
          {label}
        </Badge>
      );
    }
    return (
      <Badge variant="destructive" className="gap-1 h-5 px-1.5 text-[10px]">
        <XCircle className="h-3 w-3" />
        {label}
      </Badge>
    );
  }
  if (state === 'queued') {
    return (
      <Badge variant="outline" className="gap-1 h-5 px-1.5 text-[10px]">
        <Clock className="h-3 w-3" />
        {label}
      </Badge>
    );
  }
  // active / progress
  return (
    <Badge variant="secondary" className="gap-1 h-5 px-1.5 text-[10px]">
      <Loader2 className="h-3 w-3 animate-spin" />
      {label}
    </Badge>
  );
}
