import { type Decimal, formatDate } from '@scani/shared';
import { stripTrailingSlash } from '@scani/ui/v3/lib/path';
import type { TFunction } from 'i18next';
import { sumAmountsByCurrency } from './paymentTotals';
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
  /** Segmented-control label, as an i18n key — this table is plain data and
   *  has no `t` (SC-201). Same shape as `V3_TAB_ITEMS`. */
  labelKey: string;
  path: string;
}

export const MONEY_SEGMENTS: readonly MoneySegmentDef[] = [
  { key: 'upcoming', labelKey: 'v3.money.segments.upcoming', path: V3_ROUTES.money },
  { key: 'recurring', labelKey: 'v3.money.segments.recurring', path: V3_ROUTES.recurring },
  { key: 'vendors', labelKey: 'v3.money.segments.vendors', path: V3_ROUTES.vendors },
];

/** The default view. Bills have deadlines; the standing list does not. */
export const DEFAULT_MONEY_SEGMENT: MoneySegment = 'upcoming';

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
  t: TFunction,
  occurrences: readonly T[],
  today: string
): OccurrenceGroup<T>[] {
  const sorted = [...occurrences].sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const overdue = sorted.filter((occurrence) => occurrence.dueDate < today);

  const groups: OccurrenceGroup<T>[] = [];
  if (overdue.length > 0) {
    groups.push({
      key: 'overdue',
      label: t('v3.money.group.overdue'),
      overdue: true,
      items: overdue,
    });
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
export function formatOverdueBy(dueDate: string, today: string, t: TFunction): string {
  const due = Date.parse(`${dueDate}T00:00:00Z`);
  const from = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(due) || !Number.isFinite(from)) return t('v3.money.overdue.unknown');

  const days = Math.round((from - due) / DAY_MS);
  if (days <= 0) return t('v3.money.overdue.today');
  return t('v3.money.overdue.byDays', { count: days });
}

/** "Bill" / "Income" — the word a direction gets in the interface. v2 said
 *  "Outgoing"/"Incoming" on the feed and "Bill"/"Income" on the list, for the
 *  same field. One noun. */
export function directionLabel(direction: string, t: TFunction): string {
  return direction === 'inflow' ? t('v3.money.direction.income') : t('v3.money.direction.bill');
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
  removedCount: number | null,
  t: TFunction
): string {
  // Two whole SENTENCES joined by a space, not two fragments (SC-201). A
  // sentence boundary is the one join that is safe in every language; the verb
  // agreement and the count both live inside their own sentence's key.
  const base = t('v3.money.endPayment.base', { vendor: vendorName, date: formatDate(endDate) });
  if (removedCount === null) return `${base} ${t('v3.money.endPayment.checking')}`;
  if (removedCount === 0) return `${base} ${t('v3.money.endPayment.noneRemoved')}`;
  return `${base} ${t('v3.money.endPayment.removed', { count: removedCount })}`;
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

/**
 * The two clauses a discarded-dates sentence can be built from, and the frame
 * that joins them (SC-201).
 *
 * "1 date still scheduled and 2 dates you skipped go with it" cannot be one
 * key: i18next pluralises on ONE `count`, and this sentence counts two things
 * whose forms vary independently. So each clause is its own pluralised key and
 * the frame is a third — which is also what gives a translator the freedom to
 * move the verb, drop the conjunction, or reorder the clauses. The English
 * verb agrees with the TOTAL, not with the last noun, so the frame is chosen
 * on the total.
 *
 * FRAGILE, flagged not fixed: `listAnd` hard-codes a two-item conjunction.
 * `Intl.ListFormat` is the right answer and belongs with step 5, alongside the
 * `join(', ')` currency lists in `ConvertedTotal`.
 */
function discardedClauses(counts: PaymentDeleteCounts, t: TFunction): string {
  const clauses: string[] = [];
  if (counts.scheduled > 0) {
    clauses.push(t('v3.money.deletePayment.clauseScheduled', { count: counts.scheduled }));
  }
  if (counts.skipped > 0) {
    clauses.push(t('v3.money.deletePayment.clauseSkipped', { count: counts.skipped }));
  }
  if (clauses.length === 0) return '';
  const joined =
    clauses.length === 1
      ? clauses[0]
      : t('v3.common.listAnd', { first: clauses[0], second: clauses[1] });
  const total = counts.scheduled + counts.skipped;
  return ` ${t('v3.money.deletePayment.discarded', { count: total, clauses: joined })}`;
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
  t: TFunction,
  /**
   * The payment has already ended, so "End it instead" is not a next step — it
   * is a description of what already happened. The refusal is the same; only
   * the way out of it differs, and offering one that has already been taken is
   * the dead end SC-113 is about wearing different words.
   */
  alreadyEnded = false
): string {
  if (!counts) return t('v3.money.deletePayment.checking', { vendor: vendorName });
  if (counts.settled > 0) {
    const wayOut = alreadyEnded
      ? t('v3.money.deletePayment.wayOutEnded')
      : t('v3.money.deletePayment.wayOutEnd');
    return `${t('v3.money.deletePayment.blocked', { count: counts.settled })} ${wayOut}`;
  }
  return `${t('v3.money.deletePayment.lead', { vendor: vendorName })}${discardedClauses(counts, t)} ${t('v3.money.deletePayment.tail')}`;
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
  counts: VendorDeleteCounts | null,
  t: TFunction
): string {
  if (!counts) return t('v3.money.deleteVendor.checking', { vendor: vendorName });
  // The blocked sentence carries FOUR agreements off one count — "those
  // payments", "against them", "delete them" — so it is one key per plural
  // form rather than a frame with pronouns interpolated into it. A language
  // that marks case would otherwise get an English pronoun table.
  if (counts.payments > 0) {
    return t('v3.money.deleteVendor.blocked', { count: counts.payments, vendor: vendorName });
  }
  const also: string[] = [];
  if (counts.aliases > 0) {
    also.push(t('v3.money.deleteVendor.alsoAliases', { count: counts.aliases }));
  }
  if (counts.extractions > 0) {
    also.push(t('v3.money.deleteVendor.alsoExtractions', { count: counts.extractions }));
  }
  // Semicolon-joined, and the separator is the translator's — see
  // `discardedClauses` for why this is a frame key rather than a `join`.
  const joined =
    also.length === 0
      ? ''
      : also.length === 1
        ? also[0]
        : t('v3.common.listSemicolon', { first: also[0], second: also[1] });
  const tail = joined ? ` ${t('v3.money.deleteVendor.alsoFrame', { clauses: joined })}` : '';
  return `${t('v3.money.deleteVendor.lead', { vendor: vendorName })}${tail} ${t('v3.common.cannotBeUndone')}`;
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
  impact: { payments: number; aliases: number } | null,
  t: TFunction
): string {
  const base = t('v3.money.mergeVendor.base', {
    duplicate: duplicateName,
    survivor: survivorName,
  });
  if (!impact) return `${base} ${t('v3.money.mergeVendor.checking')}`;
  const moved: string[] = [];
  if (impact.payments > 0) {
    moved.push(t('v3.money.mergeVendor.clausePayments', { count: impact.payments }));
  }
  if (impact.aliases > 0) {
    moved.push(t('v3.money.mergeVendor.clauseAliases', { count: impact.aliases }));
  }
  if (moved.length === 0) {
    return `${base} ${t('v3.money.mergeVendor.nothingMoves', { duplicate: duplicateName })}`;
  }
  const joined =
    moved.length === 1 ? moved[0] : t('v3.common.listAnd', { first: moved[0], second: moved[1] });
  // The verb agrees with the whole subject, not with the last noun in it, so
  // the frame is chosen on the TOTAL — see `discardedClauses`.
  const total = impact.payments + impact.aliases;
  return `${base} ${t('v3.money.mergeVendor.moves', { count: total, clauses: joined, survivor: survivorName })}`;
}
