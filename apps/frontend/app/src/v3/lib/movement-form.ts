import {
  Decimal,
  feeFitsMovement,
  type HoldingMovementDirection,
  MANUAL_OUTFLOW_DESTINATIONS,
  type ManualOutflowDestination,
  movementOutflowRefusesInternal,
} from '@scani/shared';
import type { buildEnsureAccountInput } from './manual-entry';

/**
 * The pure half of "record a movement" — what the form is missing, and which
 * holdings a typed query names (SC-619).
 *
 * Both were expressions inside `RecordMovementSheet` and are here for the same
 * reason `capture-forms.ts` exists: the form now has two chromes — a page and a
 * dialog — and a rule that lives in one of them is a rule the other will
 * eventually disagree with. Neither function touches React, so both are held by
 * a test rather than by a screenshot.
 */

export interface MovementHolding {
  id: string;
  amount: string;
  token: { symbol: string; name: string };
  account: { name: string };
  institution: { id: string; name: string; website?: string | null };
  label?: string | null;
}

export interface MovementSubmission {
  holdingId: string;
  direction: HoldingMovementDirection;
  amount: string;
  occurredAt: string;
  note?: string;
  destination?: ManualOutflowDestination;
  /** Resolved by the caller through `ensureAccount`; null when incomplete. */
  ensureAccount?: ReturnType<typeof buildEnsureAccountInput>;
  /**
   * How much of `amount` the rail kept, on a transfer that cost something
   * (SC-889). Absent means no fee was stated, which is the common case.
   */
  feeQuantity?: string;
}

/**
 * The three things a person can say about money leaving, in the order they
 * are most often true.
 *
 * `internal` is dropped from `MANUAL_OUTFLOW_DESTINATIONS` and replaced by
 * `transfer`, which is not a rename: `internal` writes the arrival row and
 * leaves an existing destination's BALANCE untouched, so recording "I moved
 * 2000 to my other account" through it would leave that account 2000 short
 * with nothing erroring. `transfer` writes both legs. See
 * `movementOutflowRefusesInternal`.
 */
export const MOVEMENT_OUTFLOW_OPTIONS = [
  ...MANUAL_OUTFLOW_DESTINATIONS.filter((option) => !movementOutflowRefusesInternal(option)),
  'transfer' as const,
];

export type MovementOutflowOption = (typeof MOVEMENT_OUTFLOW_OPTIONS)[number];

/** Everything the blockers are computed from — the form's answers, with the
 *  transfer destination reduced to "is it complete", which `manual-entry.ts`
 *  already owns and this module must not re-derive. */
export interface MovementDraft {
  holdingId: string;
  direction: HoldingMovementDirection;
  amount: string;
  destination: MovementOutflowOption | null;
  /** What the fee field holds, verbatim. Empty means none was stated. */
  fee?: string;
}

function amountIsPositive(amount: string): boolean {
  const trimmed = amount.trim();
  return /^\d+(\.\d+)?$/.test(trimmed) && Number.parseFloat(trimmed) > 0;
}

/**
 * What is still missing, as translation keys.
 *
 * The transfer's destination account is NOT here: it is
 * `describeAccountTargetBlockers`, which already names the institution, the
 * account and each half of a new one. Restating it as one flat "a destination
 * account" would be a second, worse answer to a question the shared helper
 * answers precisely.
 */
export function movementBlockerKeys(draft: MovementDraft): string[] {
  const blockers: string[] = [];
  if (!draft.holdingId) blockers.push('v3.holdings.movement.blocker.holding');
  if (!amountIsPositive(draft.amount)) {
    blockers.push('v3.holdings.movement.blocker.amount');
  }
  if (draft.direction === 'outflow' && draft.destination === null) {
    blockers.push('v3.holdings.movement.blocker.where');
  }
  // A fee that is not smaller than the movement leaves nothing to transfer, and
  // `ManualBalanceEditService` refuses it (SC-889). Read off the same function
  // that computes the arrival figure, so the button's enabled state and the
  // number shown beside the field can never be answers to different questions.
  if (movementFeeStated(draft) && movementFeeArrival(draft) === null) {
    blockers.push('v3.holdings.movement.blocker.fee');
  }
  return blockers;
}

