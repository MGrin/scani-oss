/** Application route path constants. */
export const V2_ROUTES = {
  dashboard: '/',
  holdings: '/holdings',
  holdingDetail: (id: string) => `/holdings/${id}`,
  accounts: '/accounts',
  accountDetail: (id: string) => `/accounts/${id}`,
  institutions: '/institutions',
  institutionDetail: (id: string) => `/institutions/${id}`,
  groups: '/groups',
  vaults: '/vaults',
  vaultDetail: (id: string) => `/vaults/${id}`,
  integrations: '/integrations',
  fileImport: '/import',
  walletImport: '/wallet-import',
  manualEntry: '/manual-entry',
  addData: '/add-data',
  settings: '/settings',
} as const;

/** Sidebar navigation structure */
export interface NavItem {
  label: string;
  icon: string;
  path: string;
  badge?: string;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    title: 'Portfolio',
    items: [
      { label: 'Dashboard', icon: 'LayoutDashboard', path: V2_ROUTES.dashboard },
      { label: 'Holdings', icon: 'PieChart', path: V2_ROUTES.holdings },
      { label: 'Accounts', icon: 'Wallet', path: V2_ROUTES.accounts },
      { label: 'Institutions', icon: 'Building2', path: V2_ROUTES.institutions },
    ],
  },
  {
    title: 'Organization',
    items: [
      { label: 'Groups', icon: 'Tags', path: V2_ROUTES.groups },
      { label: 'Vaults', icon: 'Vault', path: V2_ROUTES.vaults },
    ],
  },
  {
    title: 'Add Data',
    items: [
      { label: 'Manual Entry', icon: 'Keyboard', path: V2_ROUTES.manualEntry },
      { label: 'Upload File', icon: 'FileUp', path: V2_ROUTES.fileImport },
      { label: 'Crypto Wallet', icon: 'Coins', path: V2_ROUTES.walletImport },
      { label: 'Integration', icon: 'Plug', path: V2_ROUTES.integrations },
    ],
  },
];
