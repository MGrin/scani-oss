import { formatDate } from '@scani/shared';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
export const PAUSE_CONSEQUENCE_KEY = 'v3.money.status.pauseConsequence';

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
export function resumeConsequence(t: TFunction, pausedAt: string | null): string {
  if (!pausedAt) return t('v3.money.status.resumeConsequence');
  // The date is interpolated, never translated — it comes from `formatDate`,
  // which pins `APP_LOCALE` (en-GB). A date inside a translation key is a bug
  // that is very hard to find later.
  return t('v3.money.status.resumeConsequenceSince', {
    date: formatDate(pausedAt.slice(0, 10)),
  });
}

interface PaymentStatusToggleProps {
  paymentId: string;
  status: string;
  pausedAt: string | null;
}

export function PaymentStatusToggle({ paymentId, status, pausedAt }: PaymentStatusToggleProps) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [confirming, setConfirming] = useState(false);

  const pauseMutation = trpc.payments.pause.useMutation({
    onSuccess: () => {
      setConfirming(false);
      showSuccess(t('v3.money.status.paused'));
      void utils.payments.invalidate();
    },
    onError: (error) => showError(error, t('v3.money.pending.pausingPayment')),
  });

  const resumeMutation = trpc.payments.resume.useMutation({
    onSuccess: () => {
      setConfirming(false);
      showSuccess(t('v3.money.status.resumed'));
      void utils.payments.invalidate();
    },
    onError: (error) => showError(error, t('v3.money.pending.resumingPayment')),
  });

  // An ended payment has no toggle: resuming it is a different operation
  // (it would have to unpick the end date and the occurrences `end` removed),
  // and the API refuses it rather than half-doing it.
  if (status !== 'active' && status !== 'paused') return null;

  const paused = status === 'paused';
  const mutation = paused ? resumeMutation : pauseMutation;
  const label = paused ? t('v3.money.status.resume') : t('v3.money.status.pause');

  return (
    <ConfirmAction
      label={label}
      confirmLabel={paused ? t('v3.money.status.resumeConfirm') : t('v3.money.status.pauseConfirm')}
      open={confirming}
      onOpenChange={setConfirming}
      isPending={mutation.isPending}
      consequence={paused ? resumeConsequence(t, pausedAt) : t(PAUSE_CONSEQUENCE_KEY)}
      onConfirm={() => mutation.mutate({ paymentId })}
    />
  );
}
