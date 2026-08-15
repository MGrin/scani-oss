import { type Decimal, formatDate } from '@scani/shared';
import { sumAmountsByCurrency } from '@/v2/lib/paymentTotals';
import { V3_ROUTES } from './routes';

/**
 * The pure half of the Money tab — which of its three views a URL selects, how
 * a 30-day occurrence feed is grouped, and the wording the feed puts on a date.
 *
 * Money is one surface with three views rather than three pages because the
 * question behind all of them is the same one ("what is going out, and to
 * whom") asked at three distances: the next thirty days, the standing
 * commitments behind them, and the counterparties behind those. v2 shipped them
 * as three sidebar entries, which is why its payments overview had to print
 * "you have 4 recurring payments" in a subtitle — the other two views were far
 * enough away that a user could believe their payments had not been created.
 *
 * The views stay *routes*, not component state: the drawer and the sidebar
 * already link `/v3/payments/recurring` and `/v3/vendors` (V3-05), a segment is
 * a place a link can point at, and the peek sheet underneath needs a URL of its
 * own anyway (V3-11).
 */

export type MoneySegment = 'upcoming' | 'recurring' | 'vendors';

export interface MoneySegmentDef {
  key: MoneySegment;
  /** Segmented-control label. */
  label: string;
  path: string;
}

export const MONEY_SEGMENTS: readonly MoneySegmentDef[] = [
  { key: 'upcoming', label: 'Upcoming', path: V3_ROUTES.money },
  { key: 'recurring', label: 'Recurring', path: V3_ROUTES.recurring },
  { key: 'vendors', label: 'Vendors', path: V3_ROUTES.vendors },
];

/** The default view. Bills have deadlines; the standing list does not. */
export const DEFAULT_MONEY_SEGMENT: MoneySegment = 'upcoming';

function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

