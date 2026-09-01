import type {
  ManualOutflowAnswer,
  ManualOutflowDestination,
  TransferDestination,
} from '@scani/shared';
import {
  Decimal,
  feeFitsMovement,
  MANUAL_EDIT_CAUSES,
  MANUAL_OUTFLOW_DESTINATIONS,
  type ManualEditCause,
} from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@scani/ui/ui/dialog';
import { Label } from '@scani/ui/ui/label';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { DateField, dateFieldInstant, todayIso } from '../form/DateField';
import { TransferDestinationPicker } from '../review/TransferDestinationPicker';

/**
 * "What did that change mean, and where did the money go?" — asked once, per
 * edit, on the holdings whose balance is the only channel their performance
 * can arrive through (SC-510, SC-606).
 *
 * ## Why a question rather than a default
 *
 * A balance delta has three causes and the system cannot tell them apart:
 * money moved, the old figure was wrong, or the balance grew. Each needs a
 * different treatment and two of the three produce a wrong number if guessed.
 * The dangerous one is `growth`: a manually-tracked savings account earns its
 * return THROUGH this edit, so silently booking every edit as a contribution
 * makes that account return exactly 0% forever — a flat, plausible figure
 * nobody questions, which is worse than the −39% the bug it replaces produced.
 *
 * So it asks, and it asks only where it must. A holding whose price we fetch
 * gets no dialog at all: performance arrives through the price there, so 10
 * shares becoming 15 is a purchase and the server derives that itself.
 * `manualEditNeedsCause` is the one definition of which set is which, shared
 * with the API so the two cannot disagree.
 *
 * ## Why the destination is asked HERE and not afterwards (SC-606)
 *
 * Answering `flow` on a falling balance writes a `withdraw`, and an unanswered
 * outflow is by definition an item in the transfer-review queue — so the act
 * of explaining the change was what produced the next question, addressed to
 * the person who had just explained it. Measured on a dev stack 2026-08-25,
 * one 4,000 → 2,000 edit on a manual USD savings holding produced three
 * prompts: this dialog, a transfer-review item, and a balance-gap item.
 *
 * The queue is right for a row that arrived from an IMPORT, where nobody has
 * been asked. It is wrong here, where the person is present and is the source
 * of the fact. So this asks the queue's own question, in the queue's own
 * vocabulary, at the moment they are already answering — one dialog, one
 * submit, one transaction on the server.
 *
 * `paired` is not offered, and the omission is structural rather than a
 * simplification: it means "this is the same money as that inflow" and needs
 * an inflow row to point at, which no candidate search has produced at edit
 * time. Somebody whose arrival was imported separately still reaches it
 * through the queue, where the candidates exist.
 *
 * Nothing is pre-selected. `TransferDestinationPicker`'s docblock has the
 * argument in full, and it applies with more force here: this answer WRITES a
 * transaction, so a guess wearing a checkmark the reader did not put there
 * would put money in an account it never reached.
 *
 * **The `internal` list holds every account again (SC-614).** It was scoped to
 * accounts tracking none of this token while the mitigation stood,
 * because `writeInflow` — the writer behind it then — inserts the arrival row
 * and leaves an existing destination's balance alone. That is right in the
 * queue, where the balance was observed by its own sync, and wrong here, where
 * the owner is the only source of truth for both sides and only one has moved.
 * `UpdateHoldingUseCase` now writes both legs itself and moves both anchors,
 * so an existing holding is a destination again — and it is the commoner one.
 *
 * ## The date
 *
 * Pre-filled with today and editable. The user knows when they moved the
 * money and we never will, so it is cheap when today is right and correct when
 * it is not. Dating every flow at the edit instant was rejected: it
 * concentrates months of movement onto one day and distorts time-weighted
 * return around it, which is the failure `e1fa63e5` removed.
 *
 * **An untouched field still means NOW, not the start of the day** (SC-612).
 * That is not a retreat from the paragraph above — a day the user picked is
 * still stamped at their midnight — it is what the default was always
 * approximating. `dateFieldInstant` owns the rule and carries the
 * measurement; the short version is that local midnight is the previous UTC
 * day east of Greenwich, which lands the flow before the observation the daily
 * APY payout wrote this morning and therefore outside the very interval it was
 * written to explain.
 *
 * Shown only for `flow`. A correction is dated by the server at the moment the
 * superseded figure entered the record — asking would invite the answer
 * "today", which is where the mistake was noticed, not where it was made — and
 * growth writes no dated row at all.
 */

