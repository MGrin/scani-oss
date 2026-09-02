import { BALANCE_GAP_REVIEW_PATH, REVIEW_PATH, TRANSFER_REVIEW_PATH } from '@scani/shared';
import { stripTrailingSlash } from '@scani/ui/v3/lib/path';
import { type DataQualityKind, HOLDINGS_QUALITY_PARAM } from './dataQuality';
import { V3_BASE } from './ui-version';

/**
 * v3's route table and navigation model.
 *
 * v3 is mounted at the root and v2 sits under `/v2` (V3-19), and v2's paths
 * mirror these — that mirroring is what lets `counterpartPath` cross between
 * the two interfaces with a prefix add instead of a translation table. So the
 * Money tab lives at `/payments`, not `/money`: the label is the redesign, the
 * URL is the contract with v2.
 */
export const V3_ROUTES = {
  home: V3_BASE,
  holdings: '/holdings',
  money: '/payments',
  recurring: '/payments/recurring',
  forecast: '/payments/forecast',
  accounts: '/accounts',
  institutions: '/institutions',
  /** From `@scani/shared` so the segment its two queues compose from has
   *  one spelling across the boundary they cross (SC-861). */
  review: REVIEW_PATH,
  files: '/documents',
  vaults: '/vaults',
  settings: '/settings',
  groups: '/groups',
  entities: '/entities',
  tokens: '/tokens',
  vendors: '/vendors',
  jobs: '/jobs',
} as const;

/**
 * The recurring-payment form, which is a page rather than a peek: it is the one
 * place in Money that *writes* a record, and a twelve-field form does not
 * belong in a sheet that rests at half the viewport.
 *
 * Mirrors v2's paths exactly (`/payments/recurring/new`, `.../:id/edit`) for
 * the same reason as every other v3 route — `counterpartPath` crosses between
 * the two interfaces with a prefix strip, not a translation table.
 */
export const V3_PAYMENT_ROUTES = {
  create: `${V3_ROUTES.recurring}/new`,
  edit: (paymentId: string) => `${V3_ROUTES.recurring}/${encodeURIComponent(paymentId)}/edit`,
  /** The same create form, prefilled from a parsed invoice — what Approve on a
   *  document's extraction opens. `PaymentFormPage` already reads
   *  `?fromExtraction`; this is the only thing that was missing to reach it
   *  without crossing back to v2. */
  fromExtraction: (extractionId: string) =>
    `${V3_ROUTES.recurring}/new?fromExtraction=${encodeURIComponent(extractionId)}`,
} as const;

/**
 * The recurring list narrowed to one vendor — the path out of a vendor's peek
 * (SC-83).
 *
 * The same shape `/holdings?account=<id>` established in V3-40, and it works
 * for the same reason: `V3DataView` seeds its filters from the query string on
 * first render, and a filter's key IS its parameter name (see
 * `data-view-url.ts`). So this needs no bespoke reader — only a `vendor`
 * filter declared on the recurring list.
 *
 * It exists because a vendor's peek stated "Payments 3" and offered no way to
 * reach any of the three, which is the same defect as a missing Edit button:
 * the capability was there and the way in was not.
 */
export function vendorPaymentsPath(vendorId: string): string {
  return `${V3_ROUTES.recurring}?vendor=${encodeURIComponent(vendorId)}`;
}

/**
 * The holdings list narrowed to one data-quality kind — where a flagged row on
 * the Settings panel goes (SC-293).
 *
 * Same shape as `vendorPaymentsPath` above and it works for the same reason: a
 * filter's key is its parameter name, so `V3DataView` seeds itself from the
 * query string and no bespoke reader is needed.
 *
 * It exists because the panel stated "Holdings with no coverage row  12" and
 * offered no way to reach any of the twelve. SC-268 removed the instruction
 * rather than inventing a destination; this is the destination, and the
 * instruction is not coming back — the row is a link now, and still says
 * "Flagged" rather than telling anybody what to do about it.
 */
export function holdingsQualityPath(kind: DataQualityKind): string {
  return `${V3_ROUTES.holdings}?${HOLDINGS_QUALITY_PARAM}=${encodeURIComponent(kind)}`;
}

