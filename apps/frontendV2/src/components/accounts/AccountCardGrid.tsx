import type { Token } from '@scani/shared';
import { Edit, Trash2 } from 'lucide-react';
import { AccountCard } from '@/components/accounts/AccountCard';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

interface AccountCardGridProps {
  accounts: {
    id: string;
    institutionId: string;
    name: string;
    typeId: string;
    summary: {
      holdingsCount: number;
      totalValue: string;
    };
    // biome-ignore lint/suspicious/noExplicitAny: Account type doesn't know about groups at compile time
    groups: any[];
  }[];
  institutions: { id: string; name: string; website: string | null }[] | undefined;
  accountTypes: { id: string; name: string }[] | undefined;
  baseCurrencyToken: Token;
  selectedRows: Set<string>;
  bulkDeletePending: boolean;
  onSelectRow: (id: string) => void;
  onNavigate: (id: string) => void;
  onBulkEditGroups: () => void;
  onBulkDelete: () => void;
}

export function AccountCardGrid({
  accounts,
  institutions,
  accountTypes,
  baseCurrencyToken,
  selectedRows,
  bulkDeletePending,
  onSelectRow,
  onNavigate,
  onBulkEditGroups,
  onBulkDelete,
}: AccountCardGridProps) {
  return (
    <>
      {selectedRows.size > 0 && (
        <Card className="mb-4">
          <CardContent className="py-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">
                {selectedRows.size} account
                {selectedRows.size !== 1 ? 's' : ''} selected
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={onBulkEditGroups}>
                  <Edit className="h-4 w-4 mr-2" />
                  Edit Selected
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={onBulkDelete}
                  disabled={bulkDeletePending}
                >
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Selected
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2 lg:grid-cols-3">
        {accounts.map((account) => {
          const institution = institutions?.find((inst) => inst.id === account.institutionId);
          const accountType = accountTypes?.find((type) => type.id === account.typeId);

          return (
            <AccountCard
              key={account.id}
              account={account}
              institution={institution}
              accountTypeName={accountType?.name || 'Unknown'}
              isSelected={selectedRows.has(account.id)}
              baseCurrencyToken={baseCurrencyToken}
              onSelect={onSelectRow}
              onNavigate={onNavigate}
            />
          );
        })}
      </div>
    </>
  );
}
