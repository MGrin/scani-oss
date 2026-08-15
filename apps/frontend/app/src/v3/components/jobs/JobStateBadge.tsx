import { describeJobFailure, type JobFailureFacts } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { AlertCircle, CheckCircle2, Clock, Loader2, XCircle } from 'lucide-react';
import { jobStateLabel } from '../../lib/jobs';

/**
 * A job's state, as a chip.
 *
 * v2's `JobStateChip` hardcodes `bg-green-500/15 text-green-600` for the
 * completed state — one of the 35 hardcoded green/red sites §2.3 counted, and
 * a colour that means nothing on the v3 page because it is not a token. Here
 * "completed" is the *unremarkable* state and gets the plain secondary chip;
 * the only two states that earn a colour are the two that need something from
 * the user, and both carry an icon so colour is never the only signal.
 */

interface JobStateBadgeProps {
  state: string;
  /** Completed, but its result still wants a confirmation. Outranks the state:
   *  "Completed" on a job the user still has to act on is the reason those
   *  imports sit unnoticed. */
  needsAction?: boolean;
  /** The rest of the row, so a failure can say *which* failure it is. Without
   *  these, "Failed" covers a job retrying in ten seconds, a job that is
   *  permanently dead and a job the user cancelled — three situations with
   *  three different next steps, wearing one chip (SC-153). */
  failure?: JobFailureFacts;
}

export function JobStateBadge({ state, needsAction, failure }: JobStateBadgeProps) {
  // `--interactive`, the same accent `AttentionRow` spends on the home screen:
  // the palette's rule is that the accent marks what you can act on, and this
  // is the only chip on the list that is an instruction.
  if (needsAction) {
    return (
      <Badge variant="outline" className="gap-1 border-border-strong text-interactive">
        <AlertCircle className="size-3" aria-hidden="true" />
        Needs review
      </Badge>
    );
  }

  if (state === 'failed') {
    // Described only when the *queue* failed. `state` here can also be a
    // failure derived from a completed run's contents (a parse that extracted
    // nothing — see `deriveJobOutcomeState`), and that job has no attempts
    // left to talk about: reading its retry counters would announce a retry
    // for a run that finished successfully as far as BullMQ is concerned.
    const described = failure?.state === 'failed' ? describeJobFailure(failure) : null;
    // A retry that is genuinely coming is not an alarm — it is the system
    // working, and spending the destructive variant on it is what taught the
    // eye that a red job chip means nothing in particular. `secondary` with a
    // spinner, the same treatment a running job gets, because that is what it
    // is: a run in progress that has already stumbled once.
    if (described?.willRetry) {
      return (
        <Badge variant="secondary" className="gap-1">
          <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" />
          {described.label}
        </Badge>
      );
    }
    return (
      <Badge variant="destructive" className="gap-1">
        <XCircle className="size-3" aria-hidden="true" />
        {described?.label ?? jobStateLabel(state)}
      </Badge>
    );
  }

  if (state === 'completed') {
    return (
      <Badge variant="secondary" className="gap-1">
        <CheckCircle2 className="size-3" aria-hidden="true" />
        {jobStateLabel(state)}
      </Badge>
    );
  }

  if (state === 'queued') {
    return (
      <Badge variant="outline" className="gap-1">
        <Clock className="size-3" aria-hidden="true" />
        {jobStateLabel(state)}
      </Badge>
    );
  }

  return (
    <Badge variant="secondary" className="gap-1">
      {/* `motion-safe`, because a chip that spins forever is the exact thing
          `prefers-reduced-motion` is for and this one is on screen for as long
          as the job runs. */}
      <Loader2 className="size-3 motion-safe:animate-spin" aria-hidden="true" />
      {jobStateLabel(state)}
    </Badge>
  );
}
