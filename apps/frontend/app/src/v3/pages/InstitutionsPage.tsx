import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { useBaseCurrency } from '@/contexts/BaseCurrencyContext';
import { trpc } from '@/lib/trpc';
import { InstitutionsList } from '../components/entities/InstitutionsList';
import type { InstitutionRow } from '../lib/accounts';

/**
 * Where the portfolio is held.
 *
 * No dialogs and no mutations: an institution is created by an import or an
 * integration and has nothing on it a user edits, which is why this page is
 * two queries and a list.
 */
export function InstitutionsPage() {
  const institutionsQuery = trpc.institutions.getByUserIdWithSummary.useQuery();
  const typesQuery = trpc.institutionTypes.getAll.useQuery();
  const { symbol: currency } = useBaseCurrency();

  return (
    <PageLayout measure="wide">
      <PageHeader title="Institutions" />
      <InstitutionsList
        institutions={(institutionsQuery.data ?? []) as InstitutionRow[]}
        currency={currency}
        types={typesQuery.data}
        query={mergeQueries(institutionsQuery)}
      />
    </PageLayout>
  );
}
