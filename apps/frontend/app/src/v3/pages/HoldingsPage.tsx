import type { HoldingWithDetails } from '@scani/shared';
import { ConfirmDialog } from '@scani/ui/components/ConfirmDialog';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { AssignGroupsDialog } from '@/v2/components/groups/AssignGroupsDialog';
import { ApyConfigDialog } from '@/v2/components/holdings/ApyConfigDialog';
import { EditCustomTokenPriceDialog } from '@/v2/components/tokens/EditCustomTokenPriceDialog';
import { invalidatePortfolioQueries } from '@/v2/hooks/invalidatePortfolioQueries';
import { useHoldingActions } from '@/v2/hooks/useHoldingActions';
import { useOpenCapture } from '../components/capture/CaptureSheetContext';
import { holdingsDataViewConfig } from '../components/holdings/holdingsConfig';
import { useHoldingRefresh } from '../hooks/useHoldingRefresh';
import { holdingFiltersFromParams } from '../lib/holdings';
import { V3_ROUTES } from '../lib/routes';

/**
 * Holdings — the surface the IA change in §2.1 makes central.
 *
 * Institutions and accounts stop being destinations of their own and become
 * **dimensions of this list**: both are filters, both are group-by keys, and
 * `?institution=<id>` opens the list already narrowed. That is why the query
 * parameter names are v2's unchanged (`lib/holdings.ts`) — every existing link
 * into "the holdings at Kraken" has to keep meaning that across the version
 * switch. The standalone pages still exist under More until V3-15 ports them;
 * nothing here depends on them.
 *
 * The list itself is `holdingsDataViewConfig`. What is left here is the three
 * things the sheet and the config cannot own:
 *
 * - **The dialogs.** Interest and manual-price open *over* the drawer, and a
 *   Radix dialog mounted inside that drawer would be torn down by the drawer's
 *   own dismiss. Delete used to be a third one; SC-73 moved its confirmation
 *   into the peek's action row (`HoldingDeleteAction`), so the sheet asks the
 *   question the same way the bulk bar does and the page keeps only the write.
 * - **The refresh jobs.** Price and balance refreshes are worker jobs that
 *   outlive the sheet; `useHoldingRefresh` explains why the subscription cannot
 *   live where the button does.
 * - **The peek's exit after a delete.** The record is gone from the cache, so
 *   staying would swap the sheet's content for its own not-found copy over the
 *   list the holding was just deleted from.
 *
 * `optimisticUpdates.ts` reaches this page through `useHoldingActions`,
 * unchanged: cancel, snapshot, patch, roll back on error, invalidate on settle
 * is already the right pattern and v3 has no reason to own a second copy.
 */

