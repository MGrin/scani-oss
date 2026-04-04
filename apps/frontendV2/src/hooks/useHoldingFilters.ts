import type { HoldingWithDetails } from '@scani/shared';
import { useMemo } from 'react';

export type GroupBy = 'none' | 'institution' | 'account' | 'tokenType';

interface HoldingFilterParams {
  holdings: HoldingWithDetails[];
  searchTerm: string;
  filterBy: string;
  filterByAccount: string;
  filterByToken: string;
  filterByGroup: string;
  valueRange: string;
  sortField: string;
  sortDirection: 'asc' | 'desc';
  groupBy: GroupBy;
  holdingsSummary?: { totalValue: string; activeCount: number } | null;
}

export function useHoldingFilters({
  holdings,
  searchTerm,
  filterBy,
  filterByAccount,
  filterByToken,
  filterByGroup,
  valueRange,
  sortField,
  sortDirection,
  groupBy,
  holdingsSummary,
}: HoldingFilterParams) {
  // Filter and sort holdings
  const filteredAndSortedHoldings = useMemo(() => {
    const filtered = holdings.filter((holding) => {
      const matchesSearch =
        searchTerm === '' ||
        holding.token.symbol.toLowerCase().includes(searchTerm.toLowerCase()) ||
        holding.token.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        holding.institution.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        holding.account.name.toLowerCase().includes(searchTerm.toLowerCase());

      const matchesTypeFilter = filterBy === '' || holding.token.typeCode === filterBy;
      const matchesAccountFilter = filterByAccount === '' || holding.account.id === filterByAccount;
      const matchesTokenFilter = filterByToken === '' || holding.token.symbol === filterByToken;
      const matchesGroupFilter =
        filterByGroup === '' || holding.groups.some((g) => g.id === filterByGroup);

      // Value range filter
      let matchesValueRange = true;
      if (valueRange !== 'all') {
        const value = holding.value;
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
        matchesAccountFilter &&
        matchesTokenFilter &&
        matchesGroupFilter &&
        matchesValueRange
      );
    });

    // Sort holdings
    filtered.sort((a, b) => {
      // biome-ignore lint/suspicious/noExplicitAny: Dynamic sorting requires flexible typing for multiple field types
      let aValue: any, bValue: any;

      switch (sortField) {
        case 'value':
          aValue = a.value;
          bValue = b.value;
          break;
        case 'amount':
          aValue = a.amount;
          bValue = b.amount;
          break;
        case 'name':
          aValue = a.token.name.toLowerCase();
          bValue = b.token.name.toLowerCase();
          break;
        case 'institution':
          aValue = a.institution.name.toLowerCase();
          bValue = b.institution.name.toLowerCase();
          break;
        default:
          aValue = a.value;
          bValue = b.value;
      }

      if (typeof aValue === 'string') {
        return sortDirection === 'asc'
          ? aValue.localeCompare(bValue)
          : bValue.localeCompare(aValue);
      }

      return sortDirection === 'asc' ? aValue - bValue : bValue - aValue;
    });

    return filtered;
  }, [
    holdings,
    searchTerm,
    filterBy,
    filterByAccount,
    filterByToken,
    valueRange,
    sortField,
    sortDirection,
    filterByGroup,
  ]);

  // Group holdings if needed
  const groupedHoldings =
    groupBy === 'none'
      ? { 'All Holdings': filteredAndSortedHoldings }
      : filteredAndSortedHoldings.reduce(
          (groups, holding) => {
            let key = '';
            switch (groupBy) {
              case 'institution':
                key = holding.institution.name;
                break;
              case 'account':
                key = holding.account.name;
                break;
              case 'tokenType':
                key = holding.token.type;
                break;
            }
            if (!groups[key]) groups[key] = [];
            groups[key]!.push(holding);
            return groups;
          },
          {} as Record<string, typeof filteredAndSortedHoldings>
        );

  // Calculate summary statistics
  // Use pre-calculated backend values when no filters are applied
  // Otherwise recalculate from filtered active holdings
  const summaryStats = useMemo(() => {
    const hasFilters =
      searchTerm !== '' ||
      filterBy !== '' ||
      filterByAccount !== '' ||
      filterByToken !== '' ||
      filterByGroup !== '' ||
      valueRange !== 'all';

    if (!hasFilters && holdingsSummary) {
      // No filters: use pre-calculated backend values (excludes inactive holdings)
      return {
        totalValue: parseFloat(holdingsSummary.totalValue),
        holdingCount: holdingsSummary.activeCount,
      };
    }

    // Has filters: recalculate from filtered active holdings
    const activeHoldings = filteredAndSortedHoldings.filter((h) => h.isActive);
    const totalValue = activeHoldings.reduce((sum, h) => sum + h.value, 0);

    return {
      totalValue,
      holdingCount: activeHoldings.length,
    };
  }, [
    filteredAndSortedHoldings,
    holdingsSummary,
    searchTerm,
    filterBy,
    filterByAccount,
    filterByToken,
    filterByGroup,
    valueRange,
  ]);

  // Derive filter options from holdings data
  const filterOptions = useMemo(() => {
    // Deduplicate institutions by ID
    const institutionMap = new Map();
    holdings.forEach((h) => {
      if (!institutionMap.has(h.institution.id)) {
        institutionMap.set(h.institution.id, h.institution);
      }
    });
    const institutions = Array.from(institutionMap.values());

    // Deduplicate accounts by ID
    const accountMap = new Map();
    holdings.forEach((h) => {
      if (!accountMap.has(h.account.id)) {
        accountMap.set(h.account.id, h.account);
      }
    });
    const accounts = Array.from(accountMap.values());

    // Deduplicate token types by code
    const tokenTypeMap = new Map();
    holdings.forEach((h) => {
      if (!tokenTypeMap.has(h.token.typeCode)) {
        tokenTypeMap.set(h.token.typeCode, {
          code: h.token.typeCode,
          name: h.token.type,
        });
      }
    });
    const tokenTypes = Array.from(tokenTypeMap.values());

    // Deduplicate tokens by symbol
    const tokenMap = new Map();
    holdings.forEach((h) => {
      if (!tokenMap.has(h.token.symbol)) {
        tokenMap.set(h.token.symbol, h.token);
      }
    });

    const institutionOptions = institutions.map((inst) => ({
      id: inst.id,
      name: inst.name,
      type: inst.type,
      typeCode: inst.typeCode,
      website: inst.website,
    }));

    const accountOptions = accounts.map((acc) => ({
      id: acc.id,
      name: acc.name,
      typeName: acc.type,
      institutionId: acc.institutionId,
    }));

    const tokenOptions = Array.from(tokenMap.values()).map((token) => ({
      id: token.symbol, // Use symbol as ID for filtering
      symbol: token.symbol,
      name: token.name,
      type: token.typeCode,
      typeName: token.type,
      iconUrl: token.iconUrl,
    }));

    return {
      tokenTypes,
      institutionOptions,
      accountOptions,
      tokenOptions,
    };
  }, [holdings]);

  return {
    filteredAndSortedHoldings,
    groupedHoldings,
    summaryStats,
    filterOptions,
  };
}
