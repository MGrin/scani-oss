import type {
  AnsweredTransferReview,
  PendingTransferReview,
  TransferCandidate,
  TransferReviewDecision,
  TransferReviewSplitPortion,
} from '@scani/shared';
import {
  Decimal,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  formatRelative,
  moneyDecimals,
  quantityDecimals,
  TRANSFER_MATCH_WINDOW_LABEL,
  TRANSFER_REVIEW_SPLIT,
} from '@scani/shared';

/**
 * The transfer-review surface's pure half — the words, and the ordering.
 *
 * Kept out of the components because these strings are the whole product here.
 * The queue is a list of questions, and a question a reader cannot answer is
 * worse than no question: it converts a wrong number they could not see into a
 * chore they cannot finish. So every sentence below names a *specific*
 * difference between two rows, never "we were unsure".
 */

/**
 * What Scani does with a transfer nobody has answered yet.
 *
 * ONE constant, read by the list's banner and by the peek, because it is a
 * claim about behaviour and a surface that says two different things about the
 * same behaviour is worse than one that says nothing.
 *
 * Until the second half of SC-150 landed this described the *defect* — an
 * unpaired outflow was realized at market value, inventing a disposal and a
 * gain the user never made. `CostBasisService` no longer does that, so the
 * sentence changed with it: an unanswered transfer books nothing, and what
 * remains on the reader is that a real off-platform sale sitting in here is
 * missing from their realized total until they say so.
 *
 * That is the honest trade and it is worth stating plainly rather than
 * softening: the error used to be invisible and always upward, and is now
 * visible, answerable, and in the direction that does not flatter anyone.
 */
export const UNREVIEWED_TRANSFER_BEHAVIOUR =
  'While these are unanswered, Scani books no gain on them — moving your own coins is not a sale, and guessing that it was is how an invented gain gets onto your chart. If one of these really did leave your portfolio, its gain is missing from your realized total until you say so.';

/**
 * The same claim, for the peek — where a reader who followed a deep link never
 * saw the list's banner, and where there is room for one line and not four.
 *
 * It changes with the constant above and for the same reason. Two strings
 * rather than one because they are read in different places at different
 * widths; keeping them adjacent is what stops them saying different things.
 */
export const UNREVIEWED_TRANSFER_NOTE = 'Unanswered, this books no gain either way.';

/**
 * Why the matcher would not take a candidate on its own — the reader-facing
 * half of `TRANSFER_CANDIDATE_REASONS`.
 *
 * It must not restate what `candidateSummary` already shows on the line above
 * it. The first version rendered "0.25 BTC · 4 h later" and then "4 h apart"
 * directly under it, which spends a line to say the same number twice and
 * still never says what the reader actually needs: that 4 hours is *outside
 * the rule*. Naming the rule is the whole job.
 */
export function candidateReasonLabel(candidate: TransferCandidate): string {
  switch (candidate.reason) {
    case 'ambiguous':
      return 'Matches — but so does another deposit';
    case 'quantity_outside_tolerance':
      return `Amount differs by ${formatPercent(candidate.quantityDeltaPct)}`;
    case 'time_outside_window':
      return `Outside the ${TRANSFER_MATCH_WINDOW_LABEL} window we match on`;
    default:
      return `${formatPercent(candidate.quantityDeltaPct)} off, and outside the ${TRANSFER_MATCH_WINDOW_LABEL} window`;
  }
}

/**
 * The one-line summary of a candidate: what landed, where, and when relative
 * to the withdrawal.
 *
 * Relative rather than absolute, because the judgement is a comparison. "12
 * minutes later" is the fact that settles it; "14 Aug 2026, 09:42" makes the
 * reader do the subtraction themselves, on a phone, from two timestamps that
 * may be in different lines of the sheet.
 */
export function candidateSummary(candidate: TransferCandidate, tokenSymbol: string): string {
  return `${candidate.quantity} ${tokenSymbol} · ${formatSignedGap(candidate.timeDeltaMs)}`;
}

/** Where a candidate landed, in the words the accounts list uses. */
export function candidateLocation(candidate: TransferCandidate): string {
  return candidate.institutionName
    ? `${candidate.institutionName} · ${candidate.accountName}`
    : candidate.accountName;
}

export function pendingLocation(item: {
  accountName: string;
  institutionName: string | null;
}): string {
  return item.institutionName ? `${item.institutionName} · ${item.accountName}` : item.accountName;
}

/**
 * What the row says about its own answerability, in the list.
 *
 * "No close deposit found" is a real answer and a common one — a withdrawal to
 * a cold wallet Scani does not track has no other leg to find — so it reads as
 * a finding rather than as a failure to look.
 *
 * Short because it shares one line with the account name at 390px, behind a
 * `truncate`. The first draft read "No deposit close enough to be a candidate"
 * and rendered as "No deposit close enoug…", which is the half that says
 * nothing: the reader learns there is a deposit and not that there isn't. The
 * full sentence still exists where there is room for it — in the peek, next to
 * the three answers.
 */