function covers(base: string, path: string): boolean {
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Which view a URL selects.
 *
 * Ordered most-specific first, which is what lets the upcoming feed peek at
 * `/v3/payments/:occurrenceId` while the recurring list lives one segment
 * deeper at `/v3/payments/recurring`: `recurring` is claimed before the
 * fall-through, so it is never read as an occurrence id. The cost is that
 * `recurring` is a reserved word in that id space — occurrence ids are uuids,
 * so nothing can collide with it.
 */
export function resolveMoneySegment(pathname: string): MoneySegment {
  const path = stripTrailingSlash(pathname);
  if (covers(V3_ROUTES.vendors, path)) return 'vendors';
  if (covers(V3_ROUTES.recurring, path)) return 'recurring';
  return DEFAULT_MONEY_SEGMENT;
}

export function moneySegmentPath(segment: MoneySegment): string {
  return MONEY_SEGMENTS.find((entry) => entry.key === segment)?.path ?? V3_ROUTES.money;
}

/**
 * Two horizons, because bills and income are two different questions.
 *
 * **Bills: 30 days.** A billing cycle, and the window a reader is asking "what
 * must I cover" over. Unchanged from v2 and from the home screen's block.
 *
 * **Income: 90 days.** "Plan the income" is forward-looking, and at 30 days a
 * monthly salary shows exactly one row while an irregular client invoice due in
 * six weeks shows none at all — the window hides precisely the income worth
 * planning around. Ninety days is one quarter, which is the shortest window in
 * which an irregular payer appears at all.
 *
 * The two are deliberately never printed side by side as a pair: different
 * windows are not commensurable, and a reader who compares them has been
 * misled. They live in separate sections, each labelled with its own window,
 * and nothing on any surface subtracts one from the other.
 *
 * One query covers both — `payments.upcoming` is asked for the longer window
 * and the 30-day bill set is taken from it client-side, so the home screen and
 * the Money tab still share a single cache entry.
 */
export const PAYMENTS_HORIZON_DAYS = 30;
export const INCOME_HORIZON_DAYS = 90;

/** The fields the grouping reads off a `payments.upcoming` row. */
export interface DatedOccurrence {
  id: string;
  dueDate: string;
}

export interface OccurrenceGroup<T> {
  /** Stable React key. `overdue`, or the due date itself. */
  key: string;
  label: string;
  /** Overdue rows carry their own date in the row, since the group spans many. */
  overdue: boolean;
  items: T[];
}

/**
 * The feed's shape: everything already due in one group at the top, then one
 * group per due date, earliest first.
 *
 * Overdue leads because it is the only part of the feed that is actionable
 * *now* — `payments.upcoming` returns overdue occurrences mixed in with the
 * rest (they stay `scheduled` until settled), and a feed that sorted them by
 * date alone would bury a missed bill above the fold only by accident.
 */
export function groupUpcoming<T extends DatedOccurrence>(
  occurrences: readonly T[],
  today: string
): OccurrenceGroup<T>[] {
  const sorted = [...occurrences].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const overdue = sorted.filter((occurrence) => occurrence.dueDate < today);

  const groups: OccurrenceGroup<T>[] = [];
  if (overdue.length > 0) {
    groups.push({ key: 'overdue', label: 'Overdue', overdue: true, items: overdue });
  }

  for (const occurrence of sorted) {
    if (occurrence.dueDate < today) continue;
    const last = groups.at(-1);
    if (last && !last.overdue && last.key === occurrence.dueDate) {
      last.items.push(occurrence);
      continue;
    }
    groups.push({
      key: occurrence.dueDate,
      label: formatDate(occurrence.dueDate),
      overdue: false,
      items: [occurrence],
    });
  }

  return groups;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * "3 days overdue". Both arguments are `YYYY-MM-DD` and the difference is taken
 * in UTC — the same comparison `payments.upcoming` makes server-side, so a bill
 * due at midnight does not shift by a day for anyone east of Greenwich.
 */
export function formatOverdueBy(dueDate: string, today: string): string {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const from = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(due) || !Number.isFinite(from)) return 'Overdue';

  const days = Math.round((from - due) / DAY_MS);
  if (days <= 0) return 'Due today';
  return `${days} day${days === 1 ? '' : 's'} overdue`;
}

/** "Bill" / "Income" — the word a direction gets in the interface. v2 said
 *  "Outgoing"/"Incoming" on the feed and "Bill"/"Income" on the list, for the
 *  same field. One noun. */
export function directionLabel(direction: string): string {
  return direction === 'inflow' ? 'Income' : 'Bill';
}

/** The fields a direction split and a currency total read off a
 *  `payments.upcoming` row. `direction` is a bare `string` on the wire — the
 *  column is a Drizzle `text()`, so there is no literal union to narrow to. */
export interface DirectedOccurrence extends DatedOccurrence {
  expectedAmount: string | null;
  actualAmount: string | null;
  payment: { direction: string; currencyTokenId: string };
}

/** Money arriving rather than leaving. One predicate, so no surface decides
 *  what `inflow` means for itself. */
export function isIncome(occurrence: { payment: { direction: string } }): boolean {
  return occurrence.payment.direction === 'inflow';
}

/**
 * Bills and income, split.
 *
 * They are separated *before* anything is summed or listed, because every bug
 * this split exists to fix is the same one: a figure filtered to outflow above
 * a list that was not. Callers get two arrays and can only ever describe one of
 * them at a time.
 */
export function splitByDirection<T extends { payment: { direction: string } }>(
  occurrences: readonly T[]
): { bills: T[]; income: T[] } {
  const bills: T[] = [];
  const income: T[] = [];
  for (const occurrence of occurrences) {
    (isIncome(occurrence) ? income : bills).push(occurrence);
  }
  return { bills, income };
}

/**
 * The part of a longer lookahead that falls inside `days`.
 *
 * Overdue rows are kept: an occurrence stays `scheduled` until it is settled,
 * so a bill three weeks late is still something to cover this month, and
 * dropping it would be the same "the number and the list disagree" defect from
 * the other end. Dates are `YYYY-MM-DD` and the horizon is computed in UTC,
 * matching `payments.upcoming`'s own server-side comparison.
 */
export function withinDays<T extends DatedOccurrence>(
  occurrences: readonly T[],
  today: string,
  days: number
): T[] {
  const from = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(from)) return [...occurrences];
  const horizon = new Date(from + days * DAY_MS).toISOString().slice(0, 10);
  return occurrences.filter((occurrence) => occurrence.dueDate <= horizon);
}

