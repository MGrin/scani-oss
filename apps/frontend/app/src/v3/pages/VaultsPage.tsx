import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Button } from '@scani/ui/ui/button';
import { PageHeader, PageLayout } from '@scani/ui/v3/components/PageLayout';
import { mergeQueries } from '@scani/ui/v3/lib/query-state';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { CreateVaultSheet } from '../components/vaults/CreateVaultSheet';
import { VaultsList } from '../components/vaults/VaultsList';

/**
 * Savings goals. Creating one is a `FormSheet` (UI standard rule 3) that lands
 * on the vault's page, where holdings are attached against the goal.
 */
export function VaultsPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('v3.vaults.page.title'));
  const vaultsQuery = trpc.vaults.getAll.useQuery();
  const [creating, setCreating] = useState(false);

  return (
    <PageLayout measure="wide">
      <PageHeader
        title={t('v3.vaults.page.title')}
        action={
          <Button onClick={() => setCreating(true)}>
            <Plus className="me-1.5 size-4" aria-hidden="true" />
            {t('v3.vaults.page.newVault')}
          </Button>
        }
      />
      <VaultsList
        vaults={vaultsQuery.data ?? []}
        query={mergeQueries(vaultsQuery)}
        onCreate={() => setCreating(true)}
      />
      <CreateVaultSheet open={creating} onOpenChange={setCreating} />
    </PageLayout>
  );
}
