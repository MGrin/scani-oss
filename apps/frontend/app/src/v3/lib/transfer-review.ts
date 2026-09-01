import type {
  AnsweredTransferReview,
  BulkTransferDecision,
  BulkTransferPreview,
  BulkTransferRefusal,
  PendingTransferReview,
  TransferCandidate,
  TransferDestination,
  TransferReviewDecision,
  TransferReviewSplitPortion,
} from '@scani/shared';
import {
  accountLabel,
  Decimal,
  formatCurrency,
  formatDate,
  formatDateTime,
  formatNumber,
  isLinkingDecision,
  moneyDecimals,
  quantityDecimals,
  TRANSFER_MATCH_WINDOW_LABEL,
  TRANSFER_REVIEW_SPLIT,
} from '@scani/shared';
import type { TFunction } from 'i18next';
import { formatRelative } from './relative-time';

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
export const UNREVIEWED_TRANSFER_BEHAVIOUR_KEY = 'v3.review.transfer.unreviewedBehaviour';

/**
 * The same claim, for the peek — where a reader who followed a deep link never
 * saw the list's banner, and where there is room for one line and not four.
 *
 * It changes with the constant above and for the same reason. Two strings
 * rather than one because they are read in different places at different
 * widths; keeping them adjacent is what stops them saying different things.
 */
