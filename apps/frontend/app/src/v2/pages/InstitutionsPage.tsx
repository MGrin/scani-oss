import { formatCurrency } from '@scani/shared';
import { FaviconImg } from '@scani/ui/components/FaviconImg';
import { CardInteractive } from '@scani/ui/ui/card';
import { Building2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { getFaviconUrl } from '@/lib/icons';
import { trpc } from '@/lib/trpc';
import { DataView as DataViewComponent } from '../components/data-view/DataView';
import type { ColumnDef } from '../components/data-view/DataViewTable';
import { useBaseCurrency } from '../hooks/useBaseCurrency';
import { V2_ROUTES } from '../lib/routes';

// Institution type from the query result
interface InstitutionWithSummary {
  id: string;
  name: string;
  description: string | null;
  website: string | null;
  typeId: string;
  summary?: {
    accountCount: number;
    totalValue: string;
  };
}

function InstitutionIcon({ name, website }: { name: string; website?: string | null }) {
  const favicon = getFaviconUrl(website);
  if (favicon) {
    return (
      <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center shrink-0 overflow-hidden">
        <FaviconImg
          src={favicon}
          name={name}
          className="h-5 w-5 object-contain"
          fallbackClassName="text-xs font-bold text-muted-foreground"
        />
      </div>
    );
  }
  return (
    <div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
      <Building2 className="h-4 w-4 text-muted-foreground" />
    </div>
  );
}

function InstitutionCard({
  item,
  currency,
}: {
  item: InstitutionWithSummary;
  isSelected: boolean;
  onSelect: (id: string) => void;
  currency: string;
}) {
  return (
    <CardInteractive className="p-4">
      <div className="flex items-center gap-3">
        <InstitutionIcon name={item.name} website={item.website} />
        <div className="min-w-0 flex-1">
          <p className="font-medium text-sm truncate">{item.name}</p>
          <p className="text-xs text-muted-foreground">
            {item.summary?.accountCount ?? 0} accounts
          </p>
        </div>
        <div className="text-right shrink-0">
          <p className="text-sm font-semibold tabular-nums">
            {formatCurrency(Number(item.summary?.totalValue ?? 0), currency, { decimals: 0 })}
          </p>
        </div>
      </div>
    </CardInteractive>
  );
}

export function InstitutionsPage() {
  const navigate = useNavigate();
  const { data: institutionsData, isLoading } = trpc.institutions.getByUserIdWithSummary.useQuery();
  const { data: institutionTypes } = trpc.institutionTypes.getAll.useQuery();
  const { symbol: currencySymbol } = useBaseCurrency();

  const institutions = (institutionsData ?? []) as InstitutionWithSummary[];

  const typeOptions = institutionTypes?.map((t) => ({ label: t.name, value: t.id })) ?? [];

  const columns: ColumnDef<InstitutionWithSummary>[] = [
    {
      key: 'name',
      label: 'Name',
      sortable: true,
      render: (item) => (
        <span className="inline-flex items-center gap-2">
          <InstitutionIcon name={item.name} website={item.website} />
          <span className="font-medium text-sm">{item.name}</span>
        </span>
      ),
    },
    {
      key: 'accounts',
      label: 'Accounts',
      align: 'right',
      sortable: true,
      render: (item) => <span className="tabular-nums">{item.summary?.accountCount ?? 0}</span>,
    },
    {
      key: 'totalValue',
      label: 'Total Value',
      align: 'right',
      sortable: true,
      render: (item) => (
        <span className="font-medium tabular-nums">
          {formatCurrency(Number(item.summary?.totalValue ?? 0), currencySymbol, { decimals: 0 })}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Institutions</h2>
        <p className="text-muted-foreground mt-1">
          {isLoading ? '' : `${institutions.length} institutions`}
        </p>
      </div>

      <DataViewComponent
        config={{
          pageKey: 'institutions',
          data: institutions,
          searchFn: (item, query) => {
            const q = query.toLowerCase();
            return (
              item.name.toLowerCase().includes(q) ||
              (item.description?.toLowerCase().includes(q) ?? false)
            );
          },
          filterDefs:
            typeOptions.length > 0
              ? [
                  {
                    key: 'type',
                    label: 'Type',
                    options: typeOptions,
                    fn: (item: InstitutionWithSummary, value: string) => item.typeId === value,
                  },
                ]
              : [],
          sortDefs: [
            { key: 'totalValue', label: 'Total Value' },
            { key: 'name', label: 'Name' },
            { key: 'accounts', label: 'Accounts' },
          ],
          sortFn: (a, b, field, dir) => {
            const mult = dir === 'asc' ? 1 : -1;
            switch (field) {
              case 'totalValue':
                return (
                  (Number(a.summary?.totalValue ?? 0) - Number(b.summary?.totalValue ?? 0)) * mult
                );
              case 'name':
                return a.name.localeCompare(b.name) * mult;
              case 'accounts':
                return ((a.summary?.accountCount ?? 0) - (b.summary?.accountCount ?? 0)) * mult;
              default:
                return 0;
            }
          },
          defaultSort: { field: 'totalValue', direction: 'desc' },
          defaultView: 'cards',
        }}
        columns={columns}
        renderCard={(item, isSelected, onSelect) => (
          <InstitutionCard
            item={item}
            isSelected={isSelected}
            onSelect={onSelect}
            currency={currencySymbol}
          />
        )}
        onRowClick={(item) => navigate(V2_ROUTES.institutionDetail(item.id))}
        getId={(item) => item.id}
        isLoading={isLoading}
        emptyState={
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Building2 className="h-10 w-10 text-muted-foreground mb-3" />
            <h3 className="text-lg font-semibold">No institutions</h3>
            <p className="text-sm text-muted-foreground mt-1">
              Add data to see your institutions here
            </p>
          </div>
        }
      />
    </div>
  );
}
