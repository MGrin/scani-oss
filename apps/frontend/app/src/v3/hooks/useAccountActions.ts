import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { useTranslation } from 'react-i18next';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import { optimisticPatchAccount, optimisticRemoveAccounts } from '@/v3/hooks/optimisticUpdates';

// Note: there is no `bulkAssignGroups` here. That flow lives inside
// `AssignGroupsDialog` because it needs access to the current common-
// groups state to compute the add/remove diff against the user's save
// selection. Pulling the mutation into this hook would mean duplicating
// that diff logic at every call site.

/**
 * v3's copy of v2's hook of the same name, with the eight toasts keyed
 * (SC-320). v2 keeps its own and dies with it — see `useHoldingActions`.
 */
export function useAccountActions() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();

  // delete / bulkDelete / update apply an optimistic cache patch in `onMutate`,
  // roll back in `onError`, and reconcile via `invalidatePortfolioQueries` in
  // `onSettled` (server-computed totals can't be patched client-side).
  const deleteMutation = trpc.accounts.delete.useMutation({
    onMutate: ({ id }) => optimisticRemoveAccounts(utils, [id]),
    onSuccess: () => {
      showSuccess(t('v3.entities.account.toast.deleted'));
    },
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, t('v3.entities.account.toast.deletingContext'));
    },
    onSettled: () => {
      void invalidatePortfolioQueries(utils);
    },
  });

  const bulkDeleteMutation = trpc.accounts.bulkDelete.useMutation({
    onMutate: ({ ids }) => optimisticRemoveAccounts(utils, ids),
    onSuccess: (result, _vars, ctx) => {
      if (result.failedIds.length > 0 && ctx) {
        // The call resolved but some ids failed server-side. Restore the
        // snapshot, then re-remove only the rows that actually deleted.
        ctx.restore();
        void optimisticRemoveAccounts(utils, result.deletedIds);
      }
      const failed = result.failedIds.length;
      const count = result.deletedIds.length;
      showSuccess(
        failed > 0
          ? t('v3.entities.account.toast.bulkDeletedWithFailures', { count, failed })
          : t('v3.entities.account.toast.bulkDeleted', { count })
      );
    },
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, t('v3.entities.account.toast.bulkDeletingContext'));
    },
    onSettled: () => {
      void invalidatePortfolioQueries(utils);
    },
  });

  const updateMutation = trpc.accounts.update.useMutation({
    onMutate: ({ id, data }) =>
      optimisticPatchAccount(utils, id, {
        name: data.name,
        description: data.description,
      }),
    onSuccess: () => {
      showSuccess(t('v3.entities.account.toast.updated'));
    },
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, t('v3.entities.account.toast.updatingContext'));
    },
    onSettled: () => {
      void invalidatePortfolioQueries(utils);
    },
  });

  return {
    deleteAccount: (id: string, options?: { onSuccess?: () => void }) =>
      deleteMutation.mutate({ id }, { onSuccess: options?.onSuccess }),
    bulkDelete: (ids: string[], options?: { onSuccess?: () => void }) =>
      bulkDeleteMutation.mutate({ ids }, { onSuccess: options?.onSuccess }),
    updateAccount: (
      id: string,
      data: { name?: string; description?: string | null; typeId?: string }
    ) => updateMutation.mutate({ id, data }),
    isDeleting: deleteMutation.isPending,
    isBulkDeleting: bulkDeleteMutation.isPending,
    isUpdating: updateMutation.isPending,
  };
}
