import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

export interface FilterConfig {
  key: string;
  defaultValue: string;
  clearValue?: string; // Default is 'all'
}

export interface UseFiltersReturn {
  filters: Record<string, string>;
  updateFilter: (key: string, value: string) => void;
  clearAllFilters: () => void;
  clearFilter: (key: string) => void;
  hasActiveFilters: boolean;
}

/**
 * Custom hook for managing URL-synchronized filters
 * Automatically handles:
 * - URL param synchronization
 * - Adding/removing params when values change to clear state
 * - Centralized filter state management
 */
export function useFilters(configs: FilterConfig[]): UseFiltersReturn {
  const [searchParams, setSearchParams] = useSearchParams();

  // Create a stable reference to configs to prevent infinite loops
  const configsRef = useRef(configs);
  configsRef.current = configs;

  // Initialize filter state from URL params on first render only
  const [filters, setFilters] = useState<Record<string, string>>(() => {
    const initialFilters: Record<string, string> = {};
    configs.forEach(({ key, defaultValue }) => {
      initialFilters[key] = searchParams.get(key) || defaultValue;
    });
    return initialFilters;
  });

  // Sync state when URL params change
  useEffect(() => {
    const currentConfigs = configsRef.current;
    const newFilters: Record<string, string> = {};
    currentConfigs.forEach(({ key, defaultValue }) => {
      newFilters[key] = searchParams.get(key) || defaultValue;
    });

    // Only update if there's actually a change
    setFilters((prevFilters) => {
      // Check if we need to update at all
      let hasChanged = false;
      for (const key of Object.keys(newFilters)) {
        if (prevFilters[key] !== newFilters[key]) {
          hasChanged = true;
          break;
        }
      }
      return hasChanged ? newFilters : prevFilters;
    });
  }, [searchParams]);

  // Update a single filter and sync with URL
  const updateFilter = useCallback(
    (key: string, value: string) => {
      // Find the config for this key using the ref
      const config = configsRef.current.find((c) => c.key === key);
      if (!config) return;

      const clearValue = config.clearValue || 'all';

      setFilters((prev) => ({ ...prev, [key]: value }));

      // Update URL params
      setSearchParams((currentParams) => {
        const newParams = new URLSearchParams(currentParams);
        if (value === clearValue) {
          newParams.delete(key);
        } else {
          newParams.set(key, value);
        }
        return newParams;
      });
    },
    [setSearchParams]
  );

  // Clear all filters
  const clearAllFilters = useCallback(() => {
    const clearedFilters: Record<string, string> = {};
    configsRef.current.forEach(({ key, defaultValue }) => {
      clearedFilters[key] = defaultValue;
    });

    setFilters(clearedFilters);

    // Remove all filter params from URL
    setSearchParams((currentParams) => {
      const newParams = new URLSearchParams(currentParams);
      configsRef.current.forEach(({ key }) => {
        newParams.delete(key);
      });
      return newParams;
    });
  }, [setSearchParams]);

  // Clear a specific filter
  const clearFilter = useCallback(
    (key: string) => {
      const config = configsRef.current.find((c) => c.key === key);
      if (!config) return;

      updateFilter(key, config.defaultValue);
    },
    [updateFilter]
  );

  // Check if any filters are active
  const hasActiveFilters = Object.entries(filters).some(([key, value]) => {
    const config = configsRef.current.find((c) => c.key === key);
    if (!config) return false;
    const clearValue = config.clearValue || 'all';
    return value !== clearValue && value !== config.defaultValue;
  });

  return {
    filters,
    updateFilter,
    clearAllFilters,
    clearFilter,
    hasActiveFilters,
  };
}
