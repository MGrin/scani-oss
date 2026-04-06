import type { AccountWihSumaryDTO, HoldingWithDetails } from '@scani/shared';
import type { ColumnDef } from '../components/data-view/DataViewTable';
import type { DataViewConfig, FilterDef, GroupByDef, SortDef } from '../hooks/useDataView';

// -- Holdings --

export const holdingSortDefs: SortDef[] = [
  { key: 'symbol', label: 'Symbol' },
  { key: 'value', label: 'Value' },
  { key: 'amount', label: 'Amount' },
  { key: 'account', label: 'Account' },
  { key: 'institution', label: 'Institution' },
  { key: 'lastUpdated', label: 'Last Updated' },
];

export const holdingGroupByDefs: GroupByDef[] = [
  {
    key: 'account',
    label: 'Account',
    groupFn: (item) => (item as HoldingWithDetails).account.name,
  },
  {
    key: 'institution',
    label: 'Institution',
    groupFn: (item) => (item as HoldingWithDetails).institution.name,
  },
  {
    key: 'tokenType',
    label: 'Token Type',
    groupFn: (item) => (item as HoldingWithDetails).token.type,
  },
];

export function buildHoldingFilterDefs(holdings: HoldingWithDetails[]): FilterDef[] {
  const accounts = new Map<string, string>();
  const institutions = new Map<string, string>();
  const tokenTypes = new Map<string, string>();

  for (const h of holdings) {
    accounts.set(h.account.id, h.account.name);
    institutions.set(h.institution.id, h.institution.name);
    tokenTypes.set(h.token.typeCode, h.token.type);
  }

  const defs: FilterDef[] = [];

  if (accounts.size > 1) {
    defs.push({
      key: 'accountId',
      label: 'Account',
      options: Array.from(accounts.entries()).map(([value, label]) => ({ value, label })),
    });
  }

  if (institutions.size > 1) {
    defs.push({
      key: 'institutionId',
      label: 'Institution',
      options: Array.from(institutions.entries()).map(([value, label]) => ({ value, label })),
    });
  }

  if (tokenTypes.size > 1) {
    defs.push({
      key: 'tokenTypeCode',
      label: 'Type',
      options: Array.from(tokenTypes.entries()).map(([value, label]) => ({ value, label })),
    });
  }

  return defs;
}

export function holdingSearchFn(item: HoldingWithDetails, query: string): boolean {
  return (
    item.token.symbol.toLowerCase().includes(query) ||
    item.token.name.toLowerCase().includes(query) ||
    item.account.name.toLowerCase().includes(query) ||
    item.institution.name.toLowerCase().includes(query)
  );
}

function holdingFilterAccessor(item: HoldingWithDetails, key: string): string {
  if (key === 'accountId') return item.account.id;
  if (key === 'institutionId') return item.institution.id;
  if (key === 'tokenTypeCode') return item.token.typeCode;
  return '';
}

export function holdingSortFn(
  a: HoldingWithDetails,
  b: HoldingWithDetails,
  field: string,
  direction: 'asc' | 'desc'
): number {
  const dir = direction === 'asc' ? 1 : -1;
  switch (field) {
    case 'symbol':
      return a.token.symbol.localeCompare(b.token.symbol) * dir;
    case 'value':
      return (a.value - b.value) * dir;
    case 'amount':
      return (a.amount - b.amount) * dir;
    case 'account':
      return a.account.name.localeCompare(b.account.name) * dir;
    case 'institution':
      return a.institution.name.localeCompare(b.institution.name) * dir;
    case 'lastUpdated':
      return (new Date(a.lastUpdated).getTime() - new Date(b.lastUpdated).getTime()) * dir;
    default:
      return 0;
  }
}

export function buildHoldingsConfig(
  holdings: HoldingWithDetails[]
): DataViewConfig<HoldingWithDetails> {
  return {
    pageKey: 'holdings',
    data: holdings,
    searchFn: holdingSearchFn,
    filterDefs: buildHoldingFilterDefs(holdings),
    sortDefs: holdingSortDefs,
    sortFn: holdingSortFn,
    groupByDefs: holdingGroupByDefs,
    defaultSort: { field: 'value', direction: 'desc' },
    defaultView: 'table',
  };
}

