import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

export function useAccountActions() {
  const utils = trpc.useUtils();

  const deleteMutation = trpc.accounts.delete.useMutation({
    onSuccess: () => {
      utils.accounts.invalidate();
      showSuccess('Account deleted successfully');
    },
    onError: (error) => showError(error, 'Failed to delete account'),
  });

  const bulkDeleteMutation = trpc.accounts.bulkDelete.useMutation({
    onSuccess: (_data, variables) => {
      utils.accounts.invalidate();
      showSuccess(`${variables.ids.length} account(s) deleted successfully`);
    },
    onError: (error) => showError(error, 'Failed to delete accounts'),
  });

  const updateMutation = trpc.accounts.update.useMutation({
    onSuccess: () => {
      utils.accounts.invalidate();
      showSuccess('Account updated successfully');
    },
    onError: (error) => showError(error, 'Failed to update account'),
  });

  const bulkAssignGroupsMutation = trpc.accounts.bulkAssignGroups.useMutation({
    onSuccess: () => {
      utils.accounts.invalidate();
      utils.groups.invalidate();
      showSuccess('Groups assigned successfully');
    },
    onError: (error) => showError(error, 'Failed to assign groups'),
  });

  return {
    deleteAccount: (id: string) => deleteMutation.mutate({ id }),
    bulkDelete: (ids: string[]) => bulkDeleteMutation.mutate({ ids }),
    updateAccount: (id: string, data: { name?: string; description?: string | null }) =>
      updateMutation.mutate({ id, data }),
    bulkAssignGroups: (accountIds: string[], groupIds: string[]) =>
      bulkAssignGroupsMutation.mutate({ accountIds, groupIds }),
    isDeleting: deleteMutation.isPending,
    isBulkDeleting: bulkDeleteMutation.isPending,
    isUpdating: updateMutation.isPending,
    isAssigningGroups: bulkAssignGroupsMutation.isPending,
  };
}
