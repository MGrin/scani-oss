import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from './invalidatePortfolioQueries';

export function useHoldingActions() {
  const utils = trpc.useUtils();

  // All three mutations fire invalidation in the background so callers
  // (e.g. dialogs, bulk-action bars) don't wait for every portfolio
  // query to refetch before showing the success toast / closing.
  const deleteMutation = trpc.holdings.delete.useMutation({
    onSuccess: () => {
      showSuccess('Holding deleted');
      void invalidatePortfolioQueries(utils);
    },
    onError: (err) => showError(err, 'Deleting holding'),
  });

  const bulkDeleteMutation = trpc.holdings.bulkDelete.useMutation({
    onSuccess: (result) => {
      showSuccess(`${result.deletedIds.length} holding(s) deleted`);
      void invalidatePortfolioQueries(utils);
    },
    onError: (err) => showError(err, 'Deleting holdings'),
  });

  const updateMutation = trpc.holdings.update.useMutation({
    onSuccess: () => {
      showSuccess('Holding updated');
      void invalidatePortfolioQueries(utils);
    },
    onError: (err) => showError(err, 'Updating holding'),
  });

  // Price refresh runs async on the worker — the queued job emits a
  // `holding.update` WS event on completion, so the RealtimeContext
  // auto-invalidates. We toast immediately on enqueue.
  const refreshPriceMutation = trpc.holdings.updatePrice.useMutation({
    onSuccess: () => {
      showSuccess('Price refresh queued');
    },
    onError: (err) => showError(err, 'Refreshing price'),
  });

  // Balance refresh hits the underlying integration (wallet RPC, CEX
  // API, broker Flex Query) and re-syncs the account this holding sits
  // on. Same async + WS-event pattern as price refresh.
  const refreshBalanceMutation = trpc.holdings.refreshBalance.useMutation({
    onSuccess: () => {
      showSuccess('Balance refresh queued');
    },
    onError: (err) => showError(err, 'Refreshing balance'),
  });

  return {
    deleteHolding: (id: string, options?: { onSuccess?: () => void }) =>
      deleteMutation.mutate({ id }, { onSuccess: options?.onSuccess }),
    bulkDeleteHoldings: (ids: string[], options?: { onSuccess?: () => void }) =>
      bulkDeleteMutation.mutate({ ids }, { onSuccess: options?.onSuccess }),
    updateHolding: (id: string, data: { balance?: string; isActive?: boolean }) =>
      updateMutation.mutate({ id, data }),
    refreshPrice: (id: string) =>
      refreshPriceMutation.mutate({ id, requestId: crypto.randomUUID() }),
    refreshBalance: (holdingId: string) =>
      refreshBalanceMutation.mutate({ holdingId, requestId: crypto.randomUUID() }),
    /**
     * The raw mutation handle is exposed so the holding detail page can
     * read `data.jobId` from the latest call and subscribe via
     * `useJobStatus`. The toast in the hook only confirms enqueue —
     * downstream feedback ("we synced ETH but USDC wasn't in the
     * wallet response") needs the per-call jobId from this handle.
     */
    refreshBalanceMutation,
    isDeleting: deleteMutation.isPending,
    isBulkDeleting: bulkDeleteMutation.isPending,
    isUpdating: updateMutation.isPending,
    isRefreshingPrice: refreshPriceMutation.isPending,
    isRefreshingBalance: refreshBalanceMutation.isPending,
  };
}