// Custom filter override: for holdings, filters reference nested IDs, not top-level keys
export function filterHolding(item: HoldingWithDetails, filters: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(filters)) {
    if (!value) continue;
    if (holdingFilterAccessor(item, key) !== value) return false;
  }
  return true;
}

// -- Holdings columns --

export const holdingColumns: ColumnDef<HoldingWithDetails>[] = [
  {
    key: 'symbol',
    header: 'Token',
    sortable: true,
    width: 'w-[200px]',
    render: () => null, // Placeholder - pages should provide their own render with badges
  },
  {
    key: 'amount',
    header: 'Amount',
    sortable: true,
    className: 'text-right',
    render: (item) => item.amount.toLocaleString(undefined, { maximumFractionDigits: 6 }),
  },
  {
    key: 'value',
    header: 'Value ($)',
    sortable: true,
    className: 'text-right',
    render: (item) =>
      item.value.toLocaleString(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
      }),
  },
  {
    key: 'price',
    header: 'Price',
    className: 'text-right',
    render: (item) =>
      item.price
        ? Number(item.price.value).toLocaleString(undefined, {
            style: 'currency',
            currency: 'USD',
            minimumFractionDigits: 2,
          })
        : '-',
  },
  {
    key: 'account',
    header: 'Account',
    sortable: true,
    render: (item) => item.account.name,
  },
  {
    key: 'institution',
    header: 'Institution',
    sortable: true,
    render: (item) => item.institution.name,
  },
  {
    key: 'groups',
    header: 'Groups',
    render: () => null, // Placeholder - pages should provide badge rendering
  },
  {
    key: 'status',
    header: 'Status',
    render: () => null, // Placeholder - pages should render active/inactive badge
  },
];

// -- Accounts --

export const accountSortDefs: SortDef[] = [
  { key: 'name', label: 'Name' },
  { key: 'institution', label: 'Institution' },
  { key: 'totalValue', label: 'Total Value' },
  { key: 'holdingsCount', label: 'Holdings' },
];

export const accountGroupByDefs: GroupByDef[] = [
  {
    key: 'institution',
    label: 'Institution',
    groupFn: () => 'Unknown', // Account DTO doesn't have institution name inline; override in page
  },
];

export function accountSearchFn(item: AccountWihSumaryDTO, query: string): boolean {
  return (
    item.name.toLowerCase().includes(query) ||
    (item.description?.toLowerCase().includes(query) ?? false)
  );
}

export function accountSortFn(
  a: AccountWihSumaryDTO,
  b: AccountWihSumaryDTO,
  field: string,
  direction: 'asc' | 'desc'
): number {
  const dir = direction === 'asc' ? 1 : -1;
  switch (field) {
    case 'name':
      return a.name.localeCompare(b.name) * dir;
    case 'totalValue':
      return (Number(a.summary.totalValue) - Number(b.summary.totalValue)) * dir;
    case 'holdingsCount':
      return (a.summary.holdingsCount - b.summary.holdingsCount) * dir;
    default:
      return 0;
  }
}

export function buildAccountsConfig(
  accounts: AccountWihSumaryDTO[]
): DataViewConfig<AccountWihSumaryDTO> {
  return {
    pageKey: 'accounts',
    data: accounts,
    searchFn: accountSearchFn,
    sortDefs: accountSortDefs,
    sortFn: accountSortFn,
    groupByDefs: accountGroupByDefs,
    defaultSort: { field: 'totalValue', direction: 'desc' },
    defaultView: 'table',
  };
}

// -- Accounts columns --

export const accountColumns: ColumnDef<AccountWihSumaryDTO>[] = [
  {
    key: 'name',
    header: 'Name',
    sortable: true,
    width: 'w-[200px]',
    render: (item) => item.name,
  },
  {
    key: 'type',
    header: 'Type',
    render: () => null, // Placeholder - page provides lookup from typeId
  },
  {
    key: 'holdingsCount',
    header: 'Holdings',
    sortable: true,
    className: 'text-right',
    render: (item) => item.summary.holdingsCount,
  },
  {
    key: 'totalValue',
    header: 'Total Value',
    sortable: true,
    className: 'text-right',
    render: (item) =>
      Number(item.summary.totalValue).toLocaleString(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
      }),
  },
  {
    key: 'groups',
    header: 'Groups',
    render: () => null, // Placeholder - page provides badge rendering
  },
];
