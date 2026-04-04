import { useMemo } from 'react';

export type AccountForFilters = {
  id: string;
  institutionId: string;
  name: string;
  typeId: string;
  summary: {
    holdingsCount: number;
    totalValue: string;
  };
  // biome-ignore lint/suspicious/noExplicitAny: Account type from query includes groups at runtime
  groups: any[];
};

type GroupBy = 'none' | 'institution' | 'type';

interface AccountFiltersInput {
  accounts: AccountForFilters[];
  searchTerm: string;
  filterByType: string;
  filterByInstitution: string;
  filterByGroup: string;
  valueRange: string;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  groupBy: GroupBy;
  institutions: { id: string; name: string }[] | undefined;
  accountTypes: { id: string; name: string }[] | undefined;
}

export function useAccountFilters({
  accounts,
  searchTerm,
  filterByType,
  filterByInstitution,
  filterByGroup,
  valueRange,
  sortField,
  sortDirection,
  groupBy,
  institutions,
  accountTypes,
}: AccountFiltersInput) {
  // Filter and sort accounts
  const filteredAndSortedAccounts = useMemo(() => {
    const filtered = accounts.filter((account) => {
      const institution = institutions?.find((inst) => inst.id === account.institutionId);
      const accountType = accountTypes?.find((type) => type.id === account.typeId);

      const matchesSearch =
        searchTerm === '' ||
        account.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        institution?.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        accountType?.name.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesTypeFilter = filterByType === '' || account.typeId === filterByType;
      const matchesInstitutionFilter =
        filterByInstitution === '' || account.institutionId === filterByInstitution;

      // Group filter - check if account has any groups matching the selected group
      const matchesGroupFilter =
        filterByGroup === '' || account.groups.some((g) => g.id === filterByGroup);

      // Value range filter
      let matchesValueRange = true;
      if (valueRange !== 'all') {
        const value = parseFloat(account.summary.totalValue);
        switch (valueRange) {
          case 'under-1k':
            matchesValueRange = value < 1000;
            break;
          case '1k-10k':
            matchesValueRange = value >= 1000 && value < 10000;
            break;
          case '10k-100k':
            matchesValueRange = value >= 10000 && value < 100000;
            break;
          case 'over-100k':
            matchesValueRange = value >= 100000;
            break;
        }
      }

      return (
        matchesSearch &&
        matchesTypeFilter &&
        matchesInstitutionFilter &&
        matchesGroupFilter &&
        matchesValueRange
      );
    });

    // Sort accounts
    filtered.sort((a, b) => {
      let aValue: number | string, bValue: number | string;

      switch (sortField) {
        case 'value':
          aValue = parseFloat(a.summary.totalValue);
          bValue = parseFloat(b.summary.totalValue);
          break;
        case 'name':
          aValue = a.name.toLowerCase();
          bValue = b.name.toLowerCase();
          break;
        case 'institution': {
          const aInst = institutions?.find((inst) => inst.id === a.institutionId)?.name || '';
          const bInst = institutions?.find((inst) => inst.id === b.institutionId)?.name || '';
          aValue = aInst.toLowerCase();
          bValue = bInst.toLowerCase();
          break;
        }
        default:
          aValue = parseFloat(a.summary.totalValue);
          bValue = parseFloat(b.summary.totalValue);
      }

      if (typeof aValue === 'string') {
        return sortDirection === 'asc'
          ? aValue.localeCompare(bValue as string)
          : (bValue as string).localeCompare(aValue);
      }

      return sortDirection === 'asc'
        ? (aValue as number) - (bValue as number)
        : (bValue as number) - aValue;
    });

    return filtered;
  }, [
    accounts,
    searchTerm,
    filterByType,
    filterByInstitution,
    filterByGroup,
    valueRange,
    sortField,
    sortDirection,
    institutions,
    accountTypes,
  ]);

  // Group accounts if needed
  const groupedAccounts =
    groupBy === 'none'
      ? { 'All Accounts': filteredAndSortedAccounts }
      : filteredAndSortedAccounts.reduce(
          (groups, account) => {
            let key = '';
            switch (groupBy) {
              case 'institution':
                key =
                  institutions?.find((inst) => inst.id === account.institutionId)?.name ||
                  'Unknown Institution';
                break;
              case 'type':
                key =
                  accountTypes?.find((type) => type.id === account.typeId)?.name || 'Unknown Type';
                break;
            }
            if (!groups[key]) groups[key] = [];
            groups[key]!.push(account);
            return groups;
          },
          {} as Record<string, typeof filteredAndSortedAccounts>
        );

  // Calculate summary statistics
  const summaryStats = useMemo(() => {
    const totalValue = filteredAndSortedAccounts.reduce(
      (sum, account) => sum + parseFloat(account.summary.totalValue),
      0
    );

    return {
      totalValue,
      accountCount: filteredAndSortedAccounts.length,
    };
  }, [filteredAndSortedAccounts]);

  return {
    filteredAndSortedAccounts,
    groupedAccounts,
    summaryStats,
  };
}