/**
 * Bills already past due, and bills still ahead of them.
 *
 * `withinDays` deliberately keeps overdue rows — a bill three weeks late is
 * still money that has to move — which is right for the *list* and wrong for
 * any figure labelled with a forward window. Summed together they produced
 * "Bills committed, next 30 days: €5,314.53" over a feed whose overdue section
 * held €4,169.79 of it, one item 151 days old (SC-77 1). The same shape as the
 * bug V3-47 fixed for direction, one axis over: a total describing a different
 * set than the heading above it.
 *
 * So the split happens here, before anything is summed, and each figure names
 * its own set. The two are never added on screen and never netted: overdue is
 * not a forecast that the next thirty days can absorb, it is money that was
 * already supposed to have left.
 */
export function splitByDueness<T extends DatedOccurrence>(
  occurrences: readonly T[],
  today: string
): { overdue: T[]; ahead: T[] } {
  const overdue: T[] = [];
  const ahead: T[] = [];
  for (const occurrence of occurrences) {
    (occurrence.dueDate < today ? overdue : ahead).push(occurrence);
  }
  return { overdue, ahead };
}

/** The label over the overdue figure. The count is part of the claim: the
 *  figure is what those bills come to, not a running balance. */
export function overdueTotalLabel(count: number): string {
  return `Overdue, ${count} ${count === 1 ? 'bill' : 'bills'}`;
}

/**
 * What a set of occurrences comes to, per currency.
 *
 * A raw sum of the dated instances actually in the window — never an annualised
 * projection. `expectedAmount` leads because a variable payment's estimate is
 * what the reader was shown when they created it; `actualAmount` only stands in
 * where there is no estimate at all.
 *
 * Stops at the per-currency map on purpose: V3-52 owns the step after it, and
 * `convertTotalsToBase` — via `<ConvertedTotal>` / `<ConvertedFigure>` — is the
 * only place a rate is applied. So both figures on the Money tab, the bills one
 * and the income one, reach the screen through the same conversion and carry
 * the same disclosures about it.
 */
export function occurrenceTotals(occurrences: readonly DirectedOccurrence[]): Map<string, Decimal> {
  return sumAmountsByCurrency(
    occurrences.map((occurrence) => ({
      amount: occurrence.expectedAmount ?? occurrence.actualAmount ?? '0',
      currencyTokenId: occurrence.payment.currencyTokenId,
    }))
  );
}

/** How many payments point at each vendor — the one figure the vendor list has
 *  to show, and the one v2 recomputed inline on every render. */
export function countByVendorId(payments: readonly { vendorId: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const payment of payments) {
    counts.set(payment.vendorId, (counts.get(payment.vendorId) ?? 0) + 1);
  }
  return counts;
}

/**
 * How many scheduled dates `payments.end` would delete, given the
 * occurrences the payment has today.
 *
 * Mirrors `PaymentService.end` exactly: it deletes `scheduled` rows due
 * strictly AFTER the end date (a row due ON the end date is still
 * expected), and leaves settled history — `paid`, `skipped` — alone.
 * Kept as a pure function next to the surface rather than derived in the
 * component so the sentence the reader is asked to agree to is the one
 * under test.
 */
export function occurrencesEndWouldRemove(
  occurrences: readonly { status: string; dueDate: string }[],
  endDate: string
): number {
  return occurrences.filter(
    (occurrence) => occurrence.status === 'scheduled' && occurrence.dueDate > endDate
  ).length;
}

/**
 * What ending a payment does, naming the vendor and the exact number of
 * dates that disappear. `null` occurrences means the count has not
 * arrived yet — the sentence stays honest about that rather than
 * guessing a number and correcting it a moment later.
 */
