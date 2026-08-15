import { type HoldingWithDetails, quantityDecimals } from '@scani/shared';
import type { AllocationInput } from '@scani/ui/v3/lib/chart';
import { isScamToken } from '@/v2/components/ScamBadge';

/**
 * The pure half of the v3 holdings surface: every decision the list and the
 * peek sheet make about a holding, kept out of React so it is testable without
 * a tRPC client or a DOM.
 *
 * Three of these differ from v2 on purpose, and each is a correctness fix
 * rather than a restyle:
 *
 * - **An unpriceable holding has no gain/loss.** `HoldingDetailContent.tsx:223`
 *   coerces a null value to `0` before subtracting the cost basis, so a
 *   position whose price we simply do not know renders as a total loss. `null`
 *   is a claim about knowledge; `−100%` is a claim about money.
 * - **Nulls sort to the bottom in both directions**, which v2 already does for
 *   the list and is preserved here — ranking "unknown" as `$0` would put every
 *   unpriced position at one end of a value sort as though it were worthless.
 * - **Unit counts get the precision they actually have.** v2 renders amounts at
 *   `maximumFractionDigits: 8`, which is right for `0.28410000 BTC` and prints
 *   `84` shares of AAPL as `84`. `amountDecimals` asks the number how many
 *   fraction digits it is carrying instead of picking one constant for both.
 */

/** The token types whose price is entered by hand rather than fetched. */
const CUSTOM_PRICE_TOKEN_TYPES = new Set(['private-company', 'other']);

/** The account types the APY engine will accrue interest on — the same gate
 *  the backend applies in `upsertApyConfig`. */
const APY_ACCOUNT_TYPES = new Set(['checking', 'savings', 'investment']);

export interface HoldingGainLoss {
  absolute: number;
  /** Percent of the cost basis, not a fraction. */
  percent: number;
}

/**
 * Unrealised P/L, or `null` when there is nothing to compare against — no
 * cost basis recorded, or no resolvable price for the position today.
 */
export function holdingGainLoss(
  holding: Pick<HoldingWithDetails, 'value' | 'costBasis'>
): HoldingGainLoss | null {
  const { value, costBasis } = holding;
  if (typeof value !== 'number' || typeof costBasis !== 'number') return null;
  if (!(costBasis > 0)) return null;
  const absolute = value - costBasis;
  return { absolute, percent: (absolute / costBasis) * 100 };
}

/** The per-unit price as a number, or `null` when the holding is unpriceable. */
export function holdingPrice(holding: Pick<HoldingWithDetails, 'price'>): number | null {
  const raw = holding.price?.value;
  if (raw === null || raw === undefined) return null;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Whether the price of this holding's token is one the user maintains. */
export function hasCustomPrice(holding: Pick<HoldingWithDetails, 'token'>): boolean {
  return CUSTOM_PRICE_TOKEN_TYPES.has(holding.token.typeCode);
}

/** Whether interest can be configured against this holding's account. */
export function supportsApy(holding: Pick<HoldingWithDetails, 'account'>): boolean {
  return APY_ACCOUNT_TYPES.has(holding.account.typeCode);
}

/** Whether the balance can be re-fetched from the venue it came from. */
export function isSynced(holding: Pick<HoldingWithDetails, 'source'>): boolean {
  return Boolean(holding.source) && holding.source !== 'manual';
}

/**
 * How many fraction digits to show for a unit count.
 *
 * Asked of the number rather than of the asset class, because the same list
 * holds `0.28410000` of one thing and `84` of another and neither wants the
 * other's precision.
 *
 * **The rule itself now lives in `@scani/shared`** (SC-177), because this is
 * not the only surface that needed it and the two that reimplemented it — the
 * realized ledger's `decimals={8}`, the exports' `decimals: 2` — each got a
 * different answer for the same figure. The shared version also closes a hole
 * this one had: a balance below `1e-8` was capped to eight decimals and
 * rendered `0`, which is a claim that the position is empty rather than that it
 * is small.
 */
export function amountDecimals(amount: number): number {
  return quantityDecimals(amount);
}

/**
 * What the search box matches. Groups are in here as well as the four fields
 * v2 searched: group is one of the surface's filter dimensions, so typing a
 * group's name and getting nothing would read as the search being broken.
 */
export function holdingMatches(holding: HoldingWithDetails, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  const haystack = [
    holding.token.symbol,
    holding.token.name,
    holding.account.name,
    holding.institution.name,
    ...holding.groups.map((group) => group.name),
  ];
  return haystack.some((field) => field.toLowerCase().includes(needle));
}

export type HoldingSortField = 'value' | 'symbol' | 'amount' | 'price' | 'pnl';

/** Unknown last, whichever way the column is pointing. */
function compareNullable(a: number | null, b: number | null, factor: number): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return (a - b) * factor;
}

