import { Button } from '@scani/ui/ui/button';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { Block } from '@scani/ui/v3/components/Block';
import { ConfirmAction } from '@scani/ui/v3/components/ConfirmAction';
import { LogOut, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { trpc } from '@/lib/trpc';
import { useJobStatus } from '@/v2/hooks/useJobStatus';
import { V3_BASE } from '../../lib/ui-version';

/**
 * Leaving, and the one action on this screen that cannot be undone.
 *
 * They share a block on purpose. v2 gives Sign out its own card and puts Delete
 * in a red-bordered "Danger Zone" three cards further down, which separates the
 * two things a person reaches for when they want out of the app — and makes the
 * milder one hard to find precisely because the drastic one is loud.
 *
 * Here the destructive action is last, visually quiet, and gated behind a
 * confirm that spells out what goes. A red border around a block is decoration;
 * the sentence and the confirm are the thing that actually prevents the
 * mistake.
 *
 * That confirm is `ConfirmAction` (V3-31), not the shared `ConfirmDialog` this
 * screen used to open. The dialog stacked "Delete everything" full-width and
 * solid red *first and on top*, with "Keep my data" beneath it — so on a phone
 * the commit landed exactly where the thumb that had just tapped the trigger
 * was still resting, on the one action in the product with no inverse. Every
 * other v3 destructive action (`End`, `Pause`, vendor `Merge`) leads with
 * Cancel because `ConfirmAction` enforces it. This is the highest-stakes place
 * to be the exception, so it is not one.
 *
 * The delete is a *job*, so completion is what the WS status says, not what the
 * enqueue returned — and on completion every cached query is dropped, because
 * react-query would otherwise keep serving pre-delete holdings and charts until
 * each stale time rolled over independently.
 */
export function AccountSettings() {
  const { t } = useTranslation();
  const { signOut } = useAuth();
  const navigate = useNavigate();
  const utils = trpc.useUtils();

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  const deleteAll = trpc.users.deleteAllData.useMutation({
    onSuccess: ({ jobId: enqueued }) => {
      setConfirmDelete(false);
      setJobId(enqueued);
    },
    onError: (error) => showError(error, 'Deleting your data'),
  });

  const status = useJobStatus(jobId);

  useEffect(() => {
    if (!jobId) return;
    if (status.state === 'completed') {
      showSuccess('All your data has been deleted');
      setJobId(null);
      utils.invalidate();
      navigate(V3_BASE);
    } else if (status.state === 'failed') {
      showError(new Error(status.error ?? 'The delete failed'), 'Deleting your data');
      setJobId(null);
    }
  }, [jobId, status.state, status.error, navigate, utils]);

  const deleting = deleteAll.isPending || jobId !== null;

  return (
    <Block className="flex flex-col gap-4 p-4">
      <div className="flex flex-col gap-2">
        <h2 className="text-label text-muted-foreground">{t('settings.account')}</h2>
        <Button variant="outline" className="self-start" onClick={() => void signOut()}>
          <LogOut className="mr-2 size-4" aria-hidden="true" />
          {t('settings.signOut')}
        </Button>
      </div>

      <div className="flex flex-col items-start gap-2 border-t border-border pt-4">
        <p className="text-body text-muted-foreground">
          Deleting your data removes every account, holding, wallet, integration credential, group
          and vault. The login itself stays, empty.
        </p>
        <ConfirmAction
          label={
            <>
              <Trash2 className="mr-2 size-4" aria-hidden="true" />
              {deleting ? 'Deleting…' : 'Delete all my data'}
            </>
          }
          triggerClassName="text-destructive hover:text-destructive"
          confirmLabel="Delete everything"
          consequence="Every account, holding, wallet, integration credential, group and vault goes. Your login remains, with nothing in it. This cannot be undone."
          destructive
          isPending={deleting}
          disabledReason={deleting ? 'Your data is being deleted.' : undefined}
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          onConfirm={() => deleteAll.mutate({ requestId: crypto.randomUUID() })}
        />
      </div>
    </Block>
  );
}