/**
 * Capture destinations that are pages rather than nav entries (V3-14).
 *
 * Deliberately outside `V3_ROUTES`, like the payment form and for the same
 * reason: `V3_NAV_PATHS` is built from the nav surfaces, and a manual-entry
 * form is somewhere you are sent, never somewhere you browse to. Mirrors v2's
 * `/manual-entry` so the switch back stays a prefix strip.
 */
export const V3_CAPTURE_ROUTES = {
  manualEntry: '/manual-entry',
  /** "I withdrew 2000" — the movement, not the balance it leaves (SC-607). */
  recordMovement: '/record-movement',
  fileImport: '/import',
  walletImport: '/wallet-import',
  integrations: '/integrations',
  /** Under Files for the reason v2 puts it there — the upload's own result is a
   *  document, so `resolveActiveV3Path` lights Files while you are on it. */
  invoiceUpload: `${V3_ROUTES.files}/upload`,
} as const;

/**
 * One provider's credential form (V3-44).
 *
 * A page rather than the dialog v2 opens over the grid: the form is up to four
 * fields, two of them secrets and one of them a pasted PEM block, and a Radix
 * dialog on a 390px phone puts all of that behind the software keyboard with no
 * scroll of its own. It is also the only shape that lets a half-typed set of
 * credentials survive a back gesture.
 */
export function integrationConnectPath(providerKey: string): string {
  return `${V3_CAPTURE_ROUTES.integrations}/${encodeURIComponent(providerKey)}`;
}

/**
 * The records in v3 that keep a page rather than a peek (V3-15).
 *
 * A peek carries a handful of facts; these carry more than that. A job's detail
 * is its *result* — a parsed document's holdings, an import's confirm step —
 * rendered by a per-job-name review renderer, and a vault's is an editable
 * member list where each row has a percentage and a detach action. Both are a
 * screen's worth of interaction, and `V3DataViewConfig` already says what to do
 * with a record like that: navigate.
 *
 * A **group** joined them in SC-70. It had been a peek listing two counts and
 * two links out, on the reading that a group "has no value of its own". That
 * was true of what the peek *showed* and false of what a group *is*: its whole
 * substance is its member list, and once that list is editable in place — which
 * is the fix for the wizard this ticket removed — it is the same screen's worth
 * of interaction a vault carries. Groups and vaults having one shape is the
 * point, not a side effect.
 */
export function jobDetailPath(jobId: string): string {
  return `${V3_ROUTES.jobs}/${encodeURIComponent(jobId)}`;
}

export function vaultDetailPath(vaultId: string): string {
  return `${V3_ROUTES.vaults}/${encodeURIComponent(vaultId)}`;
}

export function groupDetailPath(groupId: string): string {
  return `${V3_ROUTES.groups}/${encodeURIComponent(groupId)}`;
}

/**
 * The holdings list narrowed to one account — what an account row leads to
 * since SC-560, and what its peek's first action has always been.
 *
 * `?account=` is v2's own parameter name, not a v3 spelling: every existing
 * link into "the holdings in this account" has to keep meaning that across the
 * version switch, which is the same reason `holdingFiltersFromParams` reads
 * v2's names. It lives here rather than inside `AccountsList` because two
 * places now build it and the spelling is the contract.
 */
export function accountHoldingsPath(accountId: string): string {
  return `${V3_ROUTES.holdings}?account=${encodeURIComponent(accountId)}`;
}

/**
 * A document keeps a page too (V3-43), and for the same reason as a job: what
 * you open it for is the *extraction result* — one titled record per invoice
 * found, each carrying six facts and an Approve that navigates to a prefilled
 * payment form. A sheet resting at half a phone cannot hold a repeating record
 * list, and its primary action leaving the sheet is a sheet you can never get
 * back to.
 *
 * The file's own facts — name, kind, size, upload time — genuinely are a peek,
 * and for a screenshot that is the entire record. But a surface gets one shape:
 * a row that peeks for two purposes and navigates for the third is a row that
 * means two things, which is the rule `V3DataViewConfig` states outright.
 */
export function documentDetailPath(documentId: string): string {
  return `${V3_ROUTES.files}/${encodeURIComponent(documentId)}`;
}

