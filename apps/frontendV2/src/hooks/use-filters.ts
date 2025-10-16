import { useCallback, useState } from 'react';

export interface FilterConfig {
  key: string;
  defaultValue: string;
}

export interface UseFiltersReturn {
  filters: Record<string, string>;
  updateFilter: (key: string, value: string) => void;
  clearAllFilters: () => void;
  hasActiveFilters: boolean;
}

export function useFilters(filterConfigs: FilterConfig[]): UseFiltersReturn {
  // Initialize filters with default values
  const initialFilters = filterConfigs.reduce(
    (acc, config) => {
      acc[config.key] = config.defaultValue;
      return acc;
    },
    {} as Record<string, string>
  );

  const [filters, setFilters] = useState<Record<string, string>>(initialFilters);

  const updateFilter = useCallback((key: string, value: string) => {
    setFilters((prev) => ({
      ...prev,
      [key]: value,
    }));
  }, []);

  const clearAllFilters = useCallback(() => {
    setFilters(initialFilters);
  }, [initialFilters]);

  // Check if any filter has a non-default value
  const hasActiveFilters = filterConfigs.some((config) => {
    const currentValue = filters[config.key];
    return currentValue !== config.defaultValue;
  });

  return {
    filters,
    updateFilter,
    clearAllFilters,
    hasActiveFilters,
  };
}
