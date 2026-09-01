import type { HoldingMovementDirection } from '@scani/shared';
import type { TFunction } from 'i18next';
import { useState } from 'react';
import { dateFieldInstant, todayIso } from '../components/form/DateField';
import { buildEnsureAccountInput, describeAccountTargetBlockers } from '../lib/manual-entry';
import {
  type MovementHolding,
  type MovementOutflowOption,
  type MovementSubmission,
  movementBlockerKeys,
  movementFeeArrival,
  movementFeeStated,
} from '../lib/movement-form';
import { type AccountTarget, useAccountTarget } from './useAccountTarget';

/**
 * Everything the movement form remembers, held above both of its chromes
 * (SC-619).
 *
 * The page renders the fields and the submit button as siblings, and the dialog
 * renders them in a `DialogFooter` that is a sibling of the field column — so
 * the state cannot live inside the fields on either surface. It is a hook
 * rather than a component with a render prop because the other half of this
 * flow, `useAccountTarget`, already is one and composes into it directly.
 */
export interface MovementForm {
  holdingId: string;
  selectHolding: (holdingId: string) => void;
  /** The holding being moved: the fixed one, or whatever is chosen. */
  selected: MovementHolding | null;
  direction: HoldingMovementDirection;
  chooseDirection: (direction: HoldingMovementDirection) => void;
  amount: string;
  setAmount: (amount: string) => void;
  /**
   * How much of `amount` the rail kept, on a transfer (SC-889). Empty means no
   * fee, which is the common case and stays one keystroke away from nothing
   * rather than a zero somebody has to clear.
   */
  fee: string;
  setFee: (fee: string) => void;
  /**
   * What will ARRIVE once the fee is carved out, or `null` when there is
   * nothing to say — no fee stated, or one the form is already refusing.
   * Computed here rather than in either chrome, so the page and the dialog
   * cannot show two different arrival figures.
   */
  feeArrives: string | null;
  /**
   * A fee was stated and this form is refusing it — the one case where
   * `feeArrives` is null for a reason worth saying out loud beside the field.
   */
  feeBlocked: boolean;
  date: string;
  setDate: (date: string) => void;
  note: string;
  setNote: (note: string) => void;
  destination: MovementOutflowOption | null;
  chooseDestination: (destination: MovementOutflowOption) => void;
  /** Whether "where did it go?" applies to what is being recorded. */
  asksWhere: boolean;
  accountTarget: AccountTarget;
  /** What is still missing, said to a person. Empty means submittable. */
  blockers: string[];
  build: () => MovementSubmission | null;
}

export function useMovementForm(
  t: TFunction,
  holding: MovementHolding | null,
  holdings: readonly MovementHolding[]
): MovementForm {
  const accountTarget = useAccountTarget();

  const [holdingId, setHoldingId] = useState(holding?.id ?? '');
  const [direction, setDirection] = useState<HoldingMovementDirection>('outflow');
  const [amount, setAmount] = useState('');
  const [fee, setFee] = useState('');
  const [date, setDate] = useState(todayIso);
  const [note, setNote] = useState('');
  /**
   * Nothing pre-selected, and that is the same refusal
   * `TransferDestinationPicker` makes: this answer decides whether a disposal
   * is realized, so a default wearing a checkmark the reader did not put there
   * would book a taxable event on their behalf.
   */
  const [destination, setDestination] = useState<MovementOutflowOption | null>(null);

  const selected = holding ?? holdings.find((row) => row.id === holdingId) ?? null;
  const ensure = buildEnsureAccountInput(accountTarget.draft);

  const draft = {
    holdingId: selected?.id ?? '',
    direction,
    amount,
    destination,
    fee,
  };
  const blockers = movementBlockerKeys(draft).map((key) => t(key));
  // One draft answers both, so the figure shown beside the field and the
  // button's enabled state cannot come from different readings of the form.
  const feeArrives = movementFeeArrival(draft);
  const feeBlocked = movementFeeStated(draft) && feeArrives === null;
  if (direction === 'transfer') {
    blockers.push(...describeAccountTargetBlockers(t, accountTarget.draft));
  }

  /**
   * Choosing "it went to another account I hold" IS choosing the transfer, so
   * it moves the control above rather than adding a parallel one. One piece of
   * state, so the segmented control and the question can never disagree about
   * what is being recorded.
   */
  const chooseDestination = (next: MovementOutflowOption) => {
    setDestination(next);
    setDirection(next === 'transfer' ? 'transfer' : 'outflow');
  };

  const chooseDirection = (chosen: HoldingMovementDirection) => {
    setDirection(chosen);
    // Leaving the outflow question behind when the answer no longer applies.
    // Keeping `untracked` on a row now being recorded as an inflow would
    // submit an answer to a question nobody asked.
    setDestination(chosen === 'transfer' ? 'transfer' : null);
  };

  const build = (): MovementSubmission | null => {
    if (!selected || blockers.length > 0) return null;
    return {
      holdingId: selected.id,
      direction,
      amount: amount.trim(),
      occurredAt: dateFieldInstant(date),
      note: note.trim() || undefined,
      destination:
        direction === 'outflow' && destination !== null && destination !== 'transfer'
          ? destination
          : undefined,
      ensureAccount: direction === 'transfer' ? ensure : undefined,
      // `feeArrives` being non-null is exactly "stated, on a transfer, and it
      // fits" — the same reading the blocker uses, taken off one value rather
      // than re-tested here. An empty field is not a zero fee, it is no answer,
      // and the schema refuses a zero.
      feeQuantity: feeArrives !== null ? fee.trim() : undefined,
    };
  };

  return {
    holdingId,
    selectHolding: setHoldingId,
    selected,
    direction,
    chooseDirection,
    amount,
    setAmount,
    fee,
    setFee,
    feeArrives,
    feeBlocked,
    date,
    setDate,
    note,
    setNote,
    destination,
    chooseDestination,
    asksWhere: direction === 'outflow' || direction === 'transfer',
    accountTarget,
    blockers,
    build,
  };
}
