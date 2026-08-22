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
import { useJobStatus } from '@/v3/hooks/useJobStatus';
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
    onError: (error) => showError(error, t('v3.settings.pending.deletingData')),
  });

  const status = useJobStatus(jobId);

  useEffect(() => {
    if (!jobId) return;
    if (status.state === 'completed') {
      showSuccess(t('v3.settings.account.deleted'));
      setJobId(null);
      utils.invalidate();
      navigate(V3_BASE);
    } else if (status.state === 'failed') {
      // A `string`, not `new Error(string)`. `showError` renders
      // `userFacingMessage`, for which a plain `Error` passes none of the three
      // doors — so wrapping this discarded it and every failed delete toasted
      // "Unknown error" instead of the sentence written right here (SC-551).
      //
      // `status.userFacingError`, and never `status.error`, which no longer
      // exists on this hook for that reason. The field is whatever a processor
      // marked `userFacing(...)`; the raw throw stays on `user_jobs.error` for
      // the admin surfaces and never crosses to a browser. A field named
      // `error` holding "the sentence for the reader" is the naming that
      // caused this, so the name says which one it is.
      showError(
        status.userFacingError ?? t('v3.settings.account.deleteFailed'),
        t('v3.settings.pending.deletingData')
      );
      setJobId(null);
    }
    // `t` is a dependency: the effect fires a toast, and without it the
    // message keeps the language the effect was created in. A delete runs for
    // a while, which is exactly long enough for someone to change it.
  }, [jobId, status.state, status.userFacingError, navigate, utils, t]);

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
        <p className="text-body text-muted-foreground">{t('v3.settings.account.deleteIntro')}</p>
        <ConfirmAction
          label={
            <>
              <Trash2 className="mr-2 size-4" aria-hidden="true" />
              {deleting
                ? t('v3.settings.account.deleting')
                : t('v3.settings.account.deleteTrigger')}
            </>
          }
          triggerClassName="text-destructive hover:text-destructive"
          confirmLabel={t('v3.settings.account.deleteConfirm')}
          consequence={t('v3.settings.account.deleteConsequence')}
          destructive
          isPending={deleting}
          disabledReason={deleting ? t('v3.settings.account.deleteInFlight') : undefined}
          open={confirmDelete}
          onOpenChange={setConfirmDelete}
          onConfirm={() => deleteAll.mutate({ requestId: crypto.randomUUID() })}
        />
      </div>
    </Block>
  );
}