export function compareHoldings(
  a: HoldingWithDetails,
  b: HoldingWithDetails,
  field: string,
  direction: 'asc' | 'desc'
): number {
  const factor = direction === 'asc' ? 1 : -1;
  switch (field as HoldingSortField) {
    case 'symbol':
      return a.token.symbol.localeCompare(b.token.symbol) * factor;
    case 'amount':
      return (a.amount - b.amount) * factor;
    case 'price':
      return compareNullable(holdingPrice(a), holdingPrice(b), factor);
    case 'pnl':
      return compareNullable(
        holdingGainLoss(a)?.percent ?? null,
        holdingGainLoss(b)?.percent ?? null,
        factor
      );
    default:
      return compareNullable(a.value, b.value, factor);
  }
}

/**
 * Whether a holding contributes to a total drawn over this list.
 *
 * The same three conditions the server applies in `isIncludedInTotal`
 * (`packages/business/domain/src/lib/holding-inclusion.ts`) — hidden, inactive
 * and scam-flagged holdings never count — restated on the client because the
 * v3 list totals the *filtered* rows and so cannot use the server's own
 * `summary.totalValue`, which is always over the whole portfolio.
 *
 * SC-63 is what the missing `isActive` half cost: deactivating one position
 * left `/holdings` reading €599,511.02 while `/`, `/accounts` and
 * `/institutions` all read €525,728.45 — two screens disagreeing by 14% of net
 * worth over one data set, and surviving a hard reload, so not even a cache to
 * blame. The server was right; this list was the one arithmetic nobody had
 * taught the rule to.
 *
 * The row itself stays on the list, badged `Inactive`. Excluding it outright
 * would be the easier fix and the wrong one: deactivating is one tap, so a
 * holding deactivated by accident has to still be findable to be turned back
 * on. It is subtracted from the figure, not from the surface.
 */
export function countsTowardTotal(
  holding: Pick<HoldingWithDetails, 'isActive' | 'isHidden' | 'token'>
): boolean {
  if (holding.isHidden) return false;
  if (!holding.isActive) return false;
  return !isScamToken(holding.token.isScamProbability);
}

/**
 * The value of a set of holdings.
 *
 * Unpriceable positions contribute nothing rather than making the whole sum
 * unknown — the same choice `holdings.getWithDetails` makes for its summary.
 * The list beneath shows each of them as `—`, so the omission is visible on
 * the same screen as the total.
 */
export function holdingsValue(holdings: readonly HoldingWithDetails[]): number {
  return holdings.reduce(
    (sum, holding) => (countsTowardTotal(holding) ? sum + (holding.value ?? 0) : sum),
    0
  );
}

export interface ExcludedFromTotal {
  count: number;
  value: number;
}

/**
 * The rows on screen that the figure above them does not count, and what they
 * are worth.
 *
 * Without this the fix for SC-63 trades one wrong number for one unexplained
 * one: the two screens now agree, but a reader adding the visible rows up by
 * hand still lands somewhere else than the total, with nothing on the page
 * saying why. `HoldingsSummary` turns it into a sentence.
 *
 * That sentence can say "inactive" because on this surface it is the only
 * reason left: `holdings.getWithDetails` passes `includeHidden=false` and the
 * repository drops scam tokens in SQL, so a row that reaches this list and
 * fails `countsTowardTotal` failed on `isActive` — and is already carrying the
 * `Inactive` badge the sentence points at.
 */
export function excludedFromTotal(holdings: readonly HoldingWithDetails[]): ExcludedFromTotal {
  let count = 0;
  let value = 0;
  for (const holding of holdings) {
    if (countsTowardTotal(holding)) continue;
    count += 1;
    value += holding.value ?? 0;
  }
  return { count, value };
}