export function candidateHint(item: PendingTransferReview): string {
  const strict = item.candidates.filter((c) => c.withinStrictTolerance).length;
  if (strict > 1) return `${strict} equally good matches`;
  if (item.candidates.length === 0) return 'No close deposit found';
  if (item.candidates.length === 1) return '1 possible match';
  return `${item.candidates.length} possible matches`;
}

/**
 * What each answer does, stated in the reader's own terms — `ConfirmAction`
 *  requires a consequence and this is where the three of them live.
 *
 * **The figures are formatted, not interpolated** (SC-173). This is the last
 * sentence between a person and an irreversible answer that moves realized PnL,
 * and it read `about 3041.163666295339 EUR` — a raw twelve-decimal float and a
 * trailing ISO code, against the same figure rendered `€3,041.16` three times
 * elsewhere on the same sheet. Both branches of that mistake are here: the
 * amount goes through `formatCurrency` like every other consumer of the field,
 * and the quantity through the precision it actually carries rather than
 * whatever the wire happened to send.
 */
export function decisionConsequence(
  decision: TransferReviewDecision,
  item: PendingTransferReview,
  chosen: TransferCandidate | null
): string {
  switch (decision) {
    case 'paired':
      return chosen
        ? `The ${formatNumber(item.quantity, { decimals: quantityDecimals(item.quantity) })} ${item.tokenSymbol} keeps what you originally paid for it as it moves to ${candidateLocation(chosen)}. Nothing is realized here, and no gain is booked.`
        : 'Pick the deposit this money arrived in.';
    case 'left_control':
      // The date is the one the reader just read in the sheet's `When` fact,
      // eight lines above — so it is the same formatter, not a bare
      // `toLocaleDateString()` that follows the runtime into D/M/Y while the
      // row behind the scrim says M/D/Y (SC-175).
      return item.marketValueInBase
        ? `Counted as a disposal on ${formatDate(item.occurredAt)} at market value — about ${formatCurrency(item.marketValueInBase, item.baseCurrencyCode, { decimals: moneyDecimals(item.marketValueInBase) })} of proceeds against what you paid.`
        : `Counted as a disposal on ${formatDate(item.occurredAt)} at market value. Scani has no price for ${item.tokenSymbol} that day, so nothing is booked.`;
    default:
      return `Still yours, just somewhere Scani cannot see. Not a disposal, so no gain is booked — the ${item.tokenSymbol} simply stops being counted.`;
  }
}

export const DECISION_LABELS: Record<TransferReviewDecision, { trigger: string; commit: string }> =
  {
    // The commit is the sentence's verb applied to the object, never the
    // trigger's noun — `ConfirmAction`'s second rule.
    paired: { trigger: 'Same money', commit: 'Link these two' },
    left_control: { trigger: 'It left my portfolio', commit: 'Count it as a disposal' },
    untracked: { trigger: 'Moved somewhere untracked', commit: 'Record it as still mine' },
  };

/**
 * A row in the split editor: one outcome, and how much of the transfer it
 * accounts for (SC-181).
 *
 * The editor renders **all three outcomes, always**, and a row with an empty
 * amount is simply not part of the answer. That is what removes the add/remove
 * machinery a list editor would need, makes "each outcome at most once"
 * structurally impossible to violate rather than validated after the fact, and
 * matches how the case was reported — "I want to be able to edit the numbers
 * to track vs not track here" is three known outcomes and two numbers, not a
 * builder.
 *
 * `amount` is the reader's own text, not a Decimal, because `3.` and `` are
 * states a person passes through while typing a number.
 */
export interface SplitDraftRow {
  decision: TransferReviewDecision;
  amount: string;
  matchTransactionId: string | null;
}

/** The rows that are actually part of the answer. */
export function filledRows(rows: readonly SplitDraftRow[]): SplitDraftRow[] {
  return rows.filter((row) => row.amount.trim() !== '');
}

/** Where a draft split stands against the transfer it divides. */
export interface SplitAllocation {
  /** The parts' sum, or null when any amount is not yet a number. */
  total: Decimal | null;
  /** Signed: positive means still to allocate, negative means over. */
  remaining: Decimal | null;
  status: 'empty' | 'unparseable' | 'under' | 'over' | 'exact';
}

/**
 * The arithmetic behind the commit button, kept out of the component so it can
 * be tested without a DOM — and because it is the rule the ticket is about.
 *
 * A split that does not add up to the transaction is a new way to be wrong
 * about money, so the editor cannot commit unless this returns `exact`. The
 * API checks the same thing against the row itself; this one exists so the
 * reader finds out while they are still typing rather than after a round trip.
 */
