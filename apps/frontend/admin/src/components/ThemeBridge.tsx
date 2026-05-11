'use client';

import { ThemeProvider } from '@scani/ui/contexts/ThemeContext';
import type { ReactNode } from 'react';

/**
 * Client-only wrapper so the Server Component `app/layout.tsx` can mount
 * `ThemeProvider`. `storageKey` is admin-specific so the toggle doesn't
 * collide with the other Scani SPAs if they ever share a hostname.
 */
export function ThemeBridge({ children }: { children: ReactNode }) {
  return <ThemeProvider storageKey="scani-admin-theme">{children}</ThemeProvider>;
}
