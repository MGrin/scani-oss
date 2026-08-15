import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { trpc } from '@/lib/trpc';

/**
 * Ending a recurring payment, from wherever the reader was offered it.
 *
 * There are two of those now. `EndPaymentAction` is the trigger that says so;
 * `DeletePaymentAction` reaches for the same write when the delete is refused
 * on settled dates, because the refusal's own copy has always pointed at End
 * and SC-113 made that sentence's button the button (the alternative was the
 * dead affirmative it shipped with). One mutation, one success toast, one set
 * of invalidations — a second copy is how the two surfaces drift into ending
 * payments differently.
 *
 * `PaymentService.end` defaults the end date to today when the caller sends
 * none, and neither surface sends one.
 */
export function useEndPayment(onEnded?: () => void) {
  const utils = trpc.useUtils();

  const mutation = trpc.payments.end.useMutation({
    onSuccess: () => {
      showSuccess('Payment ended');
      void utils.payments.invalidate();
      onEnded?.();
    },
    onError: (error) => showError(error, 'Ending payment'),
  });

  return {
    end: (paymentId: string) => mutation.mutate({ paymentId }),
    isPending: mutation.isPending,
  };
}