export function allocationOf(rows: readonly SplitDraftRow[], quantity: string): SplitAllocation {
  const target = new Decimal(quantity).abs();
  if (rows.every((r) => r.amount.trim() === '')) {
    return { total: new Decimal(0), remaining: target, status: 'empty' };
  }
  let total = new Decimal(0);
  for (const row of rows) {
    if (row.amount.trim() === '') continue;
    let parsed: Decimal;
    try {
      parsed = new Decimal(row.amount);
    } catch {
      return { total: null, remaining: null, status: 'unparseable' };
    }
    if (!parsed.isFinite() || parsed.lt(0)) {
      return { total: null, remaining: null, status: 'unparseable' };
    }
    total = total.add(parsed);
  }
  const remaining = target.minus(total);
  return {
    total,
    remaining,
    status: remaining.isZero() ? 'exact' : remaining.gt(0) ? 'under' : 'over',
  };
}

/**
 * What is left to allocate, as a sentence.
 *
 * Always the amount, never "the parts do not add up" — the reader is holding
 * two numbers in their head on a phone and the useful thing is the third one.
 */
export function allocationHint(
  allocation: SplitAllocation,
  item: PendingTransferReview
): string | null {
  const unit = item.tokenSymbol;
  switch (allocation.status) {
    case 'exact':
      return null;
    case 'unparseable':
      return 'One of those amounts is not a number.';
    case 'over':
      return `That is ${qty(allocation.remaining?.abs())} ${unit} more than the transfer.`;
    default:
      return `${qty(allocation.remaining)} ${unit} still to account for.`;
  }
}

/**
 * The remainder, as the string an amount field can take verbatim.
 *
 * **Only offered on a row that is still empty.** The first phone capture had
 * it on the row the reader had just typed `3500` into, where the other rows
 * summed to nothing and it therefore read "Take the rest — 4,000 USD": a
 * button offering to overwrite the number they had entered with the whole
 * transfer, sitting directly under it. Filling a blank is arithmetic; replacing
 * an answer is not.
 */
export function remainderFor(
  rows: readonly SplitDraftRow[],
  index: number,
  quantity: string
): string | null {
  if (rows[index]?.amount.trim() !== '') return null;
  const others = rows.filter((_, i) => i !== index);
  const allocation = allocationOf(others, quantity);
  if (allocation.remaining === null || allocation.remaining.lte(0)) return null;
  return allocation.remaining.toString();
}

/**
 * A draft is committable when at least two outcomes carry an amount, every
 * amount is a positive number, a `paired` part has its deposit, and the whole
 * thing adds up exactly.
 *
 * One filled row is a *whole* answer, not a split, and is refused here rather
 * than silently converted: the three whole answers are one tap away and each
 * states its own consequence, so quietly turning "3,500 untracked" into "all
 * of it untracked" would commit a claim about 4,000 the reader made about
 * 3,500.
 */
export function splitIsCommittable(
  rows: readonly SplitDraftRow[],
  item: PendingTransferReview
): boolean {
  const filled = filledRows(rows);
  if (filled.length < 2) return false;
  if (filled.some((r) => r.decision === 'paired' && !r.matchTransactionId)) return false;
  const allocation = allocationOf(filled, item.quantity);
  if (allocation.status !== 'exact') return false;
  return filled.every((r) => {
    try {
      return new Decimal(r.amount).gt(0);
    } catch {
      return false;
    }
  });
}

/** Draft rows as the wire shape, once `splitIsCommittable` says they are one. */
export function toSplitPortions(rows: readonly SplitDraftRow[]): TransferReviewSplitPortion[] {
  return filledRows(rows).map((row) => ({
    decision: row.decision,
    quantity: new Decimal(row.amount).toString(),
    ...(row.decision === 'paired' && row.matchTransactionId
      ? { matchTransactionId: row.matchTransactionId }
      : {}),
  }));
}

/**
 * What committing this division does, part by part.
 *
 * `ConfirmAction` requires a consequence and the split's is longer than the
 * others by necessity: it is three claims, and the reader is about to commit
 * all of them at once. Each line is one part, with its amount, so the sentence
 * they check is the same arithmetic they just typed.
 */
export function splitConsequence(
  rows: readonly SplitDraftRow[],
  item: PendingTransferReview,
  candidateFor: (id: string | null) => TransferCandidate | null
): string {
  if (!splitIsCommittable(rows, item)) {
    return `Give at least two of these an amount. Together they have to come to ${qty(new Decimal(item.quantity).abs())} ${item.tokenSymbol}.`;
  }
  const clauses = filledRows(rows).map((row) => {
    const amount = `${qty(new Decimal(row.amount))} ${item.tokenSymbol}`;
    switch (row.decision) {
      case 'paired': {
        const chosen = candidateFor(row.matchTransactionId);
        return `${amount} keeps what you paid for it as it moves to ${chosen ? candidateLocation(chosen) : 'the deposit you picked'}`;
      }
      case 'left_control':
        return `${amount} is counted as a disposal at market value on ${formatDate(item.occurredAt)}`;
      default:
        return `${amount} is still yours, somewhere Scani cannot see`;
    }
  });
  return `${clauses.join('. ')}. Only the disposal books a gain.`;
}