export function endConsequence(
  vendorName: string,
  endDate: string,
  removedCount: number | null
): string {
  const base = `Ends ${vendorName} on ${formatDate(endDate)}. It stops appearing in Upcoming, and its paid and skipped history is kept.`;
  if (removedCount === null) return `${base} Checking how many scheduled dates this removes…`;
  if (removedCount === 0) return `${base} There are no scheduled dates after that to remove.`;
  const dates = removedCount === 1 ? '1 scheduled date' : `${removedCount} scheduled dates`;
  return `${base} ${dates} after that ${removedCount === 1 ? 'is' : 'are'} removed. This cannot be undone — reviving an ended payment is not something Scani can do.`;
}

/**
 * The occurrences a delete would destroy, by what they mean.
 *
 * A client-side twin of `PaymentService`'s own count, and deliberately the
 * same fallthrough: anything that is neither `scheduled` nor `skipped` counts
 * as settled. It reads `payments.get`, which the peek already fetches for
 * `End`, so the delete confirmation costs no second round trip — and the
 * server recounts before it writes, so this is what the sentence says, never
 * what the decision rests on.
 */
export interface PaymentDeleteCounts {
  scheduled: number;
  settled: number;
  skipped: number;
}

export function paymentDeleteCounts(
  occurrences: readonly { status: string }[]
): PaymentDeleteCounts {
  let scheduled = 0;
  let settled = 0;
  let skipped = 0;
  for (const occurrence of occurrences) {
    if (occurrence.status === 'scheduled') scheduled += 1;
    else if (occurrence.status === 'skipped') skipped += 1;
    else settled += 1;
  }
  return { scheduled, settled, skipped };
}

function dateCount(count: number): string {
  return count === 1 ? '1 date' : `${count} dates`;
}

/**
 * What deleting a payment does — and, when it cannot be done, why, in the
 * words that distinguish it from `End`.
 *
 * The two actions sit beside each other in the same action row, so this
 * sentence carries the whole distinction: *ended* is a true fact about a bill
 * that really ran, *deleted* is "this should never have existed". A reader who
 * cannot tell them apart will reach for the wrong one, and only one of them is
 * reversible by re-creating the record.
 */
export function paymentDeleteConsequence(
  vendorName: string,
  counts: PaymentDeleteCounts | null,
  /**
   * The payment has already ended, so "End it instead" is not a next step — it
   * is a description of what already happened. The refusal is the same; only
   * the way out of it differs, and offering one that has already been taken is
   * the dead end SC-113 is about wearing different words.
   */
  alreadyEnded = false
): string {
  if (!counts) {
    return `Deletes the ${vendorName} payment. Checking what it has against it…`;
  }
  if (counts.settled > 0) {
    const wayOut = alreadyEnded
      ? 'It has already ended, so the schedule is stopped and the record stays.'
      : 'End it instead: the schedule stops and the record stays.';
    return `This payment has ${dateCount(counts.settled)} settled against it — money that really moved. It cannot be deleted, because that would erase the history too. ${wayOut}`;
  }
  const discarded: string[] = [];
  if (counts.scheduled > 0) discarded.push(`${dateCount(counts.scheduled)} still scheduled`);
  if (counts.skipped > 0) discarded.push(`${dateCount(counts.skipped)} you skipped`);
  // The verb agrees with the whole subject, not with the last noun in it —
  // same rule `mergeConsequence` follows.
  const discardedTotal = counts.scheduled + counts.skipped;
  const tail =
    discarded.length > 0
      ? ` ${discarded.join(' and ')} ${discardedTotal === 1 ? 'goes' : 'go'} with it.`
      : '';
  return `Deletes the ${vendorName} payment as if it had never existed.${tail} It leaves Upcoming, the totals and this list. Use End instead if this bill really ran — that keeps the record. This cannot be undone.`;
}

/** What `vendors.deletePreview` returns, as the confirmation needs it. */
export interface VendorDeleteCounts {
  payments: number;
  aliases: number;
  extractions: number;
}

