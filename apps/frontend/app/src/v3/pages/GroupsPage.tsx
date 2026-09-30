import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Button } from '@scani/ui/ui/button';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { CreateGroupSheet } from '../components/groups/CreateGroupSheet';
import { GroupsList } from '../components/groups/GroupsList';

/**
 * The user's own labels across holdings, accounts, bills and payees. Creating
 * one is a `FormSheet` (UI standard rule 3); it asks only for a name and a
 * colour, then lands on the group's page, where members are added.
 */
export function GroupsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('v3.groups.page.title'));
  const groupsQuery = trpc.groups.getAllWithCounts.useQuery();
  const valuesQuery = trpc.groups.getValues.useQuery();
  const [creating, setCreating] = useState(false);

  return (
    <PageLayout measure="wide">
      <PageHeader
        title={t('v3.groups.page.title')}
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus className="me-1.5 size-4" aria-hidden="true" />
            {t('v3.groups.page.newGroup')}
          </Button>
        }
      />
      <GroupsList
        groups={groupsQuery.data ?? []}
        values={valuesQuery.data?.groups ?? []}
        baseCurrency={valuesQuery.data?.baseCurrency ?? 'USD'}
        // Not merged with the values query: the list is renderable the moment
        // the names arrive, and holding the whole surface back on a
        // whole-portfolio valuation to fill one column is the wrong trade.
        query={mergeQueries(groupsQuery)}
        onCreate={() => setCreating(true)}
      />
      <CreateGroupSheet open={creating} onOpenChange={setCreating} />
    </PageLayout>
  );
}