interface HoldingEditCauseDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Symbol or label of the holding being edited, for the question's subject. */
  holdingLabel: string;
  /** The holding the destination list is built from — it carries the token and
   *  is the one account the money cannot have moved to. */
  holdingId: string;
  tokenSymbol: string;
  /**
   * Does this edit take the balance DOWN?
   *
   * The destination question is owed for an outflow and nothing else: an
   * inflow is never in the transfer-review queue (`answerIsOwedFor` is
   * `withdraw` and `transfer_out`), so asking about a deposit would ADD the
   * prompt this dialog exists to remove.
   */
  isOutflow: boolean;
  /**
   * How much the balance went DOWN by, unsigned, or `undefined` when it went
   * up (SC-857).
   *
   * The fee field needs it for two things a type cannot supply: the arrival
   * figure it shows back, and the bound `feeFitsMovement` checks. Passed in
   * rather than derived here because the page holds both balances and this
   * dialog holds neither.
   */
  outflowQuantity?: string;
  /** The last answer given for this holding, pre-selected. */
  defaultCause?: ManualEditCause | null;
  onConfirm: (
    cause: ManualEditCause,
    occurredAt: string | undefined,
    outflow: ManualOutflowAnswer | undefined
  ) => void;
}

/**
 * The instant to send with the edit, or `undefined` for "the server dates
 * this one".
 *
 * Exported and tested rather than written inline, for the reason
 * `balanceGapOccurredAt` is: it is the piece of this dialog a type cannot
 * check and a rendered snapshot cannot see, and it shipped wrong. The date
 * rule itself lives in `dateFieldInstant` — one rule, shared with
 * `RecordMovementSheet`, so the two surfaces cannot date the same movement
 * differently (SC-612).
 */
export function holdingEditOccurredAt(cause: ManualEditCause, date: string): string | undefined {
  // Only a flow carries a date at all. A correction is dated by the server at
  // the moment the superseded figure entered the record, and growth writes no
  // dated row.
  if (cause !== 'flow') return undefined;
  return dateFieldInstant(date);
}

