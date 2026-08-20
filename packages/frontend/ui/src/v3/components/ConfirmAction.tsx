import type { ReactNode } from 'react';
import { useDismissOnHide } from '../../hooks/useDismissOnHide';
import { useUiTranslation } from '../../i18n';
import { Button } from '../../ui/button';

/**
 * How v3 asks "are you sure" — in place, on the surface that already owns
 * the record, never in a dialog stacked on top of it.
 *
 * The problem this solves (V3-31): `payments.end` and `vendors.merge` both
 * want a confirmation, and both are reached from a peek sheet resting at
 * half the viewport. A Radix dialog opened from inside that sheet puts the
 * reader TWO dismiss gestures deep — on a phone, with a destructive write
 * underneath — and the two gestures are not equivalent: dismissing the
 * outer one first leaves the inner one orphaned or, worse, dismisses both
 * and the reader cannot tell which of the two they cancelled.
 *
 * Three shapes were on the table. This is the argument for the one below,
 * because whatever v3 picks here every later destructive action follows.
 *
 * 1. PROMOTE the sheet to full height and swap its content for the
 *    confirmation. One surface, one dismiss — but the sheet is drag-snapped
 *    (`PEEK_SNAP_POINTS`), so the promotion animates against a gesture the
 *    reader may be mid-way through, and on cancel the surface has to
 *    restore the content and the snap point it came from. It also throws
 *    away the record while asking about the record: the facts the reader
 *    would use to check they picked the right row are what got replaced.
 * 2. INLINE, here. The confirmation is drawn where the trigger was, inside
 *    the sheet the reader already opened. No new surface, so no new dismiss
 *    gesture: the sheet's own dismiss still exists and still means cancel.
 *    The record stays on screen next to the sentence about it.
 * 3. A full PAGE. A route makes the destructive step deep-linkable and
 *    survivable across a reload, neither of which is a property you want
 *    here, and on a phone "back" is the same edge swipe as sheet dismiss —
 *    so it does not reduce the gesture depth, it adds a history entry to
 *    it. It also unmounts the list, which is the thing the peek exists to
 *    preserve.
 *
 * So: inline. V3-41 had already reached the same answer independently for
 * pause/resume and left a note saying `End` was waiting for exactly this
 * component; `PaymentStatusToggle` is now built on it.
 *
 * Two rules the component enforces rather than documents:
 *
 * - CANCEL SITS WHERE THE TRIGGER WAS. The confirm block claims the full
 *   row and leads with Cancel, so the commit button never lands under the
 *   finger that just tapped the trigger. A double-tap on a stale target
 *   cancels; it cannot destroy.
 * - THE COMMIT BUTTON IS NOT LABELLED LIKE THE TRIGGER. `confirmLabel` is
 *   the sentence's verb applied to the object ("End this payment"), not
 *   the trigger's noun ("End"), so the second tap is a different act and
 *   reads as one.
 * - THE OPEN BLOCK DOES NOT SURVIVE THE APP GOING AWAY. See
 *   `useDismissOnHide` (SC-124): the first rule puts distance between the
 *   trigger and the commit, which protects against a misaimed tap and not at
 *   all against a deliberate one made in a context the reader has forgotten.
 *   A background cycle manufactures exactly that context, so it closes.
 *
 * `consequence` is required and is prose, not a title: it has to name what
 * changes in the reader's own terms — which payment, how many dates, which
 * vendor absorbs which — because "This cannot be undone" describes every
 * destructive action ever written and therefore describes none of them.
 */

interface ConfirmActionProps {
  /** The resting button. A noun or short verb — "End", "Merge duplicate".
   *  `ReactNode` so a trigger that already carries an icon keeps it. */
  label: ReactNode;
  /**
   * Tone for the *resting* trigger only — the house red-text outline a
   * danger-zone entry point wears (`text-destructive`). Nothing about the
   * open block is stylable: its geometry and its labels are the rules this
   * component exists to enforce.
   */
  triggerClassName?: string;
  /**
   * The commit button, once open. Deliberately not `label`: see the
   * second rule above.
   */
  confirmLabel: string;
  /** What this does, in concrete terms. Shown before the commit exists. */
  consequence: ReactNode;
  /**
   * An input step, for actions that need an answer before the consequence
   * can be stated at all — `vendors.merge` cannot say what it will move
   * until it knows which vendor is being folded in. Rendered above the
   * consequence, inside the same block.
   */
  chooser?: ReactNode;
  /** False while `chooser` has no answer yet. */
  canConfirm?: boolean;
  isPending?: boolean;
  onConfirm: () => void;
  /** Told about both directions, so a parent can reset a chooser on cancel. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * `destructive` paints the commit red. Off for the reversible actions
   * that use this shape for its clarity rather than its danger — pausing a
   * payment is not destructive, and colouring it as if it were spends the
   * signal that makes `End` legible.
   */
  destructive?: boolean;
  /** Disables the resting trigger, with a reason for the reader. */
  disabledReason?: string;
  /**
   * The record refuses and there is nothing to offer in place of the action —
   * so the open block is an explanation, not a question, and carries one
   * button that dismisses it (SC-113).
   *
   * The alternative was a disabled `confirmLabel`, which is what
   * `/payments/recurring` shipped: Delete opened a confirm whose only
   * affirmative was dead, while the path its own copy recommended sat behind
   * the confirm in the row the reader had just left. **A dead button is never
   * the right answer to a question the app chose to ask.** Where a forward
   * action does exist, `confirmLabel` becomes *that* action instead of this —
   * see `DeletePaymentAction`, where the refusal's commit is "End this
   * payment". This mode is only for when neither is true.
   *
   * `canConfirm` is not the same thing and is not a substitute: it means "not
   * yet" — the counts are still landing — and it resolves on its own.
   */
  dismissOnly?: boolean;
}

export function ConfirmAction({
  label,
  triggerClassName,
  confirmLabel,
  consequence,
  chooser,
  canConfirm = true,
  isPending,
  onConfirm,
  open,
  onOpenChange,
  destructive,
  disabledReason,
  dismissOnly,
}: ConfirmActionProps) {
  const { t } = useUiTranslation();
  // Not while the commit is in flight: the decision is already made and the
  // write is already gone: closing then would only take away the surface that
  // is about to report what happened.
  useDismissOnHide(open && !isPending, () => onOpenChange(false));

  if (!open) {
    return (
      <Button
        variant="outline"
        className={triggerClassName}
        disabled={Boolean(disabledReason)}
        title={disabledReason}
        onClick={() => onOpenChange(true)}
      >
        {label}
      </Button>
    );
  }

  return (
    // `w-full` so the block claims its own line inside the peek's wrapping
    // action row, instead of squeezing the sentence between two buttons.
    <div className="w-full space-y-2">
      {chooser}
      <p className="text-caption text-muted-foreground">{consequence}</p>
      <div className="flex gap-2">
        {/* Cancel first — the rule, not a preference. It also reads as the
            whole answer when there is nothing to confirm, which is why the
            dismiss-only block needs no second button and no relabelling of
            this one: "Cancel" is exactly what dismissing an explanation of a
            refusal does. */}
        <Button variant="ghost" disabled={isPending} onClick={() => onOpenChange(false)}>
          {t('ui.confirmAction.cancel')}
        </Button>
        {dismissOnly ? null : (
          <Button
            variant={destructive ? 'destructive' : 'outline'}
            disabled={isPending || !canConfirm}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        )}
      </div>
    </div>
  );
}