/** The trigger and commit labels for the split, in `DECISION_LABELS`' shape. */
export const SPLIT_LABELS = {
  trigger: 'It was more than one of these',
  commit: 'Record this division',
};

/**
 * What a reader is told before they open the editor.
 *
 * Names the reported case rather than describing the feature, because "split
 * across outcomes" is a data model and "part of it moved, part of it left" is
 * a thing that happened to them.
 */
export const SPLIT_NOTE =
  'A withdrawal can be more than one thing at once — part moved to an account Scani cannot see, part genuinely left. Divide it and each part is treated on its own.';

/** How an answer already given reads in the answered list. */
export function answeredSummary(item: AnsweredTransferReview): string {
  if (item.decision !== TRANSFER_REVIEW_SPLIT || !item.split) {
    return ANSWER_SUMMARIES[item.decision] ?? 'Answered';
  }
  return item.split
    .map((portion) => `${qty(new Decimal(portion.quantity))} ${ANSWER_SHORT[portion.decision]}`)
    .join(' · ');
}

const ANSWER_SUMMARIES: Record<string, string> = {
  paired: 'Linked to a deposit — nothing realized',
  left_control: 'Counted as a disposal',
  untracked: 'Still yours, somewhere untracked',
};

const ANSWER_SHORT: Record<TransferReviewDecision, string> = {
  paired: 'linked',
  left_control: 'disposed',
  untracked: 'untracked',
};

/** A quantity at the precision it actually carries, never a raw Decimal. */
function qty(value: Decimal | null | undefined): string {
  if (!value) return '';
  const asString = value.toString();
  return formatNumber(asString, { decimals: quantityDecimals(asString) });
}

/**
 * Newest first by default, matching every other list in v3.
 *
 * The direction is applied HERE — `useDataView` hands it in and does not
 * invert the result itself, so a comparator that ignores the fourth argument
 * silently sorts ascending under a control that says "Newest". That is what
 * the first phone capture showed: a 30-day-old withdrawal at the top of a list
 * whose sort read `occurred · desc`.
 */
export function comparePendingTransfers(
  a: PendingTransferReview,
  b: PendingTransferReview,
  field: string,
  direction: string
): number {
  const mult = direction === 'asc' ? 1 : -1;
  if (field === 'amount') {
    return (Number(a.marketValueInBase ?? 0) - Number(b.marketValueInBase ?? 0)) * mult;
  }
  if (field === 'token') return a.tokenSymbol.localeCompare(b.tokenSymbol) * mult;
  return (new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime()) * mult;
}

export function pendingTransferMatches(item: PendingTransferReview, term: string): boolean {
  const haystack = [
    item.tokenSymbol,
    item.tokenName,
    item.accountName,
    item.institutionName,
    item.counterparty,
    item.description,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(term.toLowerCase());
}

/** `formatRelative` on the withdrawal's own timestamp — re-exported through
 *  here so the components import one module rather than two. */
export function occurredLabel(iso: string): string {
  return formatRelative(new Date(iso));
}

/**
 * The withdrawal's actual moment, to the minute.
 *
 * This built its own `toLocaleString` because the shared helper defaulted to
 * `en-US` and this screen needed the reader's locale — a real reason at the
 * time, and the reason the peek and the row above it printed the same instant
 * two ways. The default is gone (`@scani/shared/format/date`), so the local
 * copy was only a second date format on a surface whose entire job is deciding
 * whether two timestamps are the same movement of money (SC-175).
 *
 * `dateStyle: 'medium'` still drops the seconds, which is the other half of
 * why this line exists: seconds are noise on a row whose neighbouring facts
 * are gaps of minutes and hours.
 */
export function exactMoment(iso: string): string {
  return formatDateTime(iso);
}

function formatPercent(pct: number): string {
  const abs = Math.abs(pct);
  // Two decimals below 1%: the difference between 0.4% and 0.9% is the
  // difference between "a fee" and "not the same transfer", and rounding both
  // to "0%" erases the only number on the row.
  return `${abs < 1 ? abs.toFixed(2) : abs.toFixed(1)}%`;
}

/** A signed gap, for a candidate's position relative to the withdrawal. */
function formatSignedGap(ms: number): string {
  if (Math.abs(ms) < 60_000) return 'same minute';
  return ms >= 0 ? `${humaniseGap(ms)} later` : `${humaniseGap(-ms)} earlier`;
}

function humaniseGap(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}
