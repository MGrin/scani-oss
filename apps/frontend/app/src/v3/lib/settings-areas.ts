import type { LucideIcon } from 'lucide-react';
import type { ComponentType, ReactNode } from 'react';
import { V3_ROUTES } from './routes';

/**
 * A row's value line: text, `null` when there is none to give (the row stands
 * without one), `undefined` while it is still being read.
 */
export type SettingsAreaValue = string | null | undefined;

/**
 * One of the areas Settings is split into, each at `/settings/<id>` (SC-1670).
 * The page was fourteen sections in one column with nothing to say where
 * anything was.
 */
export interface SettingsArea {
  id: string;
  icon: LucideIcon;
  titleKey: string;
  sections: () => ReactNode;
  /**
   * For an area that decides by itself whether it is listed and what its row
   * says. It renders `children(value)` to be listed and nothing to stay out.
   */
  Row?: ComponentType<{ children: (value: SettingsAreaValue) => ReactNode }>;
}

export function settingsAreaPath(id: string): string {
  return `${V3_ROUTES.settings}/${id}`;
}
