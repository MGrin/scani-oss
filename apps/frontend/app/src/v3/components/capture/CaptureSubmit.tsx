import { Button } from '@scani/ui/ui/button';
import type { CaptureStage } from '../../lib/capture-forms';
import { CaptureProgress } from './CaptureProgress';

/**
 * The bottom of every capture form: the one button, what is still missing, what
 * went wrong last time, and the ramp that replaces all three while the
 * submission runs.
 *
 * Four pages share it because the rule it encodes is the ticket's: **a disabled
 * button always says why.** v2 greys out four different submit buttons behind
 * four different boolean expressions and explains none of them, which is a form
 * that has an opinion it will not state.
 *
 * The failure line is here rather than in a toast, and the toast is gone rather
 * than kept alongside it. Two reasons, both measured on a 390px phone: a toast
 * shows for four seconds over the tab bar, so the person who looked away — at
 * the file they were about to re-pick, say — has no way back to what it said;
 * and `showError` opens with "Something went wrong", which is the one sentence
 * §2.5 forbids outright. Under the button is where the eye already is after a
 * tap, and `describeQueryError` is the voice.
 */
interface CaptureSubmitProps {
  label: string;
  blockers: string[];
  onSubmit: () => void;
  /** The running step, or null when the form is idle. */
  stage: CaptureStage | null;
  /** Lowercase noun phrase for the ramp's screen-reader line — "the upload". */
  busyLabel: string;
  error: string | null;
}

export function CaptureSubmit({
  label,
  blockers,
  onSubmit,
  stage,
  busyLabel,
  error,
}: CaptureSubmitProps) {
  if (stage) {
    // `min-h-10` holds the button's height for the ramp's first 300ms, so the
    // page does not jump on submit and jump back on failure.
    return (
      <div className="flex min-h-10 flex-col gap-2">
        <CaptureProgress stage={stage} label={busyLabel} />
      </div>
    );
  }

  return (
    <div className="flex min-h-10 flex-col gap-2">
      <Button onClick={onSubmit} disabled={blockers.length > 0} className="w-full">
        {label}
      </Button>
      {blockers.length > 0 ? (
        <p className="text-center text-caption text-muted-foreground">
          To continue: {blockers.join(', ')}.
        </p>
      ) : null}
      {error ? <p className="text-center text-caption text-destructive">{error}</p> : null}
    </div>
  );
}
