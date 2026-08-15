import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { usePeekRoute } from '@scani/ui/v3/hooks/usePeekRoute';
import { useState } from 'react';
import { trpc } from '@/lib/trpc';
import { useEndPayment } from '../../hooks/useEndPayment';
import { paymentDeleteConsequence, paymentDeleteCounts } from '../../lib/money';
import { V3_ROUTES } from '../../lib/routes';

/**
 * Delete a recurring payment, from its peek sheet — the action `End` is not.
 *
 * SC-83's third half. `end` was the only way to stop a payment, and it is the
 * right answer for a bill that genuinely ran: the schedule stops, the record
 * and its settled history stay, and every figure that counted it still counts
 * it. It is the wrong answer for one created BY MISTAKE — a mistyped amount, a
 * duplicate from an invoice, a test — because ending it leaves a permanent
 * wrong record in the history and in the figures.
 *
 * So the two sit side by side and the sentence carries the difference: *ended*
 * is a true fact about a real bill, *deleted* is "this should never have
 * existed". Both are `ConfirmAction`; only this one refuses.
 *
 * IT REFUSES ON SETTLED DATES. A `matched` occurrence is money that moved,
 * carrying the transaction it matched and the invoice it settled — deleting
 * the payment cascades all of it away and silently rewrites the vendor's paid
 * totals for a period nobody asked about. The consequence becomes the reason.
 * The server refuses too, on a recount inside the transaction, so a settlement
 * landing while this sheet is open cannot slip through.
 *
 * WHAT THE REFUSAL OFFERS (SC-113). It used to offer a disabled "Delete this
 * payment" — the app proposed Delete, the reader took it, and the confirm that
 * opened had one affirmative and it was dead, while the way out its own copy
 * recommended was back in the row now covered by the confirm. So the refusal's
 * commit is now **End**, the action the sentence already names: one tap
 * instead of cancel-and-re-find. Ending is destructive in its own right, but
 * this is still a confirm and the sentence still says what happens, so nothing
 * fires without a second deliberate tap on a differently-labelled button.
 *
 * A payment that has ALREADY ended and has settled dates has neither action
 * available. That block is `dismissOnly` — an explanation with one button —
 * because the only thing worse than a dead affirmative is a live one that
 * repeats what already happened.
 *
 * The counts come from `payments.get`, fetched lazily on open — the same query
 * `EndPaymentAction` beside it opens with, so react-query serves the second
 * one from cache and neither action pays for the other.
 */

interface DeletePaymentActionProps {
  paymentId: string;
  vendorName: string;
  /** Which of the two ways out of a refusal is still open — End is not one of
   *  them on a payment that has already ended. */
  status: string;
}

export function DeletePaymentAction({ paymentId, vendorName, status }: DeletePaymentActionProps) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  // The sheet has to leave with the record. Left open it would resolve its id
  // against a list that no longer holds it and render `PeekSheet`'s "not on
  // this list" copy — telling the reader their own successful delete looks
  // like a stale link.
  const peekRoute = usePeekRoute(V3_ROUTES.recurring);

  const detail = trpc.payments.get.useQuery({ paymentId }, { enabled: open });

  const deleteMutation = trpc.payments.delete.useMutation({
    onSuccess: () => {
      setOpen(false);
      showSuccess('Payment deleted');
      void utils.payments.invalidate();
      // The vendor list's per-vendor counts and its settled figures both read
      // this payment; leaving them cached shows a deleted bill's money.
      void utils.vendors.invalidate();
      peekRoute.close();
    },
    onError: (error) => showError(error, 'Deleting payment'),
  });

  const ending = useEndPayment(() => setOpen(false));

  const counts = detail.data ? paymentDeleteCounts(detail.data.occurrences) : null;
  const refused = counts !== null && counts.settled > 0;
  const endInstead = refused && status !== 'ended';

  return (
    <ConfirmAction
      label="Delete"
      confirmLabel={endInstead ? 'End this payment' : 'Delete this payment'}
      destructive
      triggerClassName="text-destructive"
      open={open}
      onOpenChange={setOpen}
      // The one remaining reason the commit can be unavailable, and it is a
      // "not yet" rather than a "no": the counts have not landed, so there is
      // nothing to agree to. A settlement no longer disables anything — it
      // changes which action the button performs.
      canConfirm={counts !== null}
      dismissOnly={refused && !endInstead}
      isPending={deleteMutation.isPending || ending.isPending}
      consequence={paymentDeleteConsequence(vendorName, counts, refused && !endInstead)}
      onConfirm={() => (endInstead ? ending.end(paymentId) : deleteMutation.mutate({ paymentId }))}
    />
  );
}
