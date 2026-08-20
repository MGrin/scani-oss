import { Skeleton } from '@scani/ui/ui/skeleton';
import { LoadingRamp } from '@scani/ui/v3/components/feedback/LoadingRamp';
import { useDelayedLoading } from '@scani/ui/v3/hooks/useDelayedLoading';
import { useTranslation } from 'react-i18next';
import { type CaptureStage, describeCaptureStage } from '../../lib/capture-forms';

/**
 * A capture in flight — the §2.5 ramp rather than the spinner v2 draws.
 *
 * These are the longest actions in the product: three or four round trips, one
 * of which is the file itself going up a phone's uplink. The ramp is the right
 * shape for exactly that reason — a submit that resolves in 200ms should draw
 * *nothing*, because a spinner that appears and vanishes inside a blink reads as
 * a fault, and the same component owes a 40-second upload something better than
 * a rotating line.
 *
 * The skeleton band is shaped like the job page, because the job page is where
 * this lands. The stage caption sits outside the ramp's `aria-hidden` decoration
 * and is polite-announced, so the step is available to a screen reader without
 * the six rectangles that a skeleton read aloud would be.
 */
export function CaptureProgress({ stage, label }: { stage: CaptureStage; label: string }) {
  const { t } = useTranslation();
  // Constant `true`: this component is mounted only while the submission is
  // running, so the ramp's clock starts when the submission does.
  const phase = useDelayedLoading(true);
  if (phase === 'idle') return null;

  return (
    <div className="flex flex-col gap-2">
      <LoadingRamp phase={phase} label={label} skeleton={<JobHandoffSkeleton />} />
      <p className="text-caption text-muted-foreground" aria-live="polite">
        {describeCaptureStage(t, stage)}
      </p>
    </div>
  );
}

/** The job detail header, in outline: a title, a state badge, the progress rail
 *  under them and the first two facts. */
function JobHandoffSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-md border border-border p-4">
      <div className="flex items-center gap-3">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-5 w-20 rounded-full" />
      </div>
      <Skeleton className="h-1.5 w-full rounded-full" />
      <div className="flex flex-col gap-2">
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/2" />
      </div>
    </div>
  );
}
