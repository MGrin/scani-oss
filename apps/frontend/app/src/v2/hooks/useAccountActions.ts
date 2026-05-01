import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from './invalidatePortfolioQueries';

// Note: there is no `bulkAssignGroups` here. That flow lives inside
// `AssignGroupsDialog` because it needs access to the current common-
// groups state to compute the add/remove diff against the user's save
// selection. Pulling the mutation into this hook would mean duplicating
// that diff logic at every call site.

export function useAccountActions() {
  const utils = trpc.useUtils();

  // All three mutations fire invalidation in the background so callers
  // (the bulk-action bar, the detail page, etc.) don't wait for every
  // portfolio query to refetch before showing the success toast.
  const deleteMutation = trpc.accounts.delete.useMutation({
    onSuccess: () => {
      showSuccess('Account deleted successfully');
      void invalidatePortfolioQueries(utils);
    },
    onError: (error) => showError(error, 'Failed to delete account'),
  });

  const bulkDeleteMutation = trpc.accounts.bulkDelete.useMutation({
    onSuccess: (_data, variables) => {
      showSuccess(`${variables.ids.length} account(s) deleted successfully`);
      void invalidatePortfolioQueries(utils);
    },
    onError: (error) => showError(error, 'Failed to delete accounts'),
  });

  const updateMutation = trpc.accounts.update.useMutation({
    onSuccess: () => {
      showSuccess('Account updated successfully');
      void invalidatePortfolioQueries(utils);
    },
    onError: (error) => showError(error, 'Failed to update account'),
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
