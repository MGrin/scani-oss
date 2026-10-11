import type { HoldingWithDetails } from '@scani/shared';
import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { useHoldingActions } from '@/v3/hooks/useHoldingActions';
import { useRelativeTimeTick } from '@/v3/hooks/useRelativeTimeTick';
import { useOpenCapture } from '../components/capture/CaptureSheetContext';
import { AssignGroupsSheet } from '../components/groups/AssignGroupsSheet';
import { ApyConfigSheet } from '../components/holdings/ApyConfigSheet';
import { EditHoldingSheet } from '../components/holdings/EditHoldingSheet';
import { type HandValuedMode, HandValuedSheet } from '../components/holdings/HandValuedSheet';
import { holdingsDataViewConfig } from '../components/holdings/holdingsConfig';
import { RecordMovementSheet } from '../components/holdings/RecordMovementSheet';
import { LiabilityPanel } from '../components/liabilities/LiabilityPanel';
import { EditCustomTokenPriceSheet } from '../components/tokens/EditCustomTokenPriceSheet';
import { useHandValued } from '../hooks/useHandValued';
import { useHoldingRefresh } from '../hooks/useHoldingRefresh';
import { useRecordMovement } from '../hooks/useRecordMovement';
import { HOLDINGS_QUALITY_PARAM } from '../lib/dataQuality';
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
  useRelativeTimeTick();
  const { t } = useTranslation();
  useDocumentTitle(t('v3.holdings.page.title'));
  const holdingsQuery = trpc.holdings.getWithDetails.useQuery();
  const groupsQuery = trpc.groups.getAll.useQuery();
  const baseCurrencyQuery = trpc.users.getBaseCurrency.useQuery();
  // Fetched independently of the holdings so a filter chip can name an
  // institution or account that has no holdings behind it yet — a freshly
  // connected integration that imported nothing would otherwise render its own
  // UUID over an empty list.
  const institutionsQuery = trpc.institutions.getAll.useQuery();
  const accountsQuery = trpc.accounts.getAll.useQuery();

  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  /**
   * The data-quality dimension (SC-293) — the ids behind each flagged counter
   * on the Settings panel, which is where `?quality=<kind>` links come from.
   *
   * The same query key the panel uses, so arriving from it costs nothing: it
   * is already in the cache and inside its 60s staleness window. Fetched on
   * every visit rather than only when the parameter is present, because a
   * filter that exists in Refine only for readers who came via a link is a
   * control that appears and disappears.
   */
  const qualityQuery = trpc.portfolio.getDataQualityReport.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 60_000,
  });
  const qualityParam = searchParams.get(HOLDINGS_QUALITY_PARAM);
  const accountParam = searchParams.get('account');

  // The queries the list actually depends on, collapsed so the error half
  // cannot be dropped (V3-16). `holdings.getWithDetails` failing while the
  // filter dimensions succeed would otherwise render the onboarding empty
  // state over an account that has holdings.
  //
  // The report joins them ONLY when the URL asks for a quality slice. Then it
  // is load-bearing — an unfiltered list rendered while its filter is still
  // loading would show every holding under a chip claiming twelve, and a
  // failed report would show every holding under a chip claiming anything at
  // all. Without the parameter it is an optional extra dimension, and a
  // diagnostics query must not be able to take the Holdings page down.
  const holdingsState = mergeQueries(
    holdingsQuery,
    groupsQuery,
    baseCurrencyQuery,
    institutionsQuery,
    accountsQuery,
    ...(qualityParam ? [qualityQuery] : [])
  );

  const actions = useHoldingActions();
  const refresh = useHoldingRefresh(actions);

  const [apyTarget, setApyTarget] = useState<HoldingWithDetails | null>(null);
  const [priceTarget, setPriceTarget] = useState<HoldingWithDetails | null>(null);
  /**
   * The holding being edited (SC-1436). Mounted at this level rather than in
   * the peek drawer, for the reason interest and manual price are: a sheet
   * opened from inside the drawer is torn down by the drawer's own dismiss.
   */
  const [editTarget, setEditTarget] = useState<HoldingWithDetails | null>(null);
  const [assignTarget, setAssignTarget] = useState<{ ids: string[]; clear: () => void } | null>(
    null
  );
  /**
   * The holding a movement is being recorded against (SC-607).
   *
   * Mounted here rather than inside the peek for the same reason the edit
   * sheet is: a Radix dialog opened from inside the drawer is torn down by
   * the drawer's own dismiss.
   */
  const [movementTarget, setMovementTarget] = useState<HoldingWithDetails | null>(null);
  const [handValuedTarget, setHandValuedTarget] = useState<{
    holding: HoldingWithDetails;
    mode: HandValuedMode;
  } | null>(null);

  const holdings = holdingsQuery.data?.holdings ?? [];
  const currency = baseCurrencyQuery.data?.symbol || 'USD';

  // Read once, at mount: `useDataView` seeds its filter state from this, and a
  // later change is the user's own filtering rather than the link's.
  const defaultFilters = useMemo(() => holdingFiltersFromParams(searchParams), [searchParams]);

  /**
   * The holdings a pot name has work to do on: those sharing an
   * (account, token) with at least one sibling.
   *
   * Computed here because only the page holds the whole list — the peek is
   * handed one holding and cannot see the others. Keyed on `account.id` and
   * `token.id` rather than on the account NAME or the token SYMBOL: two users'
   * accounts can share a name and two different tokens can share a symbol, and
   * grouping on either turned two real groups into nine on production
   * (SC-564).
   */
  const contestedHoldingIds = useMemo(() => {
    const counts = new Map<string, number>();
    for (const holding of holdings) {
      const key = `${holding.account.id}\u0000${holding.token.id}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return new Set(
      holdings
        .filter(
          (holding) => (counts.get(`${holding.account.id}\u0000${holding.token.id}`) ?? 0) > 1
        )
        .map((holding) => holding.id)
    );
  }, [holdings]);

  const openCapture = useOpenCapture();
  const movement = useRecordMovement(() => setMovementTarget(null));
  const handValued = useHandValued(() => setHandValuedTarget(null));

  const config = holdingsDataViewConfig({
    holdings,
    currency,
    institutions: institutionsQuery.data,
    accounts: accountsQuery.data,
    groups: groupsQuery.data,
    defaultFilters,
    qualitySets: qualityQuery.data?.flagged,
    onAssignGroups: (ids, clear) => setAssignTarget({ ids, clear }),
    // The confirmation is `BulkDeleteAction`'s, inline in the bar the trigger
    // is in (SC-63) — by the time this runs the user has read what goes and
    // pressed a differently-labelled second button, so this is the write.
    onBulkDelete: (ids, clear) => actions.bulkDeleteHoldings(ids, { onSuccess: clear }),
    isBulkDeleting: actions.isBulkDeleting,
    onAddData: openCapture,
    t,
    peek: {
      currency,
      t,
      onEdit: setEditTarget,
      onToggleActive: (holding) =>
        actions.updateHolding(holding.id, { isActive: !holding.isActive }),
      isTogglingActive: actions.isUpdating,
      onMarkScam: (holding) => actions.markScam(holding.token.id, holding.token.symbol),
      isMarkingScam: actions.isMarkingScam,
      onRefreshPrice: refresh.refreshPrice,
      onRefreshBalance: refresh.refreshBalance,
      refreshingPriceId: refresh.refreshingPriceId,
      refreshingBalanceId: refresh.refreshingBalanceId,
      onEditPrice: setPriceTarget,
      onRecordMovement: setMovementTarget,
      onUpdateValue: (holding) => setHandValuedTarget({ holding, mode: 'value' }),
      onMoveMoney: (holding) => setHandValuedTarget({ holding, mode: 'money' }),
      contestedHoldingIds,
      onConfigureApy: setApyTarget,
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
      <PageHeader title={t('v3.holdings.page.title')} />

      {/* A loan or card account shows what is owed and when it is paid off (SC-1640). */}
      {accountParam ? <LiabilityPanel accountId={accountParam} /> : null}

      <V3DataView config={config} getId={(item) => item.id} query={holdingsState} />

      {/* Mounted only while targeted, so each dialog's own form state starts
          from the holding it was opened for rather than from the last one. */}
      {apyTarget ? (
        <ApyConfigSheet
          // Keyed as well as mounted conditionally: the sheet reads its whole
          // form state from this holding once, at mount, and has no reset
          // effect to fall back on if a second holding ever arrived through
          // the same element.
          key={apyTarget.id}
          open
          onOpenChange={(open) => {
            if (!open) setApyTarget(null);
          }}
          holding={apyTarget}
        />
      ) : null}

      {editTarget ? (
        <EditHoldingSheet
          // Keyed for the reason `ApyConfigSheet` is: the sheet seeds its
          // fields and the cause answer once, at mount.
          key={editTarget.id}
          holding={editTarget}
          showPot={Boolean(editTarget.label) || contestedHoldingIds.has(editTarget.id)}
          onOpenChange={(open) => {
            if (!open) setEditTarget(null);
          }}
          // A quantity edit on a holding we fetch a price for is unambiguously
          // a flow, so the server derives the cause there; the sheet asks it
          // everywhere else (`manualEditNeedsCause`, SC-510) and sends the
          // answer with the balance, and a rename carries none (SC-564).
          onSave={(edit) => actions.updateHolding(editTarget.id, edit)}
        />
      ) : null}

      {movementTarget ? (
        <RecordMovementSheet
          // Keyed like the cause dialog: the sheet seeds its amount, date and
          // answer once at mount, so a second holding must not inherit the
          // first one's half-filled form.
          key={movementTarget.id}
          open
          onOpenChange={(open) => {
            if (!open) setMovementTarget(null);
          }}
          holding={movementTarget}
          isSaving={movement.isSaving}
          error={movement.error}
          onSubmit={movement.submit}
        />
      ) : null}

      {handValuedTarget ? (
        <HandValuedSheet
          // Keyed like the movement sheet: a second holding must not inherit
          // the first one's half-typed amount.
          key={`${handValuedTarget.holding.id}-${handValuedTarget.mode}`}
          mode={handValuedTarget.mode}
          onOpenChange={(open) => {
            if (!open) setHandValuedTarget(null);
          }}
          currency={currency}
          isSaving={handValued.isSaving}
          error={handValued.error}
          onSubmitValue={(draft) =>
            handValued.submitValue(handValuedTarget.holding.id, currency, draft)
          }
          onSubmitMoney={(draft) =>
            handValued.submitMoney(handValuedTarget.holding.id, currency, draft)
          }
        />
      ) : null}

      {priceTarget ? (
        <EditCustomTokenPriceSheet
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

      {/* Mounted only while targeted, for the reason written above the two
          dialogs: the checked set has to start from the selection this was
          opened for. Left mounted, the sheet reopened with the PREVIOUS batch's
          groups ticked over an empty diff baseline, and a Save in that window
          put those groups onto holdings that were never in them. */}
      {assignTarget ? (
        <AssignGroupsSheet
          open
          onOpenChange={(open) => {
            if (open) return;
            // Clearing on close rather than on save: the sheet reports its own
            // outcome, and a selection surviving a cancelled assignment is a
            // banner claiming rows are selected that the user has moved on from.
            assignTarget.clear();
            setAssignTarget(null);
          }}
          entityType="holdings"
          entityIds={assignTarget.ids}
        />
      ) : null}
    </PageLayout>
  );
}
