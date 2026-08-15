import type { ReactNode } from 'react';
import { useState } from 'react';
import { countLabel } from '../../lib/data-view';
import { ConfirmAction } from '../ConfirmAction';

/**
 * Delete, from a list's bulk-action bar.
 *
 * The bar this lives in was where v3 destroyed the most and asked the least
 * (SC-63). On `/holdings`, `Select` → a row checkbox raised a bar reading
 * "1 holding selected" with `Assign groups` and a solid red `Delete` eight
 * pixels apart, and the red one deleted the row from the database on the tap —
 * no confirm, no undo, no toast, the header total dropping €73k while the
 * finger was still on the glass. Meanwhile `End`, `Pause` and `Merge` — three
 * actions that between them remove some scheduled dates — all confirmed first.
 * The one irrecoverable write on the surface was the one with no gate on it.
 *
 * So it is `ConfirmAction`, the same component those three use, rather than a
 * fourth way of asking. The bulk bar is exactly the surface that component was
 * designed for: an inline confirm needs a row it can claim, and this one wraps.
 * Two properties follow from that and both matter here more than anywhere:
 *
 * - **Cancel takes the trigger's position.** The confirm block claims the full
 *   line and leads with Cancel, so the second tap of an impatient double-tap
 *   lands on Cancel. On the old bar the second tap landed on Delete.
 * - **The commit is not labelled like the trigger.** "Delete" opens it;
 *   "Delete 3 holdings" commits it. The count is in the button, not only in
 *   the sentence, because the button is what gets read at 390px.
 *
 * A dialog was the other option and is the wrong one for the same reason §8.1
 * gives: on a phone the bar sits inside a list the reader is mid-scroll
 * through, and a modal over it discards the selection context — the rows —
 * that they would use to check they picked the right ones.
 *
 * `consequence` is the caller's, not built from the count here, because what
 * goes *with* the records is the part worth reading and only the surface knows
 * it: holdings take their transaction history, accounts take everything held
 * in them.
 */

/**
 * "Delete 3 holdings" — the commit's label, pulled out so it is assertable
 * without a DOM. `ConfirmAction` renders the open frame and this suite has no
 * way to open one, so the two halves of rule 2 (the commit is not labelled
 * like the trigger, and it carries the count) are pinned here.
 */
export function bulkDeleteCommitLabel(count: number, noun: string, nounSingular?: string): string {
  return `Delete ${countLabel(count, noun, nounSingular)}`;
}

interface BulkDeleteActionProps {
  /** How many records the trigger is standing over. */
  count: number;
  /** Plural, lowercase — "holdings". Singularised for a count of one. */
  noun: string;
  nounSingular?: string;
  /** What is destroyed, in the reader's terms. Prose, not a title. */
  consequence: ReactNode;
  isPending?: boolean;
  onConfirm: () => void;
}

export function BulkDeleteAction({
  count,
  noun,
  nounSingular,
  consequence,
  isPending,
  onConfirm,
}: BulkDeleteActionProps) {
  const [open, setOpen] = useState(false);

  return (
    <ConfirmAction
      label="Delete"
      confirmLabel={bulkDeleteCommitLabel(count, noun, nounSingular)}
      destructive
      open={open}
      onOpenChange={setOpen}
      isPending={isPending}
      consequence={consequence}
      onConfirm={onConfirm}
    />
  );
}
