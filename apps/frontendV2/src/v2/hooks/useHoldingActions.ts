import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';

export function useHoldingActions() {
  const utils = trpc.useUtils();

  const deleteMutation = trpc.holdings.delete.useMutation({
    onSuccess: () => {
      utils.holdings.getWithDetails.invalidate();
      utils.dashboard.getOverview.invalidate();
      showSuccess('Holding deleted');
    },
    onError: (err) => showError(err, 'Deleting holding'),
  });

  const bulkDeleteMutation = trpc.holdings.bulkDelete.useMutation({
    onSuccess: (result) => {
      utils.holdings.getWithDetails.invalidate();
      utils.dashboard.getOverview.invalidate();
      showSuccess(`${result.deletedIds.length} holding(s) deleted`);
    },
    onError: (err) => showError(err, 'Deleting holdings'),
  });

  const updateMutation = trpc.holdings.update.useMutation({
    onSuccess: () => {
      utils.holdings.getWithDetails.invalidate();
      showSuccess('Holding updated');
    },
    onError: (err) => showError(err, 'Updating holding'),
  });

  const refreshPriceMutation = trpc.holdings.updatePrice.useMutation({
    onSuccess: (result) => {
      utils.holdings.getWithDetails.invalidate();
      utils.dashboard.getOverview.invalidate();
      utils.dashboard.getAssetAllocation.invalidate();
      const priceInfo = result.price ? `Price: ${result.price}` : 'Price updated';
      showSuccess(result.source ? `${priceInfo} (${result.source})` : priceInfo);
    },
    onError: (err) => showError(err, 'Refreshing price'),
  });

  return {
    deleteHolding: (id: string) => deleteMutation.mutate({ id }),
    bulkDeleteHoldings: (ids: string[]) => bulkDeleteMutation.mutate({ ids }),
    updateHolding: (id: string, data: { balance?: string; isActive?: boolean }) =>
      updateMutation.mutate({ id, data }),
    refreshPrice: (id: string) => refreshPriceMutation.mutate({ id }),
    isDeleting: deleteMutation.isPending,
    isBulkDeleting: bulkDeleteMutation.isPending,
    isUpdating: updateMutation.isPending,
    isRefreshingPrice: refreshPriceMutation.isPending,
  };
}
