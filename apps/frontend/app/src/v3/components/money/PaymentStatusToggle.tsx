import { formatDate } from '@scani/shared';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';

/**
 * Pause and resume a recurring payment, from its peek sheet.
 *
 * A toggle rather than the one-way Pause button this replaced. `payments.pause`
 * shipped without an inverse, so the surface offered an action the reader could
 * not undo — and v3 puts it one tap from the row rather than three clicks into
 * a detail page, which makes the missing half worse, not better.
 *
 * A leaf rather than a mutation held by `RecurringList`, so the list itself
 * touches no tRPC hook and can be rendered — and asserted on — without a
 * client. Ending a payment is its own leaf next door (`EndPaymentAction`).
 *
 * The confirmation IS the consequence, and it is inline: the first tap swaps
 * the button for the sentence plus a commit, so what the schedule will do is on
 * screen before anything is written — which is the whole point, since neither
 * direction is visibly destructive and both move dates the reader is counting
 * on. That shape is now `ConfirmAction`, shared with the two genuinely
 * destructive actions V3-31 added; this one opts out of `destructive` because
 * pause and resume are each other's inverse, and spending the red on a
 * reversible action is what makes it stop meaning anything on `End`.
 */

/**
 * What pausing does. Stated in terms of the SCHEDULE rather than the row,
 * because "paused" alone reads as "nothing happens" and the thing the reader
 * actually needs to know is what becomes of the dates that pass meanwhile.
 */
export const PAUSE_CONSEQUENCE =
  'No new due dates while paused. Anything that falls due meanwhile is recorded as skipped, not overdue.';

/**
 * What resuming does, which is the answer to the question the pause raises:
 * does the schedule restart from today, or pick up where it was? It picks up —
 * the anchor never moves — and the pause window is settled as skipped rather
 * than landing as a stack of immediately-overdue rows.
 *
 * Payments paused before Scani recorded a pause date get the narrower, true
 * promise instead of the general one: there is no provable window for them, so
 * `PaymentService.resume` leaves their past alone and so does this sentence.
 */
export function resumeConsequence(pausedAt: string | null): string {
  if (!pausedAt) {
    return 'Picks up the original schedule — the same dates as before. Past due dates are left exactly as they are.';
  }
  return `Picks up the original schedule — the same dates as before. Anything due since ${formatDate(pausedAt.slice(0, 10))} is recorded as skipped, not overdue.`;
}

interface PaymentStatusToggleProps {
  paymentId: string;
  status: string;
  pausedAt: string | null;
}

export function PaymentStatusToggle({ paymentId, status, pausedAt }: PaymentStatusToggleProps) {
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState(false);

  const pauseMutation = trpc.payments.pause.useMutation({
    onSuccess: () => {
      setConfirming(false);
      showSuccess('Payment paused');
      void utils.payments.invalidate();
    },
    onError: (error) => showError(error, 'Pausing payment'),
  });

  const resumeMutation = trpc.payments.resume.useMutation({
    onSuccess: () => {
      setConfirming(false);
      showSuccess('Payment resumed');
      void utils.payments.invalidate();
    },
    onError: (error) => showError(error, 'Resuming payment'),
  });

  // An ended payment has no toggle: resuming it is a different operation
  // (it would have to unpick the end date and the occurrences `end` removed),
  // and the API refuses it rather than half-doing it.
  if (status !== 'active' && status !== 'paused') return null;

  const paused = status === 'paused';
  const mutation = paused ? resumeMutation : pauseMutation;
  const label = paused ? 'Resume' : 'Pause';

  return (
    <ConfirmAction
      label={label}
      confirmLabel={paused ? 'Resume this payment' : 'Pause this payment'}
      open={confirming}
      onOpenChange={setConfirming}
      isPending={mutation.isPending}
      consequence={paused ? resumeConsequence(pausedAt) : PAUSE_CONSEQUENCE}
      onConfirm={() => mutation.mutate({ paymentId })}
    />
  );
}
