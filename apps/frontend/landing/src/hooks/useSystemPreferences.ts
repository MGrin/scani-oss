import { useSyncExternalStore } from 'react';

export type SystemTheme = 'light' | 'dark';
export type SystemDevice = 'desktop' | 'mobile';

export interface SystemPreferences {
  theme: SystemTheme;
  device: SystemDevice;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';
const MOBILE_QUERY = '(max-width: 767px)';

function read(): SystemPreferences {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return { theme: 'light', device: 'desktop' };
  }
  return {
    theme: window.matchMedia(DARK_QUERY).matches ? 'dark' : 'light',
    device: window.matchMedia(MOBILE_QUERY).matches ? 'mobile' : 'desktop',
  };
}

function subscribe(callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => undefined;
  }
  const dark = window.matchMedia(DARK_QUERY);
  const mobile = window.matchMedia(MOBILE_QUERY);
  dark.addEventListener('change', callback);
  mobile.addEventListener('change', callback);
  return () => {
    dark.removeEventListener('change', callback);
    mobile.removeEventListener('change', callback);
  };
}

// useSyncExternalStore returns a fresh object only when the equality
// check on the snapshot fails. Snapshot identity matters: matchMedia
// listeners fire on change, but we re-read both queries each time and
// only the changed field actually flips, so React reconciles a stable
// tree until something actually moves.
let cached: SystemPreferences = { theme: 'light', device: 'desktop' };
function getSnapshot(): SystemPreferences {
  const next = read();
  if (next.theme !== cached.theme || next.device !== cached.device) {
    cached = next;
  }
  return cached;
}

function getServerSnapshot(): SystemPreferences {
  return { theme: 'light', device: 'desktop' };
}

export function useSystemPreferences(): SystemPreferences {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