/**
 * The two queues under Review: the transfer-review queue (SC-150) and the
 * unexplained-balance-change queue (SC-501).
 *
 * **Owned by `@scani/shared` and re-exported here (SC-861)**, because they are
 * the one kind of v3 destination that leaves the app: `ReviewFeedService`
 * mints each into a feed row's `href` and cannot import this table. Spelling
 * them on both sides was a rename away from a row that still rendered and
 * resolved to v3's catch-all, with nothing failing. `V3_ROUTES.review` reads
 * the same owner, so the segment they compose from has one spelling too.
 *
 * Both sit outside `V3_ROUTES`, like the payment form: that constant is built
 * into `V3_NAV_PATHS`, and these are somewhere you are *sent* by a review
 * item, never somewhere you browse to. `resolveActiveV3Path` still lights
 * Review while you are on one, because `/review` covers `/review/transfers` by
 * the same path-segment rule that makes Money cover the recurring list.
 *
 * Both are segments, so each registers before any dynamic sibling. The
 * transfer queue's rows peek, so it also registers a `:peekId` child route —
 * without one the deep link `/review/transfers/<txId>` resolves to the
 * catch-all and bounces the reader home.
 */
export { BALANCE_GAP_REVIEW_PATH, TRANSFER_REVIEW_PATH };

/**
 * The answers already given (SC-181) — the route back.
 *
 * A separate page rather than a filter on the queue, because the queue's value
 * is that its count reaches zero and means something; a list that also holds
 * every answered row can never reach zero. It exists for a specific fact: 573
 * transfers were answered `left_control` in one bulk pass before splitting
 * existed, and without a way in, the withdrawal that prompted SC-181 stays
 * overstated because it is already answered.
 *
 * Registered BEFORE `${TRANSFER_REVIEW_PATH}/:peekId?` for the same reason
 * `tokens/hidden` goes before `tokens/:peekId?`: `answered` is a segment, not
 * a transaction id, and static-over-dynamic ranking should not be the only
 * thing enforcing it.
 */
export const TRANSFER_ANSWERED_PATH = `${TRANSFER_REVIEW_PATH}/answered`;

/**
 * The standing address rules, and the undo (SC-375).
 *
 * A third static segment under the queue, registered before `:peekId?` for the
 * same reason `answered` is: `rules` is a segment, not a transaction id, and
 * static-over-dynamic ranking should not be the only thing enforcing it.
 *
 * It is where a rule is revoked, which makes it the page the whole feature's
 * safety argument points at — a rule can only remove a question, and this is
 * where the questions come back.
 */
export const TRANSFER_RULES_PATH = `${TRANSFER_REVIEW_PATH}/rules`;

export interface V3NavItem {
  /** i18n key resolved with `t()` at render time. */
  labelKey: string;
  /** lucide-react icon name, mapped in the component that renders it. */
  icon: string;
  path: string;
}

export interface V3TabItem extends Omit<V3NavItem, 'path'> {
  /**
   * Omitted for the capture slot alone. Capture is an *action*: it opens a
   * sheet over the screen you are already on, so tapping it never costs you
   * your place, and a person choosing between "a screenshot" and "a CSV" is
   * reading a menu rather than visiting a page. v2 made it a destination
   * (`/add-data`), which is why picking a method there is two navigations and
   * losing your mind about it is one Back press too many.
   */
  path?: string;
  /** The centre capture slot renders as a filled action rather than a
   * label-under-icon tab. */
  emphasis?: 'action';
}

/**
 * The five slots. Three is the floor at which a tab bar earns its chrome
 * and five the ceiling before labels truncate, so the choice is which five
 * — and the answer is frequency, not the shape of the nav tree.
 *
 * **Accounts, not Holdings** (V3-40). This refines V3-12's decision rather
 * than reversing it: institutions and accounts are still *dimensions* of the
 * holdings list — still filters, still group-by keys — and everything that
 * shipped for that is untouched. What changes is the reading order. An
 * account list is what you scan ("what do I have, where, is it stale"); a
 * holdings list is what you drill into once you have picked one, which is
 * why `?account=<id>` exists. So Accounts takes the slot and Holdings moves
 * into the More grid, reachable there, from an account's peek, and from the
 * home screen's allocation block.
 *
 * Money keeps its slot on the original reasoning: bills have deadlines
 * attached, and a deadline is what earns a permanent slot.
 */
