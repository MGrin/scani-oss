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
  tokens: '/tokens',
  settings: '/settings',
  jobs: '/jobs',
  jobDetail: (jobId: string) => `/jobs/${jobId}`,
} as const;

/** Sidebar navigation structure. `labelKey` / `titleKey` are i18n keys
 * resolved via `t()` at render time — the literal English strings live
 * in `src/i18n/locales/en.json` under the `nav.*` namespace. */
export interface NavItem {
  labelKey: string;
  icon: string;
  path: string;
  badge?: string;
}

export interface NavSection {
  titleKey: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    titleKey: 'nav.sections.portfolio',
    items: [
      { labelKey: 'nav.dashboard', icon: 'LayoutDashboard', path: V2_ROUTES.dashboard },
      { labelKey: 'nav.holdings', icon: 'PieChart', path: V2_ROUTES.holdings },
      { labelKey: 'nav.accounts', icon: 'Wallet', path: V2_ROUTES.accounts },
      { labelKey: 'nav.institutions', icon: 'Building2', path: V2_ROUTES.institutions },
    ],
  },
  {
    titleKey: 'nav.sections.organization',
    items: [
      { labelKey: 'nav.groups', icon: 'Tags', path: V2_ROUTES.groups },
      { labelKey: 'nav.vaults', icon: 'Vault', path: V2_ROUTES.vaults },
      { labelKey: 'nav.tokens', icon: 'Coins', path: V2_ROUTES.tokens },
    ],
  },
  {
    titleKey: 'nav.sections.addData',
    items: [
      { labelKey: 'nav.manualEntry', icon: 'Keyboard', path: V2_ROUTES.manualEntry },
      { labelKey: 'nav.uploadFile', icon: 'FileUp', path: V2_ROUTES.fileImport },
      { labelKey: 'nav.cryptoWallet', icon: 'Coins', path: V2_ROUTES.walletImport },
      { labelKey: 'nav.integration', icon: 'Plug', path: V2_ROUTES.integrations },
    ],
  },
  {
    titleKey: 'nav.sections.activity',
    items: [{ labelKey: 'nav.jobs', icon: 'ListChecks', path: V2_ROUTES.jobs }],
  },
];
