import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { trpc } from '@/lib/trpc';
import { useAccountActions } from '@/v3/hooks/useAccountActions';
import { AccountsList } from '../components/entities/AccountsList';
import { AssignGroupsSheet } from '../components/groups/AssignGroupsSheet';
import { accountFiltersFromParams } from '../lib/accounts';

/**
 * The accounts a portfolio is held in.
 *
 * The queries, the group dialog and the mutations; the list itself is
 * `AccountsList`. That dialog is mounted here rather than inside the peek for
 * the reason `HoldingsPage` gives: a Radix dialog opened from inside the drawer
 * is torn down by that drawer's own dismiss. Bulk delete used to be a second
 * dialog beside it; SC-63 moved the question inline, into the bar the trigger
 * lives in, so both list surfaces now ask it the one way.
 *
 * `useBaseCurrency()` rather than a `users.getBaseCurrency` query — V3-30
 * hoisted the provider above the v2/v3 split precisely so v3 stops issuing its
 * own copy of it on every surface.
 */
export function AccountsPage() {
  const { t } = useTranslation();
  const accountsQuery = trpc.accounts.getByUserIdWithSummary.useQuery();
  const groupsQuery = trpc.groups.getAll.useQuery();
  const institutionsQuery = trpc.institutions.getByUserId.useQuery();
  const accountTypesQuery = trpc.accountTypes.getAll.useQuery();

  const [searchParams] = useSearchParams();
  const { symbol: currency } = useBaseCurrency();
  const actions = useAccountActions();

  const [assignTarget, setAssignTarget] = useState<{ ids: string[]; clear: () => void } | null>(
    null
  );

  // Read once, at mount: `useDataView` seeds its filter state from this, and a
  // later change is the user's own filtering rather than the link's.
  const defaultFilters = useMemo(() => accountFiltersFromParams(searchParams), [searchParams]);

  return (
    <PageLayout measure="wide">
      <PageHeader title={t('v3.entities.account.pageTitle')} />

      <AccountsList
        accounts={accountsQuery.data ?? []}
        currency={currency}
        institutions={institutionsQuery.data}
        accountTypes={accountTypesQuery.data}
        groups={groupsQuery.data}
        defaultFilters={defaultFilters}
        query={mergeQueries(accountsQuery)}
        onAssignGroups={(ids, clear) => setAssignTarget({ ids, clear })}
        // The confirmation is `BulkDeleteAction`'s, inline in the bulk bar
        // (SC-63) — this is the write it commits to.
        onBulkDelete={(ids, clear) => actions.bulkDelete(ids, { onSuccess: clear })}
        isBulkDeleting={actions.isBulkDeleting}
      />

      {/* Mounted only while targeted, so the checked set starts from the
          selection it was opened for. Left mounted, the sheet reopened with the
          PREVIOUS batch's groups ticked and an empty diff baseline under them,
          and a Save in that window put those groups onto rows never in them. */}
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
          entityType="accounts"
          entityIds={assignTarget.ids}
        />
      ) : null}
    </PageLayout>
  );
}