/**
 * What deleting a vendor does, or why it will not happen.
 *
 * The refusal is a sentence rather than a disabled button with a tooltip: on a
 * phone there is no hover, and "why can I not do this" is the whole question
 * the reader has at that moment. It names the count and it names the two ways
 * out, because a refusal with no next step is a dead end.
 *
 * The extraction count is stated even though it does not block. Its link is
 * cut silently by `ON DELETE SET NULL` — the half of the SC-31 bug that
 * succeeded — so it is exactly the consequence a reader would otherwise never
 * find out about.
 */
export function vendorDeleteConsequence(
  vendorName: string,
  counts: VendorDeleteCounts | null
): string {
  if (!counts) return `Deletes "${vendorName}". Checking what points at it…`;
  if (counts.payments > 0) {
    const payments = counts.payments === 1 ? '1 payment' : `${counts.payments} payments`;
    return `"${vendorName}" still has ${payments} pointing at it, and deleting it would take ${counts.payments === 1 ? 'that payment' : 'those payments'} and everything settled against ${counts.payments === 1 ? 'it' : 'them'}. End or delete ${counts.payments === 1 ? 'it' : 'them'} first, or merge "${vendorName}" into the vendor you meant.`;
  }
  const also: string[] = [];
  if (counts.aliases > 0) {
    also.push(
      counts.aliases === 1
        ? '1 alias it has been seen under goes with it'
        : `${counts.aliases} aliases it has been seen under go with it`
    );
  }
  if (counts.extractions > 0) {
    also.push(
      counts.extractions === 1
        ? '1 parsed invoice keeps its own record but loses its link to this vendor'
        : `${counts.extractions} parsed invoices keep their own records but lose their link to this vendor`
    );
  }
  const tail = also.length > 0 ? ` ${also.join('; ')}.` : '';
  return `Deletes "${vendorName}". Nothing is paid to or by it.${tail} This cannot be undone.`;
}

/** A vendor as the merge picker needs it. */
export interface MergeCandidate {
  id: string;
  displayName: string;
}

/**
 * The candidates a query leaves, in the order they were given.
 *
 * Case- and whitespace-insensitive substring matching, deliberately no fuzzier
 * than that: `vendors.similar` does near-duplicate detection with measured
 * thresholds (V3-49) and this is not a second, weaker copy of it. Here the
 * reader already knows which row they mean and is only trying to reach it
 * without scrolling 21 vendors on a phone — an over-eager match would put a
 * different vendor under the finger on a control that deletes one.
 */
export function filterMergeCandidates<T extends MergeCandidate>(
  candidates: readonly T[],
  query: string
): T[] {
  const term = query.trim().toLowerCase();
  if (!term) return [...candidates];
  return candidates.filter((candidate) => candidate.displayName.toLowerCase().includes(term));
}

/**
 * What merging does, named in both directions so "which absorbs which" is
 * never inferred from button order. `impact` null while the counts load.
 */
export function mergeConsequence(
  survivorName: string,
  duplicateName: string,
  impact: { payments: number; aliases: number } | null
): string {
  const base = `"${duplicateName}" is deleted and "${survivorName}" is kept.`;
  if (!impact) return `${base} Checking what moves across…`;
  const moved: string[] = [];
  if (impact.payments > 0) {
    moved.push(impact.payments === 1 ? '1 payment' : `${impact.payments} payments`);
  }
  if (impact.aliases > 0) {
    moved.push(impact.aliases === 1 ? '1 alias' : `${impact.aliases} aliases`);
  }
  if (moved.length === 0) {
    return `${base} Nothing points at "${duplicateName}", so nothing moves. This cannot be undone.`;
  }
  // "1 payment moves", "2 payments move", "1 payment and 1 alias move" — the
  // verb agrees with the whole subject, not with the last noun in it.
  const verb = impact.payments + impact.aliases === 1 ? 'moves' : 'move';
  return `${base} ${moved.join(' and ')} ${verb} to "${survivorName}". This cannot be undone.`;
}
