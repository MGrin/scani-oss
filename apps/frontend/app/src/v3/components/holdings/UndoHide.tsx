import { userFacingMessage } from '@scani/ui/lib/user-facing-error';
import { ToastAction } from '@scani/ui/ui/toast';
import { useToast } from '@scani/ui/ui/use-toast';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';

/**
 * "Undo" on a toast: every holding a hide just hid, back on the owner's lists.
 * A delete that hid a feed holding (A5 #9) and the unpriceable-airdrops sheet
 * both offer it; a removed snapshot has nothing to restore, so it is never in
 * `hiddenIds`. After the toast is gone, Tokens → Hidden brings any one back.
 */
export function UndoHide({
  hiddenIds,
  onWritten,
}: {
  hiddenIds: readonly string[];
  onWritten: () => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const restore = trpc.holdings.restore.useMutation();
  const [pending, setPending] = useState(false);
  return (
    <ToastAction
      altText={t('v3.holdings.undoHide.undo')}
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          for (const id of hiddenIds) await restore.mutateAsync({ id });
          toast({ title: t('v3.holdings.undoHide.restored') });
        } catch (error) {
          toast({
            title: t('v3.holdings.undoHide.restoreFailed'),
            description: userFacingMessage(error) ?? undefined,
            variant: 'destructive',
          });
        } finally {
          await onWritten();
          setPending(false);
        }
      }}
    >
      {t('v3.holdings.undoHide.undo')}
    </ToastAction>
  );
}
