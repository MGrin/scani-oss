/** Sidebar width in pixels */
export const SIDEBAR_WIDTH = 240;
export const SIDEBAR_COLLAPSED_WIDTH = 48;

/** Breakpoints matching Tailwind defaults */
export const BREAKPOINTS = {
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;

/**
 * LocalStorage keys.
 *
 * The `scani-v2-` prefix is retained intentionally even though V2 is now
 * the only UI — existing users already have preferences stored under
 * these keys, and changing the namespace would silently wipe their
 * sidebar-collapsed and view-mode choices on first load post-deploy.
 */
export const STORAGE_KEYS = {
  sidebarCollapsed: 'scani-v2-sidebar-collapsed',
  viewMode: (page: string) => `scani-v2-view-${page}`,
  dataViewState: (page: string) => `scani-v2-dv-${page}`,
} as const;

/** Animation durations (ms) */
export const ANIMATION = {
  sidebar: 200,
  panel: 250,
  fade: 150,
} as const;

/** Mobile bottom nav items */
export const MOBILE_NAV_ITEMS = [
  { label: 'Dashboard', icon: 'LayoutDashboard', path: '/' },
  { label: 'Holdings', icon: 'PieChart', path: '/holdings' },
  { label: 'Accounts', icon: 'Wallet', path: '/accounts' },
  { label: 'Add', icon: 'PlusCircle', path: '/add-data' },
  { label: 'More', icon: 'Menu', path: '' }, // opens sheet with remaining nav
] as const;
