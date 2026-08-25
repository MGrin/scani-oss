import type { ManualEditCause, ManualOutflowAnswer } from '@scani/shared';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { useTranslation } from 'react-i18next';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import { optimisticPatchHolding, optimisticRemoveHoldings } from '@/v3/hooks/optimisticUpdates';

/**
 * v3's copy of v2's hook of the same name, with the eight toasts keyed
 * (SC-320). v2 keeps its own and dies with it: `v3.*` is registered by the v3
 * chunk alone, so one shared hook would toast raw keys under `/v2`.
 */
export function useHoldingActions() {
  const { t } = useTranslation();
  const utils = trpc.useUtils();

  // delete / bulkDelete / update apply an optimistic cache patch in `onMutate`
  // (the row disappears / updates instantly), roll back in `onError`, and
  // reconcile server-computed figures via `invalidatePortfolioQueries` in
  // `onSettled`.
  const deleteMutation = trpc.holdings.delete.useMutation({
    onMutate: ({ id }) => optimisticRemoveHoldings(utils, [id]),
    onSuccess: () => {
      showSuccess(t('v3.holdings.toast.deleted'));
    },
    onError: (err, _vars, ctx) => {
      ctx?.restore();
      showError(err, t('v3.holdings.toast.deletingContext'));
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
      const count = result.deletedIds.length;
      // Two keys rather than a suffix concatenated onto one: v2 wrote
      // `${n} holding(s) deleted` and appended `, ${failed} failed`, and both
      // halves are English grammar — the parenthesised plural has no analogue
      // in a language that inflects, and a sentence assembled from two
      // translated fragments cannot be reordered by the translator.
      showSuccess(
        failed > 0
          ? t('v3.holdings.toast.bulkDeletedWithFailures', { count, failed })
          : t('v3.holdings.toast.bulkDeleted', { count })
      );
    },
    onError: (err, _vars, ctx) => {
      ctx?.restore();
      showError(err, t('v3.holdings.toast.bulkDeletingContext'));
    },
    onSettled: () => {
      void invalidatePortfolioQueries(utils);
    },
  });

  const updateMutation = trpc.holdings.update.useMutation({
    onMutate: ({ id, data }) =>
      optimisticPatchHolding(utils, id, {
        // The balance verbatim, not `Number(...)`: the optimistic row has to
        // hold what the server will send back, and that is a decimal string
        // (SC-567). Coercing here reintroduced the double one render early.
        amount: data.balance,
        isActive: data.isActive,
        // `null` is a real value here — it clears the pot name — and
        // `mergeDefined` preserves it while skipping `undefined`, so a
        // balance edit that sends no `label` leaves the name alone.
        label: data.label,
      }),
    onSuccess: () => {
      showSuccess(t('v3.holdings.toast.updated'));
    },
    onError: (err, _vars, ctx) => {
      ctx?.restore();
      showError(err, t('v3.holdings.toast.updatingContext'));
    },
    onSettled: () => {
      void invalidatePortfolioQueries(utils);
    },
  });

  // Price refresh runs async on the worker. The enqueue mutation resolves
  // immediately with a jobId; `useHoldingRefresh` subscribes to it to show an
  // inline spinner and emit the terminal toast — which is why the two context
  // strings below are the keys that hook already uses.
  const refreshPriceMutation = trpc.holdings.updatePrice.useMutation({
    onError: (err) => showError(err, t('v3.holdings.refresh.price')),
  });

  // Balance refresh hits the underlying integration (wallet RPC, CEX API,
  // broker Flex Query). Same async + jobId pattern as price refresh.
  const refreshBalanceMutation = trpc.holdings.refreshBalance.useMutation({
    onError: (err) => showError(err, t('v3.holdings.refresh.balance')),
  });

  return {
    deleteHolding: (id: string, options?: { onSuccess?: () => void }) =>
      deleteMutation.mutate({ id }, { onSuccess: options?.onSuccess }),
    bulkDeleteHoldings: (ids: string[], options?: { onSuccess?: () => void }) =>
      bulkDeleteMutation.mutate({ ids }, { onSuccess: options?.onSuccess }),
    /**
     * `editCause` / `editOccurredAt` say what a balance change MEANT (SC-510).
     * Omitted for an `isActive` toggle and for a holding whose price we fetch
     * — the server derives the cause there. Required for the ambiguous set;
     * `HoldingsPage` asks through `HoldingEditCauseDialog` and the API refuses
     * rather than guessing if it arrives without one.
     */
    updateHolding: (
      id: string,
      data: {
        balance?: string;
        isActive?: boolean;
        /** The pot's name (SC-564). `null` clears it; omitted leaves it. */
        label?: string | null;
        editCause?: ManualEditCause;
        editOccurredAt?: string;
        /** Where an outflow went, answered in the same dialog (SC-606). */
        editOutflow?: ManualOutflowAnswer;
      }
    ) => updateMutation.mutate({ id, data }),
    refreshPrice: (id: string) =>
      refreshPriceMutation.mutate({ id, requestId: crypto.randomUUID() }),
    refreshBalance: (holdingId: string) =>
      refreshBalanceMutation.mutate({ holdingId, requestId: crypto.randomUUID() }),
    /**
     * Raw mutation handles are exposed so the holdings page can read
     * `data.jobId` from the latest call and subscribe via `useJobStatus` —
     * the inline spinner + terminal toast are driven in `useHoldingRefresh`,
     * not here.
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
