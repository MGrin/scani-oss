import type { AssetAllocationDimension } from '@scani/shared';
import { useEffect, useState } from 'react';

type VisualizationType = 'list' | 'bar' | 'donut';

interface AssetAllocationPreferences {
  dimension: AssetAllocationDimension;
  visualizationType: VisualizationType;
}

const ASSET_ALLOCATION_STORAGE_KEY = 'scani-asset-allocation-preferences';

const DEFAULT_PREFERENCES: AssetAllocationPreferences = {
  dimension: 'token_type',
  visualizationType: 'list',
};

function isValidDimension(value: unknown): value is AssetAllocationDimension {
  return (
    typeof value === 'string' &&
    [
      'token',
      'token_type',
      'account',
      'account_type',
      'institution',
      'institution_type',
      'group',
    ].includes(value)
  );
}

function isValidVisualizationType(value: unknown): value is VisualizationType {
  return typeof value === 'string' && ['list', 'bar', 'donut'].includes(value);
}

export function useAssetAllocationPreferences() {
  const [preferences, setPreferences] = useState<AssetAllocationPreferences>(() => {
    // Try to get from localStorage on initial load
    try {
      const stored = localStorage.getItem(ASSET_ALLOCATION_STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (
          parsed &&
          typeof parsed === 'object' &&
          isValidDimension(parsed.dimension) &&
          isValidVisualizationType(parsed.visualizationType)
        ) {
          return parsed as AssetAllocationPreferences;
        }
      }
    } catch (error) {
      // localStorage not available or invalid JSON, use default
      console.warn('Failed to load asset allocation preferences from localStorage:', error);
    }
    return DEFAULT_PREFERENCES;
  });

  // Save to localStorage whenever preferences change
  useEffect(() => {
    try {
      localStorage.setItem(ASSET_ALLOCATION_STORAGE_KEY, JSON.stringify(preferences));
    } catch (error) {
      console.warn('Failed to save asset allocation preferences to localStorage:', error);
    }
  }, [preferences]);

  const setDimension = (dimension: AssetAllocationDimension) => {
    setPreferences((prev) => ({ ...prev, dimension }));
  };

  const setVisualizationType = (visualizationType: VisualizationType) => {
    setPreferences((prev) => ({ ...prev, visualizationType }));
  };

  return {
    dimension: preferences.dimension,
    visualizationType: preferences.visualizationType,
    setDimension,
    setVisualizationType,
  };
}