export const V3_TAB_ITEMS: readonly V3TabItem[] = [
  { labelKey: 'nav.home', icon: 'Home', path: V3_ROUTES.home },
  { labelKey: 'nav.accounts', icon: 'Wallet', path: V3_ROUTES.accounts },
  { labelKey: 'nav.add', icon: 'Plus', emphasis: 'action' },
  { labelKey: 'nav.money', icon: 'CalendarClock', path: V3_ROUTES.money },
];

/**
 * The six destinations the More drawer shows at its 40% rest height, as a
 * grid.
 *
 * Six is the number that fits above the fold at that height on a 393×852
 * phone, and fitting is the whole point: v2's drawer listed all thirteen
 * sidebar entries in a scroller, which buried the badged Review item far
 * enough down that `AppShell.tsx:71-79` had to `scrollIntoView` it. A grid
 * that shows Review without scrolling deletes that hack rather than
 * reimplementing it.
 */
export const V3_DRAWER_PRIMARY: readonly V3NavItem[] = [
  { labelKey: 'nav.review', icon: 'ClipboardCheck', path: V3_ROUTES.review },
  // Holdings sits directly above Institutions because the two answer the same
  // question at different grains, and it takes the slot Accounts vacated when
  // V3-40 promoted it to the tab bar. Nothing about the holdings list changed;
  // only which surface offers the way in.
  { labelKey: 'nav.holdings', icon: 'PieChart', path: V3_ROUTES.holdings },
  { labelKey: 'nav.institutions', icon: 'Building2', path: V3_ROUTES.institutions },
  { labelKey: 'nav.vaults', icon: 'Vault', path: V3_ROUTES.vaults },
  { labelKey: 'nav.files', icon: 'Files', path: V3_ROUTES.files },
  { labelKey: 'nav.settings', icon: 'Settings', path: V3_ROUTES.settings },
];

/** Everything else, as a list below the grid. Reaching it is what the
 * drawer's full-height snap point is for. */
export const V3_DRAWER_SECONDARY: readonly V3NavItem[] = [
  { labelKey: 'nav.recurringPayments', icon: 'Repeat', path: V3_ROUTES.recurring },
  { labelKey: 'nav.vendors', icon: 'Store', path: V3_ROUTES.vendors },
  { labelKey: 'nav.groups', icon: 'Tags', path: V3_ROUTES.groups },
  { labelKey: 'nav.entities', icon: 'Scale', path: V3_ROUTES.entities },
  { labelKey: 'nav.tokens', icon: 'Coins', path: V3_ROUTES.tokens },
  { labelKey: 'nav.jobs', icon: 'ListChecks', path: V3_ROUTES.jobs },
];

export interface V3NavSection {
  titleKey: string;
  items: readonly V3NavItem[];
}

/** The desktop sidebar. Same destinations, grouped rather than ranked —
 * a sidebar has the room to show structure, which is exactly what a
 * five-slot tab bar does not. */
export const V3_SIDEBAR_SECTIONS: readonly V3NavSection[] = [
  {
    titleKey: 'nav.sections.portfolio',
    items: [
      { labelKey: 'nav.home', icon: 'Home', path: V3_ROUTES.home },
      { labelKey: 'nav.holdings', icon: 'PieChart', path: V3_ROUTES.holdings },
      { labelKey: 'nav.accounts', icon: 'Wallet', path: V3_ROUTES.accounts },
      { labelKey: 'nav.institutions', icon: 'Building2', path: V3_ROUTES.institutions },
    ],
  },
  {
    titleKey: 'nav.sections.payments',
    items: [
      { labelKey: 'nav.paymentsOverview', icon: 'CalendarClock', path: V3_ROUTES.money },
      { labelKey: 'nav.recurringPayments', icon: 'Repeat', path: V3_ROUTES.recurring },
      { labelKey: 'nav.vendors', icon: 'Store', path: V3_ROUTES.vendors },
    ],
  },
  {
    titleKey: 'nav.sections.organization',
    items: [
      { labelKey: 'nav.groups', icon: 'Tags', path: V3_ROUTES.groups },
      { labelKey: 'nav.vaults', icon: 'Vault', path: V3_ROUTES.vaults },
      { labelKey: 'nav.tokens', icon: 'Coins', path: V3_ROUTES.tokens },
    ],
  },
  {
    titleKey: 'nav.sections.activity',
    items: [
      { labelKey: 'nav.review', icon: 'ClipboardCheck', path: V3_ROUTES.review },
      { labelKey: 'nav.files', icon: 'Files', path: V3_ROUTES.files },
      { labelKey: 'nav.jobs', icon: 'ListChecks', path: V3_ROUTES.jobs },
    ],
  },
];