/**
 * Allocation by token type, for the stacked bar.
 *
 * Ordered by value, biggest first: `foldAllocation` assigns colour by position
 * and folds the tail, so this is the order that keeps a large category out of
 * "Other". It re-sorts as prices move, which is the documented cost of
 * value-ordering a bar and the same trade the home screen makes.
 *
 * Over the same set `holdingsValue` totals, for the reason SC-63 makes
 * concrete: an allocation whose segments add up to a different number than the
 * figure directly above them is two claims about one portfolio.
 */
export function holdingAllocation(holdings: readonly HoldingWithDetails[]): AllocationInput[] {
  const byType = new Map<string, AllocationInput>();
  for (const holding of holdings) {
    if (!countsTowardTotal(holding)) continue;
    if (typeof holding.value !== 'number' || holding.value <= 0) continue;
    const key = holding.token.typeCode;
    const existing = byType.get(key);
    if (existing) existing.value += holding.value;
    else byType.set(key, { key, label: holding.token.type || key, value: holding.value });
  }
  return [...byType.values()].sort((a, b) => b.value - a.value);
}

/** `import_wallet` → `wallet`. The prefix names the pipeline, not the venue,
 *  and the venue is already on the row above. */
export function describeSource(source: string): string {
  return source.replace(/^import_/, '').replace(/_/g, ' ');
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTH_NAMES = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** "Monthly on day 1". Reads as a fact under a "Payout" label rather than as
 *  v2's sentence, which repeated the word "Paid" the label already carried. */
export function payoutScheduleLabel(
  frequency: string,
  dayOfWeek: number | null,
  dayOfMonth: number | null,
  month: number | null
): string {
  switch (frequency) {
    case 'daily':
      return 'Daily';
    case 'weekdays':
      return 'Weekdays (Mon–Fri)';
    case 'weekly':
      return `Weekly on ${DAY_NAMES[dayOfWeek ?? 0]}`;
    case 'monthly':
      return `Monthly on day ${dayOfMonth ?? 1}`;
    case 'yearly':
      return `Yearly on ${MONTH_NAMES[month ?? 1]} ${dayOfMonth ?? 1}`;
    default:
      return frequency;
  }
}

/**
 * The filter keys a link into this surface may set.
 *
 * These are v2's query-parameter names, unchanged, because the IA change in
 * §2.1 is what makes them load-bearing: institutions and accounts stop being
 * destinations and become dimensions *of this list*, so every link that used
 * to open an institution page now opens `/v3/holdings?institution=<id>`, and
 * the two generations have to agree on the spelling for the version switch to
 * carry a filtered view across.
 */
export const HOLDING_FILTER_PARAMS = ['institution', 'account', 'tokenType', 'group'] as const;

export function holdingFiltersFromParams(params: URLSearchParams): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const key of HOLDING_FILTER_PARAMS) {
    const value = params.get(key);
    if (value) filters[key] = value;
  }
  return filters;
}

export interface SelectOption {
  value: string;
  label: string;
}

/** Token types present in the data, labelled by their human name. */
export function tokenTypeOptions(holdings: readonly HoldingWithDetails[]): SelectOption[] {
  const byCode = new Map<string, string>();
  for (const holding of holdings) {
    if (!byCode.has(holding.token.typeCode)) {
      byCode.set(holding.token.typeCode, holding.token.type || holding.token.typeCode);
    }
  }
  return [...byCode.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Filter options for an entity the surface can be linked into.
 *
 * `preferred` is the entity's own list and `fallback` is what the holdings
 * themselves name. The full list wins because a link can carry an id with zero
 * holdings behind it — a freshly connected integration that imported nothing —
 * and the chip for that filter would otherwise show a raw UUID over an empty
 * list, which reads as a bug rather than as "nothing here yet".
 */
export function entityOptions(
  preferred: readonly { id: string; name: string }[] | undefined,
  fallback: readonly { id: string; name: string }[]
): SelectOption[] {
  const source = preferred && preferred.length > 0 ? preferred : fallback;
  const byId = new Map<string, string>();
  for (const entity of source) if (!byId.has(entity.id)) byId.set(entity.id, entity.name);
  return [...byId.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
