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
  review: '/review',
  payments: '/payments',
  // Detail/create/edit sit UNDER the list rather than beside it so the URL
  // hierarchy matches the sidebar hierarchy — that is what lets
  // `resolveActiveNavPath` light "Recurring Payments" on a payment's own
  // page without any per-route special-casing.
  paymentsList: '/payments/recurring',
  paymentDetail: (id: string) => `/payments/recurring/${id}`,
  paymentCreate: '/payments/recurring/new',
  /** The same create form, prefilled from a parsed invoice. */
  paymentCreateFromExtraction: (extractionId: string) =>
    `/payments/recurring/new?fromExtraction=${encodeURIComponent(extractionId)}`,
  paymentEdit: (id: string) => `/payments/recurring/${id}/edit`,
  vendors: '/vendors',
  vendorDetail: (id: string) => `/vendors/${id}`,
  documentUpload: '/documents/upload',
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
    titleKey: 'nav.sections.payments',
    items: [
      { labelKey: 'nav.paymentsOverview', icon: 'CalendarClock', path: V2_ROUTES.payments },
      { labelKey: 'nav.recurringPayments', icon: 'Repeat', path: V2_ROUTES.paymentsList },
      { labelKey: 'nav.vendors', icon: 'Store', path: V2_ROUTES.vendors },
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
    // The ADD DATA section is gone: every one of its entries is reachable
    // from the Add Data page, which now groups them by Portfolio vs
    // Payments. Keeping both put the same four links in two places.
    titleKey: 'nav.sections.activity',
    items: [
      { labelKey: 'nav.review', icon: 'ClipboardCheck', path: V2_ROUTES.review },
      { labelKey: 'nav.jobs', icon: 'ListChecks', path: V2_ROUTES.jobs },
    ],
  },
];

const ALL_NAV_PATHS = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.path));

/** Exact match, or a true path-segment descendant. `/payments` covers
 * `/payments/recurring` but never `/payments-archive`; `/` covers only
 * itself, since prefix-matching the root would light Dashboard on every
 * page in the app. */
function covers(navPath: string, pathname: string): boolean {
  if (navPath === pathname) return true;
  return navPath !== '/' && pathname.startsWith(`${navPath}/`);
}

/**
 * Which single sidebar entry should read as active for a given URL.
 *
 * `NavLink`'s own `isActive` can't express this: without `end` a nav path
 * lights up on every descendant, so `/payments` stays lit on
 * `/payments/recurring`; with `end` a detail page lights up nothing at
 * all. Longest-match gives both — the most specific entry wins, and
 * detail pages inherit their parent list because they live under it.
 *
 * Returns null for pages outside the nav (Settings, document upload),
 * which correctly leaves every entry unlit.
 */
export function resolveActiveNavPath(pathname: string): string | null {
  let best: string | null = null;
  for (const navPath of ALL_NAV_PATHS) {
    if (covers(navPath, pathname) && (best === null || navPath.length > best.length)) {
      best = navPath;
    }
  }
  return best;
}