export const UNREVIEWED_TRANSFER_NOTE_KEY = 'v3.review.transfer.unreviewedNote';

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
export function candidateReasonLabel(t: TFunction, candidate: TransferCandidate): string {
  const pct = formatPercent(candidate.quantityDeltaPct);
  switch (candidate.reason) {
    case 'ambiguous':
      return t('v3.review.transfer.candidateReason.ambiguous');
    case 'quantity_outside_tolerance':
      return t('v3.review.transfer.candidateReason.quantity', { pct });
    case 'time_outside_window':
      return t('v3.review.transfer.candidateReason.time', { window: TRANSFER_MATCH_WINDOW_LABEL });
    default:
      return t('v3.review.transfer.candidateReason.both', {
        pct,
        window: TRANSFER_MATCH_WINDOW_LABEL,
      });
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
 *
 * The symbol comes from the CANDIDATE, not from the withdrawal being answered
 * (SC-336). A bridge's arrival is a different token row on a different chain,
 * and naming it after the row it might be paired with would hide the one
 * difference the reader most needs to see.
 */
export function candidateSummary(t: TFunction, candidate: TransferCandidate): string {
  return `${candidate.quantity} ${candidate.tokenSymbol} · ${formatSignedGap(t, candidate.timeDeltaMs)}`;
}

/**
 * Where a candidate landed, in the words the accounts list uses.
 *
 * `accountLabel` rather than a join, for the same reason `destinationLocation`
 * uses it: these three sit on ONE sheet, and fixing `Airwallex · Airwallex` in
 * the destination picker while the candidate row above it still reads that way
 * would answer the report on one line of the screen it was reported about.
 */
export function candidateLocation(candidate: TransferCandidate): string {
  return accountLabel(candidate.accountName, candidate.institutionName);
}

export function pendingLocation(item: {
  accountName: string;
  institutionName: string | null;
}): string {
  return accountLabel(item.accountName, item.institutionName);
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
export function candidateHint(t: TFunction, item: PendingTransferReview): string {
  // Outranks every count below (SC-350). "Went to a wallet you added" is a fact
  // about the transfer; "2 possible matches" is a fact about our search, and the
  // reader scanning the list to pick what to answer next needs the first one —
  // it is the difference between a question and an already-answered one. The ten
  // mis-answered transfers all read "No deposit we could match", which is true
  // and was the least useful true thing available.
  if (item.counterpartyIsOwnWallet) return t('v3.review.transfer.hint.ownWallet');
  const strict = item.candidates.filter((c) => c.withinStrictTolerance).length;
  if (strict > 1) return t('v3.review.transfer.hint.equallyGood', { count: strict });
  if (item.candidates.length === 0) return t('v3.review.transfer.hint.none');
  return t('v3.review.transfer.hint.possible', { count: item.candidates.length });
}

/**
 * What each answer does, stated in the reader's own terms — `ConfirmAction`
 *  requires a consequence and this is where the three of them live.
 *
 * **The figures are formatted, not interpolated** (SC-173). This is the last
 * sentence between a person and an irreversible answer that moves realized PnL,
 * and it read as a raw twelve-decimal float with a trailing ISO code, against
 * the same figure rendered through `formatCurrency` three times elsewhere on
 * the same sheet. Both branches of that mistake are here: the
 * amount goes through `formatCurrency` like every other consumer of the field,
 * and the quantity through the precision it actually carries rather than
 * whatever the wire happened to send.
 */
export function decisionConsequence(
  t: TFunction,
  decision: TransferReviewDecision,
  item: PendingTransferReview,
  chosen: TransferCandidate | null,
  destination?: TransferDestination | null
): string {
  switch (decision) {
    case 'paired':
      return chosen
        ? t('v3.review.transfer.consequence.paired', {
            quantity: formatNumber(item.quantity, { decimals: quantityDecimals(item.quantity) }),
            symbol: item.tokenSymbol,
            location: candidateLocation(chosen),
          })
        : t('v3.review.transfer.consequence.pairedPrompt');
    case 'internal':
      return destination
        ? `${internalCarryClause(t, qty(new Decimal(item.quantity).abs()), item.tokenSymbol, destination)} ${internalWriteClause(t, qty(new Decimal(item.quantity).abs()), item.tokenSymbol, item.occurredAt, destination)}`
        : t('v3.review.transfer.consequence.internalPrompt');
    case 'fee':
      // No date and no market value, unlike `left_control` directly below. A
      // charge is not priced at market and books no gain, so the two figures
      // that sentence carries are exactly the two this one must not, or it
      // reads as a disposal wearing a different word (SC-888).
      return t('v3.review.transfer.consequence.fee', { symbol: item.tokenSymbol });
    case 'left_control':
      // The date is the one the reader just read in the sheet's `When` fact,
      // eight lines above — so it is the same formatter, not a bare
      // `toLocaleDateString()` that follows the runtime into D/M/Y while the
      // row behind the scrim says M/D/Y (SC-175).
      return item.marketValueInBase
        ? t('v3.review.transfer.consequence.leftControlPriced', {
            date: formatDate(item.occurredAt),
            amount: formatCurrency(item.marketValueInBase, item.baseCurrencyCode, {
              decimals: moneyDecimals(item.marketValueInBase),
            }),
          })
        : t('v3.review.transfer.consequence.leftControlUnpriced', {
            date: formatDate(item.occurredAt),
            symbol: item.tokenSymbol,
          });
    default:
      return t('v3.review.transfer.consequence.untracked', { symbol: item.tokenSymbol });
  }
}

export const DECISION_LABELS: Record<
  TransferReviewDecision,
  { triggerKey: string; commitKey: string }
> = {
  // The commit is the sentence's verb applied to the object, never the
  // trigger's noun — `ConfirmAction`'s second rule.
  paired: {
    triggerKey: 'v3.review.transfer.decision.paired.trigger',
    commitKey: 'v3.review.transfer.decision.paired.commit',
  },
  // "Scani already tracks" rather than "another account in Scani", because
  // the destination is frequently a *second holding in the same account* —
  // Airwallex has two USD holdings and money moved between them — and a
  // label that says "another account" reads as nonsense on that row.
  internal: {
    triggerKey: 'v3.review.transfer.decision.internal.trigger',
    commitKey: 'v3.review.transfer.decision.internal.commit',
  },
  left_control: {
    triggerKey: 'v3.review.transfer.decision.leftControl.trigger',
    commitKey: 'v3.review.transfer.decision.leftControl.commit',
  },
  untracked: {
    triggerKey: 'v3.review.transfer.decision.untracked.trigger',
    commitKey: 'v3.review.transfer.decision.untracked.commit',
  },
  // "A fee" and not "a bank fee": the charge is as often a network fee, an
  // exchange withdrawal fee or an intermediary's cut, and naming one of them
  // makes the row it fits look like the only row it is for (SC-888).
  fee: {
    triggerKey: 'v3.review.transfer.decision.fee.trigger',
    commitKey: 'v3.review.transfer.decision.fee.commit',
  },
};

/** Where a destination is, in the words the accounts list uses. */
export function destinationLocation(destination: TransferDestination): string {
  // `accountLabel`, not a join: production reads `Airwallex · Airwallex` and
  // `Bitcoin Network · Bitcoin Network - bc1q5n…` because an importer names an
  // account after the institution that named it (SC-850).
  return accountLabel(destination.accountName, destination.institutionName);
}

/**
 * The scale every balance in one picker is rendered at.
 *
 * A shared scale rather than each row's own, because these figures exist to be
 * *compared*: the first capture read `1,201.5` above `6,500.32`, and a column
 * whose decimal points do not line up is the one thing this line must not be,
 * given that it is all a reader has to tell two identically-named holdings
 * apart. The widest precision in the list wins, so no figure is rounded away
 * and the short ones are padded to meet it.
 */
export function destinationScale(destinations: readonly TransferDestination[]): number {
  return destinations.reduce(
    (widest, d) => (d.balance ? Math.max(widest, quantityDecimals(d.balance)) : widest),
    0
  );
}

/**
 * The line that tells two same-token holdings in one account apart.
 *
 * The balance first, because it is what a person actually recognises the
 * holding by when the name and the symbol are identical — 1,201.50 versus
 * 6,217.15 is the whole distinction, and "manual" versus "import_airwallex" is
 * the confirmation rather than the clue. The source is shown raw, as the
 * holding stores it, because a prettified "Imported" would hide which importer
 * — and on an account with two of them that is the answer.
 */
export function destinationDetail(
  destination: TransferDestination,
  tokenSymbol: string,
  scale: number
): string | null {
  // NULL, not a sentence (SC-850). A destination with no holding has nothing
  // to say that distinguishes it from the next one, and the screenshot that
  // prompted this had the identical "No SOL tracked here yet" on every single
  // row — a line repeated down a list is noise wearing the costume of detail.
  // The fact is true of a whole band, so `destinationGroup` says it once, over
  // the band's heading.
  if (destination.holdingId === null) return null;
  const balance = destination.balance
    ? `${formatNumber(destination.balance, { decimals: scale })} ${tokenSymbol}`
    : `— ${tokenSymbol}`;
  return destination.source ? `${balance} · ${destination.source}` : balance;
}

/**
 * The heading a destination sits under, and the one sentence that is true of
 * everything beneath it (SC-850).
 *
 * Three bands, ranked by the server: accounts that already hold this token,
 * accounts on the chain the money is leaving, and everything else. The reader
 * is answering *where did this go*, and the bands are the app saying what it
 * already knows about each answer — which is what the flat alphabetical list
 * withheld while offering an Airwallex account above every Solana wallet for a
 * SOL transfer.
 *
 * The band never pre-selects and never hides a row: every account is still
 * offered, because "it went to an account I track that has never held SOL" is
 * a real thing that happens.
 */
export function destinationGroup(
  t: TFunction,
  destination: TransferDestination,
  tokenSymbol: string
): { group: string; groupHint?: string } {
  switch (destination.relevance) {
    case 'holds_token':
      return { group: t('v3.review.destinationPicker.group.holdsToken', { symbol: tokenSymbol }) };
    case 'same_network':
      return {
        group: t('v3.review.destinationPicker.group.sameNetwork'),
        groupHint: t('v3.review.transfer.destination.willCreate', { symbol: tokenSymbol }),
      };
    default:
      return {
        group: t('v3.review.destinationPicker.group.other'),
        groupHint: t('v3.review.transfer.destination.willCreate', { symbol: tokenSymbol }),
      };
  }
}

/**
 * What moving to a tracked holding does to the cost basis — the half that is
 * identical to `paired`.
 */
function internalCarryClause(
  t: TFunction,
  amount: string,
  tokenSymbol: string,
  destination: TransferDestination
): string {
  return t('v3.review.transfer.internal.carry', {
    amount,
    symbol: tokenSymbol,
    location: destinationLocation(destination),
  });
}

/**
 * What moving to a tracked holding *writes* — the half `paired` does not have,
 * and the one a reader has to be told before they commit (SC-187).
 *
 * The balance sentence is the point, and it is FOUR sentences rather than two
 * because whether the balance moves is a property of the destination, not of
 * the answer (SC-856). `movesBalance` comes from the server, computed by the
 * predicate the write itself uses.
 *
 * It said *"its balance stays at X — recording history never moves a balance,
 * so if it does not already include this, change it yourself"* on every
 * destination until then. On one nobody syncs, that instruction is what wrote
 * the second arrival row: the hand edit the reader was told to make is itself
 * a deposit. On one a sync owns it is still exactly right, which is why the
 * branch is here and the sentence was not simply replaced.
 */
function internalWriteClause(
  t: TFunction,
  amount: string,
  tokenSymbol: string,
  occurredAt: string,
  destination: TransferDestination
): string {
  if (destination.holdingId === null) {
    return t(
      destination.movesBalance
        ? 'v3.review.transfer.internal.writeNew'
        : 'v3.review.transfer.internal.writeNewSynced',
      {
        symbol: tokenSymbol,
        amount,
        date: formatDate(occurredAt),
      }
    );
  }
  const balance = destination.balance
    ? `${qty(new Decimal(destination.balance))} ${tokenSymbol}`
    : t('v3.review.transfer.internal.balanceFallback');
  return t(
    destination.movesBalance
      ? 'v3.review.transfer.internal.writeExistingMoves'
      : 'v3.review.transfer.internal.writeExisting',
    {
      amount,
      symbol: tokenSymbol,
      date: formatDate(occurredAt),
      balance,
    }
  );
}

/**
 * A row in the split editor: one outcome, and how much of the transfer it
 * accounts for (SC-181).
 *
 * The editor renders **all four outcomes, always**, and a row with an empty
 * amount is simply not part of the answer. That is what removes the add/remove
 * machinery a list editor would need, makes "each outcome at most once"
 * structurally impossible to violate rather than validated after the fact, and
 * matches how the case was reported — "I want to be able to edit the numbers
 * to track vs not track here" is known outcomes and two numbers, not a
 * builder.
 *
 * `amount` is the reader's own text, not a Decimal, because `3.` and `` are
 * states a person passes through while typing a number.
 */
export interface SplitDraftRow {
  decision: TransferReviewDecision;
  amount: string;
  matchTransactionId: string | null;
  /** The `internal` row's target, meaningless on the others (SC-187). */
  destination: TransferDestination | null;
}

/** The rows that are actually part of the answer. */
function filledRows(rows: readonly SplitDraftRow[]): SplitDraftRow[] {
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
  t: TFunction,
  allocation: SplitAllocation,
  item: PendingTransferReview
): string | null {
  const symbol = item.tokenSymbol;
  switch (allocation.status) {
    case 'exact':
      return null;
    case 'unparseable':
      return t('v3.review.transfer.allocation.unparseable');
    case 'over':
      return t('v3.review.transfer.allocation.over', {
        amount: qty(allocation.remaining?.abs()),
        symbol,
      });
    default:
      return t('v3.review.transfer.allocation.under', {
        amount: qty(allocation.remaining),
        symbol,
      });
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
 * amount is a positive number, each linking part has its target, no more than
 * one part links at all, and the whole thing adds up exactly.
 *
 * One filled row is a *whole* answer, not a split, and is refused here rather
 * than silently converted: the whole answers are one tap away and each states
 * its own consequence, so quietly turning "3,500 untracked" into "all of it
 * untracked" would commit a claim about 4,000 the reader made about 3,500.
 *
 * The one-linking-part rule mirrors `transferReviewSplitSchema` rather than
 * trusting it, so the reader finds out while typing rather than after a round
 * trip. It is not a form nicety: `transfer_group_id` is one column, and a
 * second link would leave the destination walked on its own with a fresh
 * market-value lot.
 */
export function splitIsCommittable(
  rows: readonly SplitDraftRow[],
  item: PendingTransferReview
): boolean {
  const filled = filledRows(rows);
  if (filled.length < 2) return false;
  if (filled.filter((r) => isLinkingDecision(r.decision)).length > 1) return false;
  if (filled.some((r) => r.decision === 'paired' && !r.matchTransactionId)) return false;
  if (filled.some((r) => r.decision === 'internal' && !r.destination)) return false;
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
    ...(row.decision === 'internal' && row.destination
      ? {
          destination: {
            accountId: row.destination.accountId,
            holdingId: row.destination.holdingId,
          },
        }
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
  t: TFunction,
  rows: readonly SplitDraftRow[],
  item: PendingTransferReview,
  candidateFor: (id: string | null) => TransferCandidate | null
): string {
  if (!splitIsCommittable(rows, item)) {
    // The one-linking-part rule gets its own sentence, because "give two of
    // these an amount" is not what is wrong and a reader who has given four of
    // them an amount would read it as the form failing to notice.
    if (filledRows(rows).filter((r) => isLinkingDecision(r.decision)).length > 1) {
      return t('v3.review.transfer.split.oneLinkOnly', {
        paired: t(DECISION_LABELS.paired.triggerKey),
        internal: t(DECISION_LABELS.internal.triggerKey),
      });
    }
    return t('v3.review.transfer.split.needTwo', {
      amount: qty(new Decimal(item.quantity).abs()),
      symbol: item.tokenSymbol,
    });
  }
  const clauses = filledRows(rows).map((row) => {
    const amount = `${qty(new Decimal(row.amount))} ${item.tokenSymbol}`;
    switch (row.decision) {
      case 'paired': {
        const chosen = candidateFor(row.matchTransactionId);
        return t('v3.review.transfer.split.clause.paired', {
          amount,
          location: chosen
            ? candidateLocation(chosen)
            : t('v3.review.transfer.split.clause.pairedFallback'),
        });
      }
      case 'internal':
        return row.destination
          ? t('v3.review.transfer.split.clause.internal', {
              amount,
              location: destinationLocation(row.destination),
            })
          : t('v3.review.transfer.split.clause.internalFallback', { amount });
      case 'left_control':
        return t('v3.review.transfer.split.clause.leftControl', {
          amount,
          date: formatDate(item.occurredAt),
        });
      default:
        return t('v3.review.transfer.split.clause.untracked', { amount });
    }
  });
  // The balance sentence differs three ways, and the differences are the whole
  // point: a holding being created, a balance being moved, and a balance left
  // for its sync to state. Saying "no balance is changed" over any of the
  // first two would be the silent version of the thing this answer exists to
  // make visible — which it was over the second until SC-856.
  const internal = filledRows(rows).find((r) => r.decision === 'internal' && r.destination);
  const balanceNote = !internal
    ? ''
    : internal.destination?.holdingId === null
      ? ` ${t('v3.review.transfer.split.balanceNew', { symbol: item.tokenSymbol })}`
      : internal.destination?.movesBalance
        ? ` ${t('v3.review.transfer.split.balanceMoves')}`
        : ` ${t('v3.review.transfer.split.balanceUnchanged')}`;
  return `${t('v3.review.transfer.split.summary', { clauses: clauses.join('. ') })}${balanceNote}`;
}

/** The trigger and commit labels for the split, in `DECISION_LABELS`' shape. */
export const SPLIT_LABELS = {
  triggerKey: 'v3.review.transfer.split.trigger',
  commitKey: 'v3.review.transfer.split.commit',
};

/**
 * What a reader is told before they open the editor.
 *
 * Names the reported case rather than describing the feature, because "split
 * across outcomes" is a data model and "part of it moved, part of it left" is
 * a thing that happened to them.
 */
export const SPLIT_NOTE_KEY = 'v3.review.transfer.split.note';

/** How an answer already given reads in the answered list. */
export function answeredSummary(t: TFunction, item: AnsweredTransferReview): string {
  if (item.decision !== TRANSFER_REVIEW_SPLIT || !item.split) {
    const key = ANSWER_SUMMARY_KEYS[item.decision];
    return key ? t(key) : t('v3.review.transfer.answered.fallback');
  }
  // The quantity is a NAMED placeholder inside each verdict's own key, not a
  // figure the join glues to its front (SC-235). "0.5 disposed" put the amount
  // before a bare participle, which is the one order several of the eight
  // languages do not use; the middot between portions stays markup, because it
  // separates list items rather than words in a sentence.
  return item.split
    .map((portion) =>
      t(ANSWER_SHORT_KEYS[portion.decision], { amount: qty(new Decimal(portion.quantity)) })
    )
    .join(' · ');
}

/**
 * What withdrawing an answer does — the sentence over the Reopen confirm.
 *
 * Four cases, because reopening does four different things and only one of
 * them is "nothing settles until you answer again":
 *
 * - **`declared`** — the transfer the owner RECORDED. Reopening it does not
 *   return anything to the queue, it UNDOES the movement: both balances go
 *   back and both entries are deleted (SC-618). It is checked FIRST because
 *   its `decision` is `paired`, so every other branch here would describe it
 *   as something it is not — and `default`, the branch it used to land in,
 *   promised that nothing changes, over an action that moves two balances.
 * - `left_control` takes a booked gain off the realized total.
 * - `internal` **deletes the deposit the answer wrote** (SC-187). That is a
 *   transaction disappearing from another account, and a reader who is not
 *   told will find it gone later and have no way to connect the two. It has to
 *   be said here rather than discovered there. It also says any balance the
 *   answer moved comes back off (SC-856) — conditionally, because whether it
 *   moved one depends on who owns that destination's balance, and this copy
 *   states the rule rather than predicting the case. It promised outright that
 *   "no balance changes either way" until `writeInflow` learned to move a
 *   destination anchor no sync will ever correct.
 * - anything else settles nothing and unsettles nothing.
 */
export function reopenConsequence(t: TFunction, item: AnsweredTransferReview): string {
  if (item.declared) return t('v3.review.transfer.reopen.declared');
  const internal =
    item.decision === 'internal' || (item.split?.some((p) => p.decision === 'internal') ?? false);
  // A destination this answer had to CREATE is removed with it, so the
  // ordinary sentence — "no balance changes either way" — is false of it: an
  // account loses a position it did not have before the answer (SC-631). The
  // copy describes the RULE rather than predicting the outcome ("unless
  // something else has been recorded against it since"), so it cannot drift
  // from `holdingIsUntouched` the way a second implementation of the
  // predicate would.
  if (internal) {
    return t(
      item.createdDestination
        ? 'v3.review.transfer.reopen.internalCreated'
        : 'v3.review.transfer.reopen.internal'
    );
  }
  if (item.decision === 'left_control') return t('v3.review.transfer.reopen.leftControl');
  return t('v3.review.transfer.reopen.default');
}

/**
 * What applying one answer to N transfers will do, **in money** (SC-382).
 *
 * This is the sentence between one tap and N capital gains, and the rule it
 * follows is the one `decisionConsequence` learned the hard way (SC-173): the
 * figures are formatted through `formatCurrency`, never interpolated raw, and
 * they are the same figures the queue's own "if it was a sale" column shows.
 *
 * It says three things, in the order they change a reader's mind:
 *
 * 1. **What is booked, or un-booked.** `left_control` adds proceeds;
 *    `untracked` takes back off whatever the selection already books. The
 *    second one is not a footnote — it is the operation SC-186 asked for, over
 *    the production rows that already carry a disposal — and a confirmation
 *    that only ever described additions would be silent about the whole of it.
 * 2. **What is missing from the figure.** Rows with no price on their day book
 *    nothing, so the total is a floor, and a reader who is not told will read
 *    it as the whole.
 * 3. **Nothing about the rows it cannot write.** Those are `bulkRefusalNote`'s,
 *    above the consequence and next to the control that clears them, because
 *    they are a thing to DO rather than a thing to know.
 */
export function bulkConsequence(
  t: TFunction,
  decision: BulkTransferDecision,
  preview: BulkTransferPreview | undefined
): string {
  if (!preview) return t('v3.review.transfer.bulk.consequence.loading');
  const count = preview.eligible.length;
  if (count === 0) return t('v3.review.transfer.bulk.consequence.none');

  const money = (amount: string) =>
    formatCurrency(amount, preview.baseCurrencyCode, { decimals: moneyDecimals(amount) });

  const parts: string[] = [];
  if (decision === 'left_control') {
    parts.push(
      preview.proceedsInBase
        ? t('v3.review.transfer.bulk.consequence.leftControl', {
            count,
            amount: money(preview.proceedsInBase),
          })
        : t('v3.review.transfer.bulk.consequence.leftControlUnpriced', { count })
    );
  } else {
    parts.push(t('v3.review.transfer.bulk.consequence.untracked', { count }));
    // The reverse direction, and the reason this feature is worth building:
    // these rows already book a gain, and this is the tap that removes it.
    if (preview.alreadyDisposedCount > 0) {
      parts.push(
        preview.alreadyDisposedInBase
          ? t('v3.review.transfer.bulk.consequence.takesBack', {
              count: preview.alreadyDisposedCount,
              amount: money(preview.alreadyDisposedInBase),
            })
          : t('v3.review.transfer.bulk.consequence.takesBackUnpriced', {
              count: preview.alreadyDisposedCount,
            })
      );
    }
  }

  // Only worth saying when there IS a figure it qualifies. With no priced row
  // at all the sentence above already says nothing is booked.
  if (preview.unpricedCount > 0 && preview.unpricedCount < count) {
    parts.push(t('v3.review.transfer.bulk.consequence.unpriced', { count: preview.unpricedCount }));
  }
  return parts.join(' ');
}

/**
 * The rows the write will not take, and why — one line per reason, never a
 * count on its own.
 *
 * A bulk write that quietly drops rows is indistinguishable from one that lost
 * them, which is the failure this area has already spent four investigations
 * on. So the refusals are named before anything is written, and the commit
 * stays out of reach until the reader has deselected them — the selection is
 * theirs, and silently narrowing it would be the same defect wearing a
 * politer face.
 */
export function bulkRefusalNotes(t: TFunction, refusals: readonly BulkTransferRefusal[]): string[] {
  const byReason = new Map<BulkTransferRefusal['reason'], BulkTransferRefusal[]>();
  for (const refusal of refusals) {
    const bucket = byReason.get(refusal.reason);
    if (bucket) bucket.push(refusal);
    else byReason.set(refusal.reason, [refusal]);
  }
  const notes: string[] = [];
  for (const [reason, rows] of byReason) {
    const count = rows.length;
    if (reason === 'own_wallet') {
      // Named, not counted: a 42-character hex string is the one fact that
      // makes this refusal checkable, and it is the exact refusal SC-350's ten
      // rows needed and did not get.
      notes.push(
        t('v3.review.transfer.bulk.refusal.ownWallet', { count, address: rows[0]?.detail ?? '' })
      );
      continue;
    }
    if (reason === 'answered_otherwise') {
      notes.push(
        t('v3.review.transfer.bulk.refusal.answered', { count, answer: rows[0]?.detail ?? '' })
      );
      continue;
    }
    notes.push(
      t(
        reason === 'linked'
          ? 'v3.review.transfer.bulk.refusal.linked'
          : 'v3.review.transfer.bulk.refusal.gone',
        { count }
      )
    );
  }
  return notes;
}

/** The bulk bar's trigger and commit labels, in `DECISION_LABELS`' shape —
 *  the commit carries the count, because the button is what gets read. */
export const BULK_LABELS: Record<BulkTransferDecision, { triggerKey: string; commitKey: string }> =
  {
    left_control: {
      triggerKey: 'v3.review.transfer.decision.leftControl.trigger',
      commitKey: 'v3.review.transfer.bulk.commit.leftControl',
    },
    untracked: {
      triggerKey: 'v3.review.transfer.decision.untracked.trigger',
      commitKey: 'v3.review.transfer.bulk.commit.untracked',
    },
  };

const ANSWER_SUMMARY_KEYS: Record<string, string> = {
  paired: 'v3.review.transfer.answered.paired',
  internal: 'v3.review.transfer.answered.internal',
  left_control: 'v3.review.transfer.answered.leftControl',
  untracked: 'v3.review.transfer.answered.untracked',
  fee: 'v3.review.transfer.answered.fee',
};

const ANSWER_SHORT_KEYS: Record<TransferReviewDecision, string> = {
  paired: 'v3.review.transfer.answeredShort.paired',
  internal: 'v3.review.transfer.answeredShort.internal',
  left_control: 'v3.review.transfer.answeredShort.leftControl',
  untracked: 'v3.review.transfer.answeredShort.untracked',
  fee: 'v3.review.transfer.answeredShort.fee',
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
 *  here so the components import one module rather than two. `t` first, like
 *  every other keyed helper in this directory: v3's copy of `formatRelative`
 *  reads its four strings from the catalogue (SC-369). */
export function occurredLabel(t: TFunction, iso: string): string {
  return formatRelative(t, new Date(iso));
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
function formatSignedGap(t: TFunction, ms: number): string {
  if (Math.abs(ms) < 60_000) return t('v3.review.transfer.gap.sameMinute');
  return ms >= 0
    ? t('v3.review.transfer.gap.later', { gap: humaniseGap(t, ms) })
    : t('v3.review.transfer.gap.earlier', { gap: humaniseGap(t, -ms) });
}

function humaniseGap(t: TFunction, ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return t('v3.review.transfer.gap.minutes', { count: minutes });
  const hours = Math.round(minutes / 60);
  if (hours < 48) return t('v3.review.transfer.gap.hours', { count: hours });
  return t('v3.review.transfer.gap.days', { count: Math.round(hours / 24) });
}
