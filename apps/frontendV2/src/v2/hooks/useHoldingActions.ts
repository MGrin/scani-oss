import { showError, showSuccess } from '@/hooks/use-toast';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from './invalidatePortfolioQueries';

export function useHoldingActions() {
  const utils = trpc.useUtils();

  const deleteMutation = trpc.holdings.delete.useMutation({
    onSuccess: async () => {
      await invalidatePortfolioQueries(utils);
      showSuccess('Holding deleted');
    },
    onError: (err) => showError(err, 'Deleting holding'),
  });

  const bulkDeleteMutation = trpc.holdings.bulkDelete.useMutation({
    onSuccess: async (result) => {
      await invalidatePortfolioQueries(utils);
      showSuccess(`${result.deletedIds.length} holding(s) deleted`);
    },
    onError: (err) => showError(err, 'Deleting holdings'),
  });

  const updateMutation = trpc.holdings.update.useMutation({
    onSuccess: async () => {
      await invalidatePortfolioQueries(utils);
      showSuccess('Holding updated');
    },
    onError: (err) => showError(err, 'Updating holding'),
  });

  const refreshPriceMutation = trpc.holdings.updatePrice.useMutation({
    onSuccess: async (result) => {
      await invalidatePortfolioQueries(utils);
      const priceInfo = result.price ? `Price: ${result.price}` : 'Price updated';
      showSuccess(result.source ? `${priceInfo} (${result.source})` : priceInfo);
    },
    onError: (err) => showError(err, 'Refreshing price'),
  });

  return {
    deleteHolding: (id: string, options?: { onSuccess?: () => void }) =>
      deleteMutation.mutate({ id }, { onSuccess: options?.onSuccess }),
    bulkDeleteHoldings: (ids: string[], options?: { onSuccess?: () => void }) =>
      bulkDeleteMutation.mutate({ ids }, { onSuccess: options?.onSuccess }),
    updateHolding: (id: string, data: { balance?: string; isActive?: boolean }) =>
      updateMutation.mutate({ id, data }),
    refreshPrice: (id: string) => refreshPriceMutation.mutate({ id }),
    isDeleting: deleteMutation.isPending,
    isBulkDeleting: bulkDeleteMutation.isPending,
    isUpdating: updateMutation.isPending,
    isRefreshingPrice: refreshPriceMutation.isPending,
  };
}