export function HoldingEditCauseDialog({
  open,
  onOpenChange,
  holdingLabel,
  holdingId,
  tokenSymbol,
  isOutflow,
  outflowQuantity,
  defaultCause,
  onConfirm,
}: HoldingEditCauseDialogProps) {
  const { t } = useTranslation();
  // Seeded once, at mount. `HoldingsPage` mounts this only while a holding is
  // targeted and keys it on that holding, the same as `ApyConfigSheet` — so
  // there is no reset effect here for the same reason there is none there, and
  // a second holding cannot inherit the first one's answer.
  const [cause, setCause] = useState<ManualEditCause>(defaultCause ?? 'flow');
  const [date, setDate] = useState(todayIso);
  const [destination, setDestination] = useState<ManualOutflowDestination | null>(null);
  const [holdingDestination, setHoldingDestination] = useState<TransferDestination | null>(null);
  // Empty means "no fee", which is the common case and must stay one keystroke
  // away from nothing rather than a zero somebody has to clear.
  const [fee, setFee] = useState('');

  const asksDestination = cause === 'flow' && isOutflow;

  // Fetched only once the one answer that can use it is open, exactly as
  // `TransferDecision` does: the common path is a withdrawal that left the
  // portfolio, and it should not pay for an account list nobody opens.
  const destinations = trpc.transferReview.listDestinationsForHolding.useQuery(
    { holdingId },
    { enabled: asksDestination && destination === 'internal' }
  );

  // The ONLY state the form refuses is `internal` with no holding picked —
  // the one combination `TransferReviewService.resolve` throws on rather than
  // refuses, which would surface as a 500 over a form filled in correctly
  // except for a field the client failed to send.
  //
  // Leaving the destination unanswered is deliberately NOT refused. Somebody
  // editing a balance came to correct a number, and blocking that on a
  // question about where money went is a worse failure than an extra item in
  // a queue that exists for exactly this — they may not know, and "I don't
  // know" is already representable here the way it is in the queue: by not
  // answering. The row then goes to transfer review as it always did.
  const feeStated = destination === 'internal' && fee.trim() !== '';
  // A fee that is not smaller than the movement it was charged on leaves
  // nothing to transfer, and the server refuses it. Checked here through the
  // SAME predicate rather than a second spelling of it, so the button and the
  // write cannot disagree — the arrangement `splitSumMatches` already has.
  const feeIsUsable =
    feeStated && outflowQuantity !== undefined ? feeFitsMovement(fee, outflowQuantity) : true;
  const arrives =
    feeStated && feeIsUsable && outflowQuantity !== undefined
      ? new Decimal(outflowQuantity).minus(fee).toString()
      : null;

  const incomplete =
    (asksDestination && destination === 'internal' && !holdingDestination) || !feeIsUsable;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('v3.holdings.editCause.title')}</DialogTitle>
          <DialogDescription>
            {t('v3.holdings.editCause.description', { holding: holdingLabel })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Segmented
            value={cause}
            onValueChange={(next) => setCause(next as ManualEditCause)}
            aria-label={t('v3.holdings.editCause.title')}
          >
            {MANUAL_EDIT_CAUSES.map((option) => (
              <SegmentedItem key={option} value={option}>
                {t(`v3.holdings.editCause.option.${option}`)}
              </SegmentedItem>
            ))}
          </Segmented>

          <p className="text-label text-muted-foreground">
            {t(`v3.holdings.editCause.explain.${cause}`)}
          </p>

          {cause === 'flow' ? (
            <div className="flex flex-col gap-2">
              <Label htmlFor="holding-edit-cause-date">
                {t('v3.holdings.editCause.dateLabel')}
              </Label>
              <DateField id="holding-edit-cause-date" value={date} onChange={setDate} />
            </div>
          ) : null}

          {asksDestination ? (
            <div className="flex flex-col gap-2">
              <Label>{t('v3.holdings.editCause.destinationLabel')}</Label>
              <Segmented
                value={destination ?? ''}
                onValueChange={(next) => {
                  setDestination(next as ManualOutflowDestination);
                  if (next !== 'internal') setHoldingDestination(null);
                }}
                aria-label={t('v3.holdings.editCause.destinationLabel')}
              >
                {MANUAL_OUTFLOW_DESTINATIONS.map((option) => (
                  <SegmentedItem key={option} value={option}>
                    {t(`v3.holdings.editCause.destination.${option}`)}
                  </SegmentedItem>
                ))}
              </Segmented>
              {destination ? (
                <p className="text-label text-muted-foreground">
                  {t(`v3.holdings.editCause.destinationExplain.${destination}`)}
                </p>
              ) : null}
              {destination === 'internal' ? (
                <>
                  <TransferDestinationPicker
                    destinations={destinations.data ?? []}
                    tokenSymbol={tokenSymbol}
                    groupName={`holding-edit-destination-${holdingId}`}
                    selected={holdingDestination}
                    onSelect={setHoldingDestination}
                    isLoading={destinations.isLoading}
                  />
                  {/* A wire leaves one amount and arrives as another, and
                      until SC-857 there was no way to say so: the same figure
                      went to both legs, so the destination was overstated by
                      whatever the bank kept. Optional and empty by default —
                      most transfers between your own accounts cost nothing,
                      and a required field here would make every one of them
                      a decision. */}
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="holding-edit-fee">{t('v3.holdings.editCause.feeLabel')}</Label>
                    <AmountInput
                      id="holding-edit-fee"
                      value={fee}
                      onValueChange={setFee}
                      suffix={` ${tokenSymbol}`}
                    />
                    <p className="text-label text-muted-foreground">
                      {arrives !== null
                        ? t('v3.holdings.editCause.feeArrives', {
                            amount: arrives,
                            symbol: tokenSymbol,
                          })
                        : feeIsUsable
                          ? t('v3.holdings.editCause.feeExplain')
                          : t('v3.holdings.editCause.feeTooLarge')}
                    </p>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('v3.holdings.editCause.cancel')}
          </Button>
          <Button
            disabled={incomplete}
            onClick={() =>
              onConfirm(
                cause,
                holdingEditOccurredAt(cause, date),
                asksDestination && destination
                  ? {
                      decision: destination,
                      ...(destination === 'internal' && holdingDestination
                        ? {
                            destination: {
                              accountId: holdingDestination.accountId,
                              holdingId: holdingDestination.holdingId,
                            },
                          }
                        : {}),
                      // Sent only when it is both stated and usable. An empty
                      // field is not a zero fee, it is no answer, and the
                      // schema refuses a zero.
                      ...(feeStated && feeIsUsable ? { feeQuantity: fee } : {}),
                    }
                  : undefined
              )
            }
          >
            {t('v3.holdings.editCause.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
