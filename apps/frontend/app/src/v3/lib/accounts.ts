import { formatDate } from '@scani/shared';

/**
 * Accounts and institutions, as lists rather than as destinations.
 *
 * §2.1 folded both into Holdings as *dimensions*, and V3-12 shipped that: the
 * filter and the group-by there are how you read "what do I hold at Kraken".
 * What is left for these two surfaces is the other question — "what accounts
 * exist, when did each last sync, and what is in it" — which is a list about
 * the containers, not about the positions. So a row's figure is the account's
 * value and its peek's primary action is the link back into the holdings list,
 * already narrowed.
 */

/**
 * Mirrors the worker's `STALE_SYNC_THRESHOLD_HOURS` default (the stale-sync
 * Sentry probe). A connected account not synced in this long is overdue, and
 * the badge is the only place a user finds that out before the numbers are
 * wrong.
 */
export const STALE_SYNC_AFTER_HOURS = 3;

/** The fields these two lists read off their rows. */
export interface AccountRow {
  id: string;
  name: string;
  typeId: string;
  institutionId: string;
  metadata?: unknown;
  summary: { holdingsCount: number; totalValue: string };
  groups: readonly { id: string; name: string }[];
}

export interface InstitutionRow {
  id: string;
  name: string;
  description: string | null;
  website: string | null;
  typeId: string;
  summary?: { accountCount: number; totalValue: string };
}

/** The ISO timestamp an integration last wrote, or null for a manual account. */
export function accountLastSync(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as { lastSync?: unknown }).lastSync;
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * What the SOURCE says its balances describe, when that is not the same
 * moment we fetched them (SC-384).
 *
 * Written by the balance sync only for a provider whose lag is structural —
 * today only IBKR, whose Flex statement is generated after the close and
 * served unchanged all day. `lastSync` above answers "when did we last reach
 * the source"; this answers "what day is the source talking about", and the
 * gap between the two is what made a correct IBKR sync read as a wrong
 * number.
 *
 * `note` arrives in English from the provider, unlocalized, on purpose: it is
 * the provider's own account of its behaviour and it travels through the same
 * channel as import warnings (SC-428), which are rendered verbatim for the
 * same reason. Translating it here would put a claim about IBKR's mechanics
 * in a translator's hands.
 */
export interface AccountBalancesAsOf {
  at: string;
  note: string;
}

export function accountBalancesAsOf(metadata: unknown): AccountBalancesAsOf | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as { balancesAsOf?: unknown }).balancesAsOf;
  if (!raw || typeof raw !== 'object') return null;
  const { at, note } = raw as { at?: unknown; note?: unknown };
  if (typeof at !== 'string' || at.length === 0) return null;
  if (typeof note !== 'string' || note.length === 0) return null;
  return Number.isFinite(new Date(at).getTime()) ? { at, note } : null;
}

/**
 * The peek's sentence, or `null` when there is nothing to say.
 *
 * Built here rather than in the component so it is assertable: the account
 * peek is a sheet that `renderToStaticMarkup` never opens, so a fact composed
 * inside `AccountsList` would be shipped on the strength of having compiled.
 *
 * The date and the reason are one string on purpose. They render as one fact
 * and they have to travel as one — a layout that could show the date while
 * dropping the sentence is the pre-SC-384 screen again, with a date on it.
 */
export function balancesAsOfFact(metadata: unknown): string | null {
  const asOf = accountBalancesAsOf(metadata);
  return asOf ? `${formatDate(asOf.at)} — ${asOf.note}` : null;
}

/** `now` is a parameter so the threshold is testable without freezing time. */
export function isStaleSync(lastSync: string | null, now: number = Date.now()): boolean {
  if (!lastSync) return false;
  const at = new Date(lastSync).getTime();
  if (!Number.isFinite(at)) return false;
  return now - at > STALE_SYNC_AFTER_HOURS * 60 * 60 * 1000;
}

function toNumber(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function accountValue(account: AccountRow): number {
  return toNumber(account.summary.totalValue);
}

export function institutionValue(institution: InstitutionRow): number {
  return toNumber(institution.summary?.totalValue);
}

/** What the rows currently shown add up to — the `summary` slot's figure, so
 *  it is the filtered set and never the whole account list. */
export function accountsValue(accounts: readonly AccountRow[]): number {
  return accounts.reduce((total, account) => total + accountValue(account), 0);
}

export function institutionsValue(institutions: readonly InstitutionRow[]): number {
  return institutions.reduce((total, item) => total + institutionValue(item), 0);
}

/**
 * Allocation input for the summary bar: one segment per row, largest first.
 *
 * Sorted here rather than left in list order because `foldAllocation` assigns
 * colour slots by position and folds the tail into "Other" — fed an unsorted
 * list it would fold whichever rows happened to arrive last, not the smallest
 * ones. Zero and negative values need no filtering; the fold drops them.
 */
export function namedAllocation<T extends { id: string; name: string }>(
  items: readonly T[],
  measure: (item: T) => number
): { key: string; label: string; value: number }[] {
  return items
    .map((item) => ({ key: item.id, label: item.name, value: measure(item) }))
    .sort((a, b) => b.value - a.value);
}

/**
 * The filter keys a link into the accounts list may set.
 *
 * v2's spellings, unchanged, for the reason `HOLDING_FILTER_PARAMS` gives: the
 * institution peek's "View accounts" and the group peek's own link both point
 * here, and the two generations have to agree so the version switch carries a
 * narrowed list across rather than resetting it.
 */
export const ACCOUNT_FILTER_PARAMS = ['institution', 'type', 'group', 'contents'] as const;

export function accountFiltersFromParams(params: URLSearchParams): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const key of ACCOUNT_FILTER_PARAMS) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  return filters;
}

export function compareAccounts(
  a: AccountRow,
  b: AccountRow,
  field: string,
  direction: string
): number {
  const mult = direction === 'asc' ? 1 : -1;
  switch (field) {
    case 'name':
      return a.name.localeCompare(b.name) * mult;
    case 'value':
      return (accountValue(a) - accountValue(b)) * mult;
    case 'holdings':
      return (a.summary.holdingsCount - b.summary.holdingsCount) * mult;
    default:
      return 0;
  }
}

export function compareInstitutions(
  a: InstitutionRow,
  b: InstitutionRow,
  field: string,
  direction: string
): number {
  const mult = direction === 'asc' ? 1 : -1;
  switch (field) {
    case 'name':
      return a.name.localeCompare(b.name) * mult;
    case 'value':
      return (institutionValue(a) - institutionValue(b)) * mult;
    case 'accounts':
      return ((a.summary?.accountCount ?? 0) - (b.summary?.accountCount ?? 0)) * mult;
    default:
      return 0;
  }
}
