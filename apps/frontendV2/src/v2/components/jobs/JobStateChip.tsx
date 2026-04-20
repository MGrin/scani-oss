import { CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

type JobState = 'queued' | 'active' | 'progress' | 'completed' | 'failed' | string;

const LABELS: Record<string, string> = {
  queued: 'Queued',
  active: 'Active',
  progress: 'Running',
  completed: 'Completed',
  failed: 'Failed',
};

export function JobStateChip({ state }: { state: JobState }) {
  const label = LABELS[state] ?? state;
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
