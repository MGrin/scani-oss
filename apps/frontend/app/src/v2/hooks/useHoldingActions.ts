import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { trpc } from '@/lib/trpc';
import { invalidatePortfolioQueries } from './invalidatePortfolioQueries';
import { optimisticPatchHolding, optimisticRemoveHoldings } from './optimisticUpdates';

export function useHoldingActions() {
  const utils = trpc.useUtils();

  // delete / bulkDelete / update apply an optimistic cache patch in `onMutate`
  // (the row disappears / updates instantly), roll back in `onError`, and
  // reconcile server-computed figures via `invalidatePortfolioQueries` in
  // `onSettled`.
  const deleteMutation = trpc.holdings.delete.useMutation({
    onMutate: ({ id }) => optimisticRemoveHoldings(utils, [id]),
    onSuccess: () => {
      showSuccess('Holding deleted');
    },
    onError: (err, _vars, ctx) => {
      ctx?.restore();
      showError(err, 'Deleting holding');
    },
    onSettled: () => {
      void invalidatePortfolioQueries(utils);
    },
  });

  const bulkDeleteMutation = trpc.holdings.bulkDelete.useMutation({
    onMutate: ({ ids }) => optimisticRemoveHoldings(utils, ids),
    onSuccess: (result, _vars, ctx) => {
      if (result.failedIds.length > 0 && ctx) {
        // The call resolved but some ids failed server-side. Restore the
        // snapshot, then re-remove only the rows that actually deleted.
        ctx.restore();
        void optimisticRemoveHoldings(utils, result.deletedIds);
      }
      const failed = result.failedIds.length;
      showSuccess(
        `${result.deletedIds.length} holding(s) deleted${failed > 0 ? `, ${failed} failed` : ''}`
      );
    },
    onError: (err, _vars, ctx) => {
      ctx?.restore();
      showError(err, 'Deleting holdings');
    },
    onSettled: () => {
      void invalidatePortfolioQueries(utils);
    },
  });

  const updateMutation = trpc.holdings.update.useMutation({
    onMutate: ({ id, data }) =>
      optimisticPatchHolding(utils, id, {
        amount: data.balance !== undefined ? Number(data.balance) : undefined,
        isActive: data.isActive,
      }),
    onSuccess: () => {
      showSuccess('Holding updated');
    },
    onError: (err, _vars, ctx) => {
      ctx?.restore();
      showError(err, 'Updating holding');
    },
    onSettled: () => {
      void invalidatePortfolioQueries(utils);
    },
  });

  // Price refresh runs async on the worker. The enqueue mutation resolves
  // immediately with a jobId; HoldingDetailContent subscribes to it via
  // `useJobStatus` to show an inline spinner and emit the terminal toast.
  const refreshPriceMutation = trpc.holdings.updatePrice.useMutation({
    onError: (err) => showError(err, 'Refreshing price'),
  });

  // Balance refresh hits the underlying integration (wallet RPC, CEX API,
  // broker Flex Query). Same async + jobId pattern as price refresh.
  const refreshBalanceMutation = trpc.holdings.refreshBalance.useMutation({
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
     * Raw mutation handles are exposed so the holding detail page can read
     * `data.jobId` from the latest call and subscribe via `useJobStatus` —
     * the inline spinner + terminal toast are driven there, not here.
     */
    refreshPriceMutation,
    refreshBalanceMutation,
    isDeleting: deleteMutation.isPending,
    isBulkDeleting: bulkDeleteMutation.isPending,
    isUpdating: updateMutation.isPending,
    isRefreshingPrice: refreshPriceMutation.isPending,
    isRefreshingBalance: refreshBalanceMutation.isPending,
  };
}
