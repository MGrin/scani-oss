import {
  Decimal,
  formatDayMonth,
  type HoldingWithDetails,
  monthNameInDate,
  quantityDecimals,
  weekdayName,
} from '@scani/shared';
import type { AllocationInput } from '@scani/ui/v3/lib/chart';
import type { TFunction } from 'i18next';
import { HOLDINGS_QUALITY_PARAM } from './dataQuality';
import { isScamToken } from './tokens';

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
 * Unrealized P/L, or `null` when there is nothing to compare against — no
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
export function amountDecimals(amount: Decimal.Value): number {
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

type HoldingSortField = 'value' | 'symbol' | 'amount' | 'price' | 'pnl';

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
      // `Decimal.cmp`, not a subtraction. `amount` is a decimal STRING now
      // (SC-567) and `'1e-18' - '4e-10'` would coerce through a double —
      // which is the representation this field stopped using precisely
      // because it cannot hold every balance. Subtraction also overflows to
      // `Infinity` on two large balances and returns `NaN` on anything
      // unparseable, and a comparator returning `NaN` sorts unpredictably
      // rather than failing.
      return new Decimal(a.amount).cmp(new Decimal(b.amount)) * factor;
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

/**
 * "Monthly on day 1". Reads as a fact under a "Payout" label rather than as
 * v2's sentence, which repeated the word "Paid" the label already carried.
 *
 * Two sources, deliberately separated (SC-300). The SENTENCE is copy and comes
 * from the catalogue. The day and month NAMES come from `Intl`, via the shared
 * date helpers, and are not in the catalogue at all — this used to interpolate
 * a hand-rolled `DAY_NAMES` / `MONTH_NAMES` table, and translating those tables
 * would have been 56 entries to maintain in every language for something every
 * runtime already knows.
 *
 * `APP_LOCALE` is still pinned to `en-GB` (SC-260), so the output is unchanged
 * today. The difference is that it now follows the locale when that pin lifts
 * instead of needing 56 new strings written first.
 */
/**
 * Days in a one-indexed month — `Date.UTC(y, m, 0)` is the last day of month
 * `m`, because day 0 of the next month is the day before it starts.
 *
 * The job's own `daysInMonth` (`ApplyApyPayoutsUseCase`), which is what makes
 * the two callers below statements about what will happen rather than guesses
 * at it: the payout date is `Math.min(configured day, this)`.
 */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function payoutScheduleLabel(
  t: TFunction,
  frequency: string,
  dayOfWeek: number | null,
  dayOfMonth: number | null,
  month: number | null,
  /** Only reachable by the yearly branch, and only to decide whether the day
   *  exists in that month. A parameter rather than a `new Date()` inside so the
   *  sentence stays a pure function of its arguments. */
  year: number = new Date().getUTCFullYear()
): string {
  switch (frequency) {
    case 'daily':
      return t('v3.holdings.payout.daily');
    case 'weekdays':
      return t('v3.holdings.payout.weekdays');
    case 'weekly':
      return t('v3.holdings.payout.weekly', { day: weekdayName(dayOfWeek ?? 0) });
    case 'monthly':
      return t('v3.holdings.payout.monthly', { day: dayOfMonth ?? 1 });
    case 'yearly': {
      const payoutMonth = month ?? 1;
      const day = dayOfMonth ?? 1;
      // 31 February is a date the DTO accepts and the calendar does not, so
      // stating it would be a sentence about a day that never arrives. The job
      // pays on the month's last day (`Math.min(day, daysInMonth)`), and which
      // day that is moves with the leap year — hence "the last day" rather than
      // a number this would have to be wrong about one year in four.
      if (day > daysInMonth(year, payoutMonth)) {
        return t('v3.holdings.payout.yearlyLastDay', { month: monthNameInDate(payoutMonth) });
      }
      // One formatted date rather than a day and a month name interpolated
      // separately: the separate form fixes the word order in the template and
      // asks `Intl` for a stand-alone month, and both are wrong somewhere —
      // «15 февраль» for the second, `15 February` for an en-US reader for the
      // first (SC-413).
      return t('v3.holdings.payout.yearly', { date: formatDayMonth(day, payoutMonth) });
    }
    default:
      // An unrecognised frequency is echoed rather than guessed at — the same
      // choice as before, and the reason it is not a catalogue key.
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
export const HOLDING_FILTER_PARAMS = [
  'institution',
  'account',
  'tokenType',
  'group',
  // The data-quality dimension (SC-293). Unlike the four above it is not one
  // of v2's parameter names — v2 has no such filter and its panel links
  // nowhere — so this one spelling is the contract, and `dataQuality.ts` owns
  // the values it may take.
  HOLDINGS_QUALITY_PARAM,
] as const;

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

/**
 * The decimal scale the in-place balance editor parses at (SC-567).
 *
 * 18, and the eight it replaces was destroying balances. `parseAmountInput`
 * truncates the VALUE at this scale while leaving the TEXT alone — deliberately,
 * so a half-typed figure survives its own keystroke (SC-75). At a scale of 8
 * that rule turns a real dust balance into `0.00000000` while the field on
 * screen still reads `0.0000000004013`: the display and the value disagree, and
 * the display is the reassuring one.
 *
 * 18 is the `minE` this project's `Decimal` is configured with and the precision
 * `holdings.balance` actually stores (a `text` column, "Store as string for
 * Decimal.js precision"), so nothing a balance can hold is truncated here. It is
 * NOT `QUANTITY_DECIMALS`: that constant answers how many decimals to SHOW, and
 * a display cap has no business deciding what a reader is allowed to type.
 */
export const BALANCE_EDIT_SCALE = 18;

/**
 * Whether an in-place balance edit carries a change worth writing.
 *
 * SC-567, and this is the guard that makes a data-loss path UNREACHABLE rather
 * than merely unlikely.
 *
 * `HoldingAmountFact` seeds its editor from the balance it is displaying and
 * saves whatever the field holds. Both halves were separately reasonable and
 * together they destroyed data: the wire rounded any balance below `1e-8` to
 * `0`, so the editor opened on `"0"` for a real position, and the save guard
 * was `if (next)` — which `"0"` passes, being a non-empty string. Opening the
 * peek on a dust holding, tapping the pencil to LOOK at the figure and tapping
 * save wrote `0` over a balance nobody meant to touch, with no keystroke in
 * between.
 *
 * WHY THAT LINE SURVIVED SOMEBODY EDITING SIX LINES ABOVE IT, which is the
 * transferable part: `if (next)` READS as "is this a valid amount" and only IS
 * "did they type anything". The line does exactly what it says; what it says
 * is not what the reader needs. So going and checking it finds a correct line
 * and moves on. Same family as `CREATE SCHEMA IF NOT EXISTS` reading as a
 * guard when it is a convenience — the most durable shape of wrong on this
 * codebase, because every reader who verifies it comes away reassured.
 *
 * WHY THIS STILL MATTERS ONCE THE WIRE IS FIXED, which is the change already
 * in flight beside it: after that, the seed is the exact balance and saving it
 * back is harmless. The guard is not here because the seed is currently wrong
 * — it is here so that the destructive route is closed BY CONSTRUCTION, by the
 * absence of an edit rather than by the seed happening to be faithful. A future
 * change that reintroduces a lossy seed re-creates the display bug and cannot
 * re-create the data loss. That is the difference between a fix and a fix that
 * stays fixed.
 *
 * Compared as TEXT, not as numbers. `0.50` and `0.5` are the same balance, and
 * a reader who retyped one as the other did touch the field — writing it is
 * correct and costs nothing. The case this exists for is the one where nothing
 * was typed at all, and there the two strings are identical.
 */
export function balanceEditWrites(seed: string, draft: string): boolean {
  const next = draft.trim();
  if (next === '') return false;
  return next !== seed.trim();
}
