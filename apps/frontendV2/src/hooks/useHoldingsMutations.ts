import type { HoldingWithDetails } from '@scani/shared';
import { showError, useToast } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

export function useHoldingsMutations(
  setSelectedRows: (value: React.SetStateAction<Set<string>>) => void
) {
  const { toast } = useToast();
  const utils = trpc.useUtils();

  const invalidateHoldingQueries = () => {
    utils.holdings.getWithDetails.invalidate();
    utils.accounts.getHoldings.invalidate();
    utils.accounts.getByUserIdWithSummary.invalidate();
    utils.dashboard.getOverview.invalidate();
  };

  const deleteHoldingMutation = trpc.holdings.delete.useMutation({
    onSuccess: () => {
      invalidateHoldingQueries();
      toast({
        title: 'Holding deleted',
        description: 'The holding has been successfully deleted.',
      });
    },
    onError: (error) => showError(error, 'Deleting holding'),
  });

  const bulkDeleteHoldingsMutation = trpc.holdings.bulkDelete.useMutation({
    onSuccess: (result) => {
      invalidateHoldingQueries();
      toast({
        title: result.failed > 0 ? 'Holdings partially deleted' : 'Holdings deleted',
        description:
          result.failed > 0
            ? `Successfully deleted ${result.deleted} of ${result.total} holdings. ${result.failed} failed.`
            : `Successfully deleted ${result.deleted} of ${result.total} holdings.`,
      });
      if (result.failedIds && result.failedIds.length > 0) {
        setSelectedRows(new Set(result.failedIds));
      } else {
        setSelectedRows(new Set());
      }
    },
    onError: (error) => showError(error, 'Deleting holdings'),
  });

  const updateHoldingMutation = trpc.holdings.update.useMutation({
    onSuccess: () => {
      invalidateHoldingQueries();
      toast({
        title: 'Holding updated',
        description: 'The holding status has been successfully updated.',
      });
    },
    onError: (error) => showError(error, 'Updating holding'),
  });

  const handleDeleteHolding = (holding: HoldingWithDetails) => {
    deleteHoldingMutation.mutate({ id: holding.id });
  };

  const handleToggleActive = (holding: HoldingWithDetails) => {
    updateHoldingMutation.mutate({
      id: holding.id,
      data: { isActive: !holding.isActive },
    });
  };

  const handleBulkDelete = (selectedRows: Set<string>) => {
    if (selectedRows.size === 0) return;
    const confirmed = window.confirm(
      `Are you sure you want to delete ${selectedRows.size} holding${selectedRows.size !== 1 ? 's' : ''}?`
    );
    if (confirmed) {
      bulkDeleteHoldingsMutation.mutate({ ids: Array.from(selectedRows) });
    }
  };

  return {
    deleteHoldingMutation,
    bulkDeleteHoldingsMutation,
    updateHoldingMutation,
    handleDeleteHolding,
    handleToggleActive,
    handleBulkDelete,
    invalidateHoldingQueries,
  };
}
