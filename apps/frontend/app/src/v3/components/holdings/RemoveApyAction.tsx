import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { PercentCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';

/**
 * Removes a holding's interest configuration, confirmed inline in the peek's
 * actions (UI standard rule 6). It was a centred `ConfirmDialog` mounted on the
 * page and opened from a button inside the APY fact (SC-1413).
 */
export function RemoveApyAction({ holdingId }: { holdingId: string }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);

  const remove = trpc.holdings.deleteApyConfig.useMutation({
    onSuccess: () => {
      setOpen(false);
      showSuccess(t('v3.holdings.apy.removed'));
      void invalidatePortfolioQueries(utils);
    },
    onError: (error) => showError(error, t('v3.holdings.apy.removing')),
  });

  return (
    <ConfirmAction
      label={
        <>
          <PercentCircle className="me-2 size-4" aria-hidden="true" />
          {t('v3.holdings.apy.trigger')}
        </>
      }
      triggerClassName="text-destructive hover:text-destructive"
      confirmLabel={t('v3.holdings.apy.commit')}
      consequence={t('v3.holdings.apy.consequence')}
      destructive
      open={open}
      onOpenChange={setOpen}
      isPending={remove.isPending}
      onConfirm={() => remove.mutate({ holdingId })}
    />
  );
}