/**
 * Did the owner state a fee this form will act on (SC-889)?
 *
 * Gated on the DIRECTION as well as on the field, not merely on the field: only
 * a transfer shows the input, so a value left behind by flipping the control
 * back to `outflow` must stop counting as an answer — otherwise Save is
 * disabled with nothing on screen saying why, and a fee is sent for a movement
 * that has no second leg to be the difference between.
 */
export function movementFeeStated(draft: MovementDraft): boolean {
  return draft.direction === 'transfer' && (draft.fee?.trim() ?? '') !== '';
}

/**
 * What will ARRIVE once the fee is carved out, or `null` when there is nothing
 * to say — no fee stated, or one this form is refusing.
 *
 * `null` is deliberately the same answer for both, because both mean "do not
 * show an arrival figure and do not send a fee". The blocker above distinguishes
 * them by asking `movementFeeStated` first.
 *
 * `feeFitsMovement` rather than a second spelling of the rule: it is the one
 * predicate `ManualBalanceEditService` refuses on, so a fee this returns a
 * figure for is a fee the server will honour. Two spellings would render either
 * as a button that cannot be pressed over a valid answer or as a 500 over a form
 * that looked complete.
 */
export function movementFeeArrival(draft: MovementDraft): string | null {
  if (!movementFeeStated(draft)) return null;
  const fee = (draft.fee ?? '').trim();
  if (!amountIsPositive(draft.amount) || !feeFitsMovement(fee, draft.amount)) return null;
  return new Decimal(draft.amount).minus(fee).toString();
}

/** The row's main text: the pot, then the account it sits in. */
export function movementHoldingLabel(holding: MovementHolding): string {
  return `${holding.label || holding.token.symbol} · ${holding.account.name}`;
}

/** The chosen holding, shown in place of the search field — where the
 *  institution can no longer be read off the row's favicon. */
export function movementHoldingSelectedLabel(holding: MovementHolding): string {
  return `${movementHoldingLabel(holding)} · ${holding.institution.name}`;
}

function haystack(holding: MovementHolding): string {
  return [
    holding.institution.name,
    holding.account.name,
    holding.label ?? '',
    holding.token.symbol,
    holding.token.name,
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * How well the whole query names this holding, lowest first.
 *
 * The ordering is the answer to "what did I mean by typing that": a query that
 * starts a token's symbol means that token, and one that starts an institution
 * means everything held there. Without it a 20-row cap is decided by insertion
 * order, so typing `btc` can return twenty rows of a bank that happens to hold
 * a token called `BTCB`.
 */
function rank(holding: MovementHolding, query: string): number {
  const pot = (holding.label || holding.token.symbol).toLowerCase();
  if (pot.startsWith(query)) return 0;
  if (holding.token.symbol.toLowerCase().startsWith(query)) return 1;
  if (holding.account.name.toLowerCase().startsWith(query)) return 2;
  if (holding.institution.name.toLowerCase().startsWith(query)) return 3;
  return 4;
}

function alphabetical(a: MovementHolding, b: MovementHolding): number {
  return (
    a.institution.name.localeCompare(b.institution.name) ||
    a.account.name.localeCompare(b.account.name) ||
    movementHoldingLabel(a).localeCompare(movementHoldingLabel(b))
  );
}

/**
 * The holdings a query names, across institutions, accounts and holdings.
 *
 * Every whitespace-separated term has to match somewhere, so `kraken btc`
 * narrows rather than widens — which is the only way a query spanning three
 * levels stays useful once a portfolio has more rows than the list can show.
 * An empty query is the whole list, alphabetically: opening the field with
 * nothing typed should still show what there is to pick.
 */
export function matchMovementHoldings<T extends MovementHolding>(
  holdings: readonly T[],
  query: string,
  limit = 20
): T[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return [...holdings].sort(alphabetical).slice(0, limit);

  const terms = trimmed.split(/\s+/);
  return holdings
    .filter((holding) => {
      const text = haystack(holding);
      return terms.every((term) => text.includes(term));
    })
    .sort((a, b) => rank(a, trimmed) - rank(b, trimmed) || alphabetical(a, b))
    .slice(0, limit);
}