export function HoldingsPage() {
  const holdingsQuery = trpc.holdings.getWithDetails.useQuery();
  const groupsQuery = trpc.groups.getAll.useQuery();
  const baseCurrencyQuery = trpc.users.getBaseCurrency.useQuery();
  // Fetched independently of the holdings so a filter chip can name an
  // institution or account that has no holdings behind it yet — a freshly
  // connected integration that imported nothing would otherwise render its own
  // UUID over an empty list.
  const institutionsQuery = trpc.institutions.getAll.useQuery();
  const accountsQuery = trpc.accounts.getAll.useQuery();

  // The five queries the list actually depends on, collapsed so the error half
  // cannot be dropped (V3-16). `holdings.getWithDetails` failing while the
  // filter dimensions succeed would otherwise render the onboarding empty
  // state over an account that has holdings.
  const holdingsState = mergeQueries(
    holdingsQuery,
    groupsQuery,
    baseCurrencyQuery,
    institutionsQuery,
    accountsQuery
  );

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const utils = trpc.useUtils();

  const actions = useHoldingActions();
  const refresh = useHoldingRefresh(actions);

  const [apyTarget, setApyTarget] = useState<HoldingWithDetails | null>(null);
  const [apyRemoveTarget, setApyRemoveTarget] = useState<HoldingWithDetails | null>(null);
  const [priceTarget, setPriceTarget] = useState<HoldingWithDetails | null>(null);
  const [assignTarget, setAssignTarget] = useState<{ ids: string[]; clear: () => void } | null>(
    null
  );

  const removeApyMutation = trpc.holdings.deleteApyConfig.useMutation({
    onSuccess: () => {
      setApyRemoveTarget(null);
      showSuccess('Interest configuration removed');
      void invalidatePortfolioQueries(utils);
    },
    onError: (error) => showError(error, 'Removing the interest configuration'),
  });

  const holdings = holdingsQuery.data?.holdings ?? [];
  const currency = baseCurrencyQuery.data?.symbol || 'USD';

  // Read once, at mount: `useDataView` seeds its filter state from this, and a
  // later change is the user's own filtering rather than the link's.
  const defaultFilters = useMemo(() => holdingFiltersFromParams(searchParams), [searchParams]);

  const openCapture = useOpenCapture();

  const config = holdingsDataViewConfig({
    holdings,
    currency,
    institutions: institutionsQuery.data,
    accounts: accountsQuery.data,
    groups: groupsQuery.data,
    defaultFilters,
    onAssignGroups: (ids, clear) => setAssignTarget({ ids, clear }),
    // The confirmation is `BulkDeleteAction`'s, inline in the bar the trigger
    // is in (SC-63) — by the time this runs the user has read what goes and
    // pressed a differently-labelled second button, so this is the write.
    onBulkDelete: (ids, clear) => actions.bulkDeleteHoldings(ids, { onSuccess: clear }),
    isBulkDeleting: actions.isBulkDeleting,
    onAddData: openCapture,
    peek: {
      currency,
      onSetAmount: (holding, balance) => actions.updateHolding(holding.id, { balance }),
      onToggleActive: (holding) =>
        actions.updateHolding(holding.id, { isActive: !holding.isActive }),
      isTogglingActive: actions.isUpdating,
      onRefreshPrice: refresh.refreshPrice,
      onRefreshBalance: refresh.refreshBalance,
      refreshingPriceId: refresh.refreshingPriceId,
      refreshingBalanceId: refresh.refreshingBalanceId,
      onEditPrice: setPriceTarget,
      onConfigureApy: setApyTarget,
      onRemoveApy: setApyRemoveTarget,
      // The confirmation is `HoldingDeleteAction`'s, inline in the peek's own
      // action row (SC-73) — the same move the bulk bar made. What stays here
      // is the part the sheet cannot own: the record is out of the cache after
      // this, so the peek has to leave its own URL.
      onDelete: (holding) =>
        actions.deleteHolding(holding.id, {
          onSuccess: () => navigate(V3_ROUTES.holdings, { replace: true }),
        }),
      isDeleting: actions.isDeleting,
    },
  });

  return (
    // `wide`: the seven-column desktop table is the widest thing v3 renders,
    // and it converts every pixel it is given into a column the reader would
    // otherwise have to open the peek sheet to see.
    <PageLayout measure="wide">
      <h1 className="text-title">Holdings</h1>

      <V3DataView config={config} getId={(item) => item.id} query={holdingsState} />

      <ConfirmDialog
        open={apyRemoveTarget !== null}
        onOpenChange={(open) => {
          if (!open) setApyRemoveTarget(null);
        }}
        title="Remove interest configuration"
        description="Interest will stop accruing on this holding. Payouts already recorded are kept."
        confirmLabel="Remove"
        variant="destructive"
        isPending={removeApyMutation.isPending}
        onConfirm={() => {
          if (apyRemoveTarget) removeApyMutation.mutate({ holdingId: apyRemoveTarget.id });
        }}
      />

      {/* Mounted only while targeted, so each dialog's own form state starts
          from the holding it was opened for rather than from the last one. */}
      {apyTarget ? (
        <ApyConfigDialog
          open
          onOpenChange={(open) => {
            if (!open) setApyTarget(null);
          }}
          holdingId={apyTarget.id}
          existingConfig={apyTarget.apyConfig ?? undefined}
        />
      ) : null}

      {priceTarget ? (
        <EditCustomTokenPriceDialog
          open
          onOpenChange={(open) => {
            if (!open) setPriceTarget(null);
          }}
          tokenId={priceTarget.token.id}
          tokenSymbol={priceTarget.token.symbol}
          currentPrice={priceTarget.price?.value ?? null}
          currentBaseCurrency={currency}
        />
      ) : null}

      <AssignGroupsDialog
        open={assignTarget !== null}
        onOpenChange={(open) => {
          if (open) return;
          // Clearing on close rather than on save: the dialog reports its own
          // outcome, and a selection surviving a cancelled assignment is a
          // banner claiming rows are selected that the user has moved on from.
          assignTarget?.clear();
          setAssignTarget(null);
        }}
        entityType="holdings"
        entityIds={assignTarget?.ids ?? []}
      />
    </PageLayout>
  );
}
