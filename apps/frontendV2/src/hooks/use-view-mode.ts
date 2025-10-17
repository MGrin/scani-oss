import { useEffect, useState } from 'react';

type ViewMode = 'cards' | 'table';

const VIEW_MODE_STORAGE_KEY = 'scani-view-mode';

export function useViewMode(defaultMode: ViewMode = 'cards') {
  const [viewMode, setViewMode] = useState<ViewMode>(() => {
    // Try to get from localStorage on initial load
    try {
      const stored = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
      if (stored === 'cards' || stored === 'table') {
        return stored;
      }
    } catch (error) {
      // localStorage not available, use default
      console.warn('localStorage not available:', error);
    }
    return defaultMode;
  });

  // Save to localStorage whenever viewMode changes
  useEffect(() => {
    try {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, viewMode);
    } catch (error) {
      console.warn('Failed to save view mode to localStorage:', error);
    }
  }, [viewMode]);

  return [viewMode, setViewMode] as const;
}
