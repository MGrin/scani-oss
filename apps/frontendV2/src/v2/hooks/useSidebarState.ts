import { useCallback, useState } from 'react';
import { STORAGE_KEYS } from '../lib/constants';

export function useSidebarState() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.sidebarCollapsed) === 'true';
    } catch {
      return false;
    }
  });

  const [mobileOpen, setMobileOpen] = useState(false);

  const toggle = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEYS.sidebarCollapsed, String(next));
      } catch {}
      return next;
    });
  }, []);

  return { collapsed, toggle, mobileOpen, setMobileOpen };
}
