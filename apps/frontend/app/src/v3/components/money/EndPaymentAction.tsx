import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { useEndPayment } from '../../hooks/useEndPayment';
import { endConsequence, occurrencesEndWouldRemove } from '../../lib/money';

/**
 * End a recurring payment, from its peek sheet.
 *
 * The first of the two destructive actions V3-31 brought into v3. It uses
 * `ConfirmAction` unchanged — see that file for why the confirmation is
 * inline rather than a dialog stacked on the sheet.
 *
 * The count in the sentence is real, not an estimate. `payments.end`
 * deletes every `scheduled` occurrence due after the end date, and the
 * only way to say how many that is, is to ask: `payments.get` is fetched
 * lazily when the confirm opens (`enabled`), so a reader who never ends
 * anything never pays for it, and the sentence reads "checking…" until
 * the answer lands rather than showing a number that could change.
 *
 * A leaf holding its own mutation, for the same reason as
 * `PaymentStatusToggle`: `RecurringList` touches no tRPC hook and stays
 * renderable — and assertable — without a client.
 */

interface EndPaymentActionProps {
  paymentId: string;
  vendorName: string;
  status: string;
}

export function EndPaymentAction({ paymentId, vendorName, status }: EndPaymentActionProps) {
  const [open, setOpen] = useState(false);

  // `PaymentService.end` defaults the end date to today when the caller
  // sends none, and this surface sends none — so today is the date the
  // sentence must name, computed the same way (UTC) the service does.
  const endDate = new Date().toISOString().slice(0, 10);

  const detail = trpc.payments.get.useQuery({ paymentId }, { enabled: open });

  const ending = useEndPayment(() => setOpen(false));

  // An already-ended payment has nothing to end. Hidden rather than
  // disabled: a dead button on a record that reached its normal final
  // state is noise, and the status is already stated two rows below.
  if (status === 'ended') return null;

  const removed = detail.data ? occurrencesEndWouldRemove(detail.data.occurrences, endDate) : null;

  return (
    <ConfirmAction
      label="End"
      confirmLabel="End this payment"
      destructive
      open={open}
      onOpenChange={setOpen}
      // The count is what makes the sentence worth reading, so the commit
      // waits for it. Without this the reader could agree to "checking how
      // many dates this removes…", which is agreeing to nothing.
      canConfirm={removed !== null}
      isPending={ending.isPending}
      consequence={endConsequence(vendorName, endDate, removed)}
      onConfirm={() => ending.end(paymentId)}
    />
  );
}
