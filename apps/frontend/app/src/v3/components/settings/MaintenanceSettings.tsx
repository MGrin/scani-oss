import { Button } from '@scani/ui/ui/button';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { Loader2, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { useJobStatus } from '@/v3/hooks/useJobStatus';

/**
 * Rebuild the cached daily values behind the Net worth and PnL charts.
 *
 * The same 365-day backfill the 04:00 UTC schedule runs, on demand — useful
 * after an import, or any time the curve looks wrong. It is a *job*, so the
 * button stays busy until the job reports back rather than until the enqueue
 * returns: an enqueue that resolves in 40ms and then leaves the chart unchanged
 * for two minutes is a button that reads as broken.
 */
export function MaintenanceSettings() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [jobId, setJobId] = useState<string | null>(null);

  const recompute = trpc.portfolio.recomputeHistory.useMutation({
    onSuccess: ({ jobId: enqueued }) => setJobId(enqueued),
    onError: (error) => showError(error, t('v3.settings.pending.rebuildingHistory')),
  });

  const status = useJobStatus(jobId);

  useEffect(() => {
    if (!jobId) return;
    if (status.state === 'completed') {
      showSuccess(t('v3.settings.maintenance.rebuilt'));
      setJobId(null);
      void utils.portfolio.invalidate();
    } else if (status.state === 'failed') {
      // A string, and `userFacingError` rather than the raw throw — see the
      // note in `AccountSettings` for why both halves matter (SC-551).
      showError(
        status.userFacingError ?? t('v3.settings.maintenance.rebuildFailed'),
        t('v3.settings.pending.rebuildingHistory')
      );
      setJobId(null);
    }
    // Same as `AccountSettings`: the toast is fired from the effect, so `t`
    // has to be a dependency or the message is stale.
  }, [jobId, status.state, status.userFacingError, utils, t]);

  const running = recompute.isPending || jobId !== null;

  return (
    <Block className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-label text-muted-foreground">{t('v3.settings.maintenance.title')}</h2>
        <p className="text-body text-muted-foreground">{t('v3.settings.maintenance.intro')}</p>
      </div>
      <Button
        variant="outline"
        className="self-start"
        disabled={running}
        onClick={() => recompute.mutate()}
      >
        {running ? (
          <Loader2 className="mr-2 size-4 animate-spin" aria-hidden="true" />
        ) : (
          <RefreshCw className="mr-2 size-4" aria-hidden="true" />
        )}
        {running ? t('v3.settings.maintenance.rebuilding') : t('v3.settings.maintenance.rebuild')}
      </Button>
    </Block>
  );
}
