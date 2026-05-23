import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from './invalidatePortfolioQueries';
import { optimisticPatchAccount, optimisticRemoveAccounts } from './optimisticUpdates';

// Note: there is no `bulkAssignGroups` here. That flow lives inside
// `AssignGroupsDialog` because it needs access to the current common-
// groups state to compute the add/remove diff against the user's save
// selection. Pulling the mutation into this hook would mean duplicating
// that diff logic at every call site.

export function useAccountActions() {
  const utils = trpc.useUtils();

  // delete / bulkDelete / update apply an optimistic cache patch in `onMutate`,
  // roll back in `onError`, and reconcile via `invalidatePortfolioQueries` in
  // `onSettled` (server-computed totals can't be patched client-side).
  const deleteMutation = trpc.accounts.delete.useMutation({
    onMutate: ({ id }) => optimisticRemoveAccounts(utils, [id]),
    onSuccess: () => {
      showSuccess('Account deleted successfully');
    },
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, 'Failed to delete account');
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
      showSuccess(
        `${result.deletedIds.length} account(s) deleted${failed > 0 ? `, ${failed} failed` : ''}`
      );
    },
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, 'Failed to delete accounts');
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
      showSuccess('Account updated successfully');
    },
    onError: (error, _vars, ctx) => {
      ctx?.restore();
      showError(error, 'Failed to update account');
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
    updateAccount: (id: string, data: { name?: string; description?: string | null }) =>
      updateMutation.mutate({ id, data }),
    isDeleting: deleteMutation.isPending,
    isBulkDeleting: bulkDeleteMutation.isPending,
    isUpdating: updateMutation.isPending,
  };
}
