/** V2 route path constants */
export const V2_ROUTES = {
  dashboard: '/v2',
  holdings: '/v2/holdings',
  holdingDetail: (id: string) => `/v2/holdings/${id}`,
  accounts: '/v2/accounts',
  accountDetail: (id: string) => `/v2/accounts/${id}`,
  institutions: '/v2/institutions',
  institutionDetail: (id: string) => `/v2/institutions/${id}`,
  groups: '/v2/groups',
  vaults: '/v2/vaults',
  vaultDetail: (id: string) => `/v2/vaults/${id}`,
  integrations: '/v2/integrations',
  fileImport: '/v2/import',
  addData: '/v2/add-data',
  settings: '/v2/settings',
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
    title: 'Connections',
    items: [
      { label: 'Integrations', icon: 'Plug', path: V2_ROUTES.integrations },
      { label: 'Import File', icon: 'FileUp', path: V2_ROUTES.fileImport },
    ],
  },
];