/** Every destination v3 routes today, in one list, so `V3App` and the
 * active-path resolver cannot drift apart. */
export const V3_NAV_PATHS: readonly string[] = [
  ...new Set([
    // The capture slot has no path — it opens a sheet — so it contributes
    // nothing here, and no placeholder route is registered for it.
    ...V3_TAB_ITEMS.flatMap((item) => (item.path ? [item.path] : [])),
    ...V3_DRAWER_PRIMARY.map((item) => item.path),
    ...V3_DRAWER_SECONDARY.map((item) => item.path),
    ...V3_SIDEBAR_SECTIONS.flatMap((section) => section.items.map((item) => item.path)),
  ]),
];

/** Exact match, or a true path-segment descendant. `/payments` covers
 * `/payments/recurring` but never `/payments-archive`; `/` covers
 * only itself, because prefix-matching the root would light Home on every
 * screen in the app. */
function covers(navPath: string, pathname: string): boolean {
  if (navPath === pathname) return true;
  return navPath !== V3_BASE && pathname.startsWith(`${navPath}/`);
}

function normalize(pathname: string): string {
  if (pathname.length > 1 && pathname.endsWith('/')) {
    return stripTrailingSlash(pathname) || '/';
  }
  return pathname;
}

/**
 * Which single destination should read as active for a URL, by longest
 * match — the same rule as v2's `resolveActiveNavPath` and for the same
 * reason. `NavLink`'s `isActive` cannot express it: without `end` a parent
 * lights on every descendant, with `end` a detail page lights nothing.
 *
 * Returns null off-nav, which correctly leaves everything unlit.
 */
export function resolveActiveV3Path(pathname: string): string | null {
  const path = normalize(pathname);
  let best: string | null = null;
  for (const navPath of V3_NAV_PATHS) {
    if (covers(navPath, path) && (best === null || navPath.length > best.length)) {
      best = navPath;
    }
  }
  return best;
}

/**
 * The one screen a tab owns without containing it (V3-40).
 *
 * `/holdings?account=<id>` is where "View holdings" on an account's peek
 * lands, and that arrival is a drill-down *inside* the Accounts tab — one tap
 * deep, with the way back up being the same tab. An unlit bar there would tell
 * a reader who just pressed Accounts that they had left it. The same path
 * without an account filter is the standalone holdings list, reached from the
 * More drawer or from home's allocation block, and lights nothing.
 *
 * The filter, not the referrer, is what decides — a URL has to mean the same
 * thing when it is reloaded or shared as it did when it was tapped.
 */
function resolveDrillDownTab(active: string, search: string | undefined): string | null {
  if (active !== V3_ROUTES.holdings || !search) return null;
  const account = new URLSearchParams(search).get('account');
  return account ? V3_ROUTES.accounts : null;
}

/**
 * Which tab should read as active. A tab stands for a *section*, so Money
 * stays lit on a recurring payment's own page — the opposite of the
 * sidebar, where `/payments` and `/payments/recurring` are two
 * entries and only the most specific may light.
 *
 * Destinations that live in the More drawer light no tab rather than
 * lighting the nearest one, because a lit Accounts tab on the Vaults
 * screen is a worse answer than an unlit bar.
 *
 * `search` is optional so a caller that has only a pathname still gets the
 * section rule; passing it is what adds the drill-down above.
 */
export function resolveActiveTabPath(pathname: string, search?: string): string | null {
  const path = normalize(pathname);
  const active = resolveActiveV3Path(path);
  if (active === null) return null;
  const tabPaths = V3_TAB_ITEMS.flatMap((item) => (item.path ? [item.path] : []));
  if (tabPaths.includes(active)) return active;
  const drillDown = resolveDrillDownTab(active, search);
  if (drillDown !== null) return drillDown;
  // `active` is a drawer or sidebar destination; it only belongs to a tab
  // if it sits underneath one, which today only happens for Money.
  return tabPaths.find((tab) => covers(tab, active)) ?? null;
}
