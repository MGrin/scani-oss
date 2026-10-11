import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Button } from '@scani/ui/ui/button';
import { showError, showSuccess } from '@scani/ui/ui/use-toast';
import { V3DataView } from '@scani/ui/v3/components/data-view/V3DataView';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { usePeekRoute } from '@scani/ui/v3/hooks/usePeekRoute';
import { readDataViewUrl } from '@scani/ui/v3/lib/data-view-url';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { Tags } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { AutoCategoryNote } from '../components/categories/AutoCategoryNote';
import { type CategoryNodeView, formatCategoryPath } from '../components/categories/CategoryPicker';
import { CategoryPickerQuery } from '../components/categories/CategoryPickerQuery';
import { FormActions, FormSheet } from '../components/form/FormSheet';
import {
  LEDGER_PAGE_KEY,
  ledgerAccountOptions,
  ledgerConfig,
  ledgerFilterDefs,
  ledgerFiltersFromView,
  ledgerHoldingOptions,
  ledgerListInput,
  setCategoryMessage,
  toLedgerRows,
} from '../components/transactions/ledgerConfig';
import { activityKindLabel } from '../lib/holding-activity';
import { V3_ROUTES } from '../lib/routes';

/**
 * Every ledger row, newest first, filtered on the server and categorized by
 * the person (SC-1652). The filters live in the URL, so a link to "my
 * uncategorized rows in this account" is a link.
 */
export function TransactionsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('v3.transactions.title'));
  const holdings = trpc.holdings.getWithDetails.useQuery();
  const categories = trpc.categories.list.useQuery();
  const accounts = trpc.accounts.getAll.useQuery();
  const nodes: CategoryNodeView[] = categories.data ?? [];
  const holdingList = holdings.data?.holdings ?? [];
  const filterDefs = useMemo(
    () =>
      ledgerFilterDefs({
        nodes,
        accounts: ledgerAccountOptions(accounts.data ?? [], holdingList),
        holdings: ledgerHoldingOptions(holdingList),
      }),
    [nodes, accounts.data, holdingList]
  );

  // The filter sheet writes the URL; the server reads it. Same as Bills' status and period.
  const location = useLocation();
  const filters = ledgerFiltersFromView(
    readDataViewUrl(location.search, LEDGER_PAGE_KEY, filterDefs).filters
  );
  const [search, setSearch] = useState('');
  const { cursor: _cursor, ...listInput } = ledgerListInput(filters, 0);
  const input = { ...listInput, search: search || undefined };
  const ledger = trpc.transactions.list.useInfiniteQuery(input, {
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    keepPreviousData: true,
  });

  const rows = useMemo(
    () =>
      toLedgerRows(
        (ledger.data?.pages ?? []).flatMap((page) => page.transactions),
        holdings.data?.holdings ?? [],
        nodes,
        (row) => activityKindLabel(t, row, new Set())
      ),
    [ledger.data, holdings.data, nodes, t]
  );

  const utils = trpc.useUtils();
  // A pick or a Keep can move the row out of the filtered list. Left open, the
  // peek would then say the row is "not on this list", as if the pick failed.
  // It closes before the refetch, so that message never shows.
  const peekRoute = usePeekRoute(V3_ROUTES.transactions);
  const closePeek = () => {
    if (peekRoute.id !== null) peekRoute.close();
  };
  const setCategory = trpc.transactions.setCategory.useMutation({
    onSuccess: async (result, { categoryId }) => {
      closePeek();
      await Promise.all([utils.transactions.list.invalidate(), utils.categories.list.invalidate()]);
      const { message, context } = setCategoryMessage(
        t,
        result,
        categoryId ? (formatCategoryPath(nodes, categoryId) ?? '') : null
      );
      showSuccess(message, context);
    },
    onError: (error) => showError(error),
  });
  const confirmCategory = trpc.transactions.confirmCategory.useMutation({
    onSuccess: async () => {
      closePeek();
      await utils.transactions.list.invalidate();
      showSuccess(t('v3.categories.auto.kept'));
    },
    onError: (error) => showError(error),
  });

  const [bulk, setBulk] = useState<{ ids: string[]; done: () => void } | null>(null);
  const [bulkCategory, setBulkCategory] = useState<string | null>(null);

  const config = ledgerConfig({
    rows,
    filterDefs,
    onSearch: setSearch,
    emptyAction: (
      <Button asChild>
        <Link to={V3_ROUTES.accounts}>{t('v3.transactions.empty.addAccount')}</Link>
      </Button>
    ),
    peek: (row) => (
      <div className="flex flex-col gap-3">
        <AutoCategoryNote
          setBy={row.categorySetBy}
          payee={row.payee}
          pending={confirmCategory.isPending}
          onKeep={() => confirmCategory.mutate({ ids: [row.id] })}
        />
        <CategoryPickerQuery
          name={`ledger-peek-${row.id}`}
          value={row.categoryId}
          allowClear
          onChange={(categoryId) => setCategory.mutate({ ids: [row.id], categoryId })}
        />
      </div>
    ),
    bulkActions: (selectedIds, clearSelection) => (
      <Button
        variant="outline"
        onClick={() => {
          setBulkCategory(null);
          setBulk({ ids: [...selectedIds], done: clearSelection });
        }}
      >
        <Tags className="me-2 size-4" aria-hidden="true" />
        {t('v3.transactions.bulk.setCategory')}
      </Button>
    ),
  });

  return (
    <PageLayout measure="wide">
      <PageHeader
        title={t('v3.transactions.title')}
        action={
          <Button asChild variant="outline">
            <Link to={V3_ROUTES.categories}>{t('v3.categories.manage')}</Link>
          </Button>
        }
      />

      <V3DataView config={config} getId={(row) => row.id} query={mergeQueries(ledger)} />

      <FormSheet
        open={bulk !== null}
        onOpenChange={(open) => {
          if (!open) setBulk(null);
        }}
        title={t('v3.transactions.bulk.title', { count: bulk?.ids.length ?? 0 })}
        description={t('v3.transactions.bulk.description')}
        footer={
          <FormActions
            submitLabel={
              bulkCategory ? t('v3.transactions.bulk.submit') : t('v3.transactions.bulk.clear')
            }
            pendingLabel={t('v3.transactions.bulk.pending')}
            onSubmit={() => {
              if (!bulk) return;
              setCategory.mutate(
                { ids: bulk.ids, categoryId: bulkCategory },
                {
                  onSuccess: () => {
                    bulk.done();
                    setBulk(null);
                  },
                }
              );
            }}
            onCancel={() => setBulk(null)}
            blockers={[]}
            pending={setCategory.isPending}
            error={null}
          />
        }
      >
        <CategoryPickerQuery
          name="ledger-bulk"
          value={bulkCategory}
          allowClear
          onChange={setBulkCategory}
        />
      </FormSheet>
    </PageLayout>
  );
}
