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

/** LocalStorage keys */
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
  { label: 'Dashboard', icon: 'LayoutDashboard', path: '/v2' },
  { label: 'Holdings', icon: 'PieChart', path: '/v2/holdings' },
  { label: 'Accounts', icon: 'Wallet', path: '/v2/accounts' },
  { label: 'Add', icon: 'PlusCircle', path: '/v2/add-data' },
  { label: 'More', icon: 'Menu', path: '' }, // opens sheet with remaining nav
] as const;
