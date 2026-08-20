import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { usePeekRoute } from '@scani/ui/v3/hooks/usePeekRoute';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { vendorDeleteConsequence } from '../../lib/money';
import { V3_ROUTES } from '../../lib/routes';

/**
 * Delete a vendor, from its peek sheet.
 *
 * Until SC-83 a vendor could only be disposed of by merging it into another
 * one, which is a workaround rather than a delete: a vendor created by mistake
 * — or created by the extractor with a name taken verbatim off an invoice —
 * had no other vendor it belonged inside.
 *
 * IT REFUSES ON PAYMENTS, and the sentence is where that refusal lives rather
 * than a disabled trigger with a tooltip: on a phone there is no hover, and
 * "why can I not do this" is the only question the reader has at that moment.
 * The three ways out were weighed in `VendorHasPaymentsError` — cascade
 * destroys settled history to remove a name, reassign IS merge, so refuse is
 * what leaves delete meaning one thing. The consequence names the count and
 * both routes forward.
 *
 * `deletePreview` is fetched lazily on open, the same shape `MergeVendorAction`
 * uses for `mergePreview`: a reader who never deletes anything never pays for
 * the counts, and the commit waits for them, because agreeing to "Checking…"
 * is agreeing to nothing.
 */

interface DeleteVendorActionProps {
  vendorId: string;
  vendorName: string;
}

export function DeleteVendorAction({ vendorId, vendorName }: DeleteVendorActionProps) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  // The sheet leaves with the record — see `DeletePaymentAction` for why an
  // open peek over a deleted row is worse than no peek at all.
  const peekRoute = usePeekRoute(V3_ROUTES.vendors);

  const preview = trpc.vendors.deletePreview.useQuery({ vendorId }, { enabled: open });

  const deleteMutation = trpc.vendors.delete.useMutation({
    onSuccess: () => {
      setOpen(false);
      showSuccess(t('v3.money.deleteVendor.deleted', { vendor: vendorName }));
      void utils.vendors.invalidate();
      peekRoute.close();
    },
    onError: (error) => showError(error, t('v3.money.pending.deletingVendor')),
  });

  const counts = preview.data ?? null;

  return (
    <ConfirmAction
      label={t('v3.money.deleteVendor.trigger')}
      confirmLabel={t('v3.money.deleteVendor.confirm')}
      destructive
      triggerClassName="text-destructive"
      open={open}
      onOpenChange={setOpen}
      canConfirm={counts !== null && counts.payments === 0}
      isPending={deleteMutation.isPending}
      consequence={vendorDeleteConsequence(vendorName, counts, t)}
      onConfirm={() => deleteMutation.mutate({ vendorId })}
    />
  );
}
