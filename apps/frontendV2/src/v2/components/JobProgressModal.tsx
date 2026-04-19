import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { useJobStatus } from '@/v2/hooks/useJobStatus';

/**
 * Blocking modal that tracks an async BullMQ job through completion.
 *
 * Caller pattern:
 *
 *   const { mutateAsync } = trpc.wallet.importAddressAsync.useMutation();
 *   const [jobId, setJobId] = useState<string | null>(null);
 *   // on submit: const { jobId } = await mutateAsync(...); setJobId(jobId);
 *   <JobProgressModal
 *     jobId={jobId}
 *     title="Importing wallet"
 *     description="Detecting chains and syncing balances…"
 *     onCompleted={(result) => { toast.success('Done'); setJobId(null); }}
 *     onFailed={(err) => { toast.error(err); setJobId(null); }}
 *   />
 */
export interface JobProgressModalProps {
  jobId: string | null;
  title: string;
  description?: string;
  onCompleted?: (result: unknown) => void;
  onFailed?: (error: string) => void;
  /** If true, show a close button on failure (not on success — parent handles). */
  allowManualDismissOnError?: boolean;
  onDismiss?: () => void;
}

export function JobProgressModal({
  jobId,
  title,
  description,
  onCompleted,
  onFailed,
  allowManualDismissOnError = true,
  onDismiss,
}: JobProgressModalProps) {
  const status = useJobStatus(jobId);

  useEffect(() => {
    if (!jobId) return;
    if (status.state === 'completed') {
      onCompleted?.(status.result);
    } else if (status.state === 'failed') {
      onFailed?.(status.error ?? 'Job failed');
    }
  }, [status.state, status.result, status.error, jobId, onCompleted, onFailed]);

  const open = jobId !== null;
  const progressPct =
    typeof status.progress === 'number' ? Math.round(status.progress * 100) : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && status.state === 'failed' && allowManualDismissOnError) {
          onDismiss?.();
        }
        // Intentionally block dismissal while a job is in flight — this is
        // the "blocking progress modal" behaviour from the implementation
        // plan. If the user really wants to cancel, they can close the
        // tab; the job still runs on the worker.
      }}
    >
      <DialogContent className="sm:max-w-md" onEscapeKeyDown={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>

        <div className="space-y-3 py-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="text-muted-foreground">Status</span>
            <span className="font-medium">{prettyState(status.state)}</span>
          </div>

          {progressPct !== null ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Progress</span>
                <span>{progressPct}%</span>
              </div>
              <Progress value={progressPct} />
            </div>
          ) : (
            <Progress value={null} />
          )}

          {status.attemptsMade && status.attemptsAllowed && status.attemptsMade > 1 ? (
            <div className="text-xs text-amber-600 dark:text-amber-400">
              Retrying… attempt {status.attemptsMade} of {status.attemptsAllowed}
            </div>
          ) : null}

          {status.state === 'failed' && status.error ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-destructive text-xs">
              {status.error}
            </div>
          ) : null}
        </div>

        {status.state === 'failed' && allowManualDismissOnError ? (
          <DialogFooter>
            <Button variant="secondary" onClick={onDismiss}>
              Close
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function prettyState(state: string): string {
  switch (state) {
    case 'queued':
      return 'Queued';
    case 'active':
      return 'Running';
    case 'progress':
      return 'Running';
    case 'completed':
      return 'Done';
    case 'failed':
      return 'Failed';
    default:
      return 'Starting…';
  }
}
