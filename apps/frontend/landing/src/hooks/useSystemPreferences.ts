import { useSyncExternalStore } from 'react';

export type SystemTheme = 'light' | 'dark';

interface SystemPreferences {
  theme: SystemTheme;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

function read(): SystemPreferences {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return { theme: 'light' };
  }
  return {
    theme: window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light',
  };
}

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined;
  }
  const dark = window.matchMedia(DARK_QUERY);
  dark.addEventListener('change', callback);
  return () => {
    dark.removeEventListener('change', callback);
  };
}

// useSyncExternalStore only re-renders when the snapshot identity
// changes, so keep a stable object and swap it only when the theme
// actually flips.
let cached: SystemPreferences = { theme: 'light' };
function getSnapshot(): SystemPreferences {
  const next = read();
  if (next.theme !== cached.theme) {
    cached = next;
  }
  return cached;
}

function getServerSnapshot(): SystemPreferences {
  return { theme: 'light' };
}

export function useSystemPreferences(): SystemPreferences {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
