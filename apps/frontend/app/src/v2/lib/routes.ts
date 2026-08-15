import { V2_BASE } from '@/v3/lib/ui-version';

/**
 * Application route path constants.
 *
 * Every one carries the `/v2` prefix since V3-19, when v3 took the root. This
 * table is the *only* place the prefix appears: `V2App`'s own routes are
 * relative to the splat it is mounted under, and nothing in `src/v2/` writes an
 * absolute path by hand, so the classic UI moved namespace without a single
 * screen changing. Old root URLs still resolve — v3's catch-all hands anything
 * it does not route across to the same path here.
 */
export const V2_ROUTES = {
  dashboard: V2_BASE,
  holdings: `${V2_BASE}/holdings`,
  holdingDetail: (id: string) => `${V2_BASE}/holdings/${id}`,
  accounts: `${V2_BASE}/accounts`,
  accountDetail: (id: string) => `${V2_BASE}/accounts/${id}`,
  institutions: `${V2_BASE}/institutions`,
  institutionDetail: (id: string) => `${V2_BASE}/institutions/${id}`,
  groups: `${V2_BASE}/groups`,
  vaults: `${V2_BASE}/vaults`,
  vaultDetail: (id: string) => `${V2_BASE}/vaults/${id}`,
  integrations: `${V2_BASE}/integrations`,
  fileImport: `${V2_BASE}/import`,
  walletImport: `${V2_BASE}/wallet-import`,
  manualEntry: `${V2_BASE}/manual-entry`,
  addData: `${V2_BASE}/add-data`,
  tokens: `${V2_BASE}/tokens`,
  settings: `${V2_BASE}/settings`,
  jobs: `${V2_BASE}/jobs`,
  jobDetail: (jobId: string) => `${V2_BASE}/jobs/${jobId}`,
  review: `${V2_BASE}/review`,
  payments: `${V2_BASE}/payments`,
  // Detail/create/edit sit UNDER the list rather than beside it so the URL
  // hierarchy matches the sidebar hierarchy — that is what lets
  // `resolveActiveNavPath` light "Recurring Payments" on a payment's own
  // page without any per-route special-casing.
  paymentsList: `${V2_BASE}/payments/recurring`,
  paymentDetail: (id: string) => `${V2_BASE}/payments/recurring/${id}`,
  paymentCreate: `${V2_BASE}/payments/recurring/new`,
  /** The same create form, prefilled from a parsed invoice. */
  paymentCreateFromExtraction: (extractionId: string) =>
    `${V2_BASE}/payments/recurring/new?fromExtraction=${encodeURIComponent(extractionId)}`,
  paymentEdit: (id: string) => `${V2_BASE}/payments/recurring/${id}/edit`,
  vendors: `${V2_BASE}/vendors`,
  vendorDetail: (id: string) => `${V2_BASE}/vendors/${id}`,
  // Upload and detail sit UNDER the Files list for the same reason payments
  // do: `resolveActiveNavPath` then lights Files on `/documents/:id` without
  // a special case.
  files: `${V2_BASE}/documents`,
  documentDetail: (id: string) => `${V2_BASE}/documents/${id}`,
  documentUpload: `${V2_BASE}/documents/upload`,
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
      { labelKey: 'nav.files', icon: 'Files', path: V2_ROUTES.files },
      { labelKey: 'nav.jobs', icon: 'ListChecks', path: V2_ROUTES.jobs },
    ],
  },
];

const ALL_NAV_PATHS = NAV_SECTIONS.flatMap((section) => section.items.map((item) => item.path));

/** Exact match, or a true path-segment descendant. `/v2/payments` covers
 * `/v2/payments/recurring` but never `/v2/payments-archive`; `/v2` covers only
 * itself, since prefix-matching the root would light Dashboard on every
 * page in the app. */
function covers(navPath: string, pathname: string): boolean {
  if (navPath === pathname) return true;
  return navPath !== V2_BASE && pathname.startsWith(`${navPath}/`);
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
 * Returns null for pages outside the nav (Settings, integrations), which
 * correctly leaves every entry unlit.
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
