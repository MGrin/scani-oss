import type { BalanceGapAnswer as Answer, BalanceGap } from '@scani/shared';
import {
  BALANCE_GAP_ANSWERS,
  Decimal,
  feeFitsMovement,
  MANUAL_OUTFLOW_DESTINATIONS,
  type ManualOutflowDestination,
  type TransferDestination,
} from '@scani/shared';
import { userFacingMessage } from '@scani/ui/lib/user-facing-error';
import { Checkbox } from '@scani/ui/ui/checkbox';
import { Label } from '@scani/ui/ui/label';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { balanceGapOccurredAt } from '../../lib/balance-gaps';
import {
  type SplitDraftRow,
  type SplitSubject,
  splitBlockers,
  toSplitPortions,
} from '../../lib/transfer-review';
import { ChoiceSelect } from '../form/ChoiceSelect';
import { DateField } from '../form/DateField';
import { Field } from '../form/Field';
import { FormSection } from '../form/FormSheet';
import { TransferDestinationPicker } from './TransferDestinationPicker';
import { emptySplitRows, TransferSplitEditor } from './TransferSplitEditor';

/**
 * "What was this?" — the same question `useHoldingEditCause` asks about a
 * balance the owner typed, asked about one a sync observed (SC-501).
 *
 * The three causes are `MANUAL_EDIT_CAUSES` and they reach the same writer, so
 * the wording, the ordering and the per-cause explanation are shared with that
 * dialog rather than restated. What is different here is the fourth answer and
 * the default date.
 *
 * **Nothing is pre-selected.** A queue that empties itself by offering the
 * likely answer under the reader's finger is a queue that produces confident
 * wrong flows, and this feature exists because a confident wrong flow is
 * exactly what nobody could see. The reader picks.
 *
 * **A date is asked for only when it can beat what we already hold.** On a
 * short interval the two observations date the movement to the hour, and a
 * date field cannot: it collects a DAY, and a day becomes an instant at local
 * midnight. Measured on production 2026-08-22 with the owner in UTC+8, an
 * honest date-only answer landed fourteen hours before the hour it described.
 * So `datePrompted` is false there and the server stamps the closing
 * observation, which is more precise than anything this control could return.
 *
 * When it IS asked for — a seventy-one-day gap, a forty-day one — it defaults
 * to the end of the interval and the server clamps it into the window. Today
 * would be the one date the money demonstrably did not move, because the
 * closing observation already shows it had moved by then.
 *
 * The state lives in `useBalanceGapAnswer` and the fields render inside
 * `ExplainGapAction`'s `FormSheet` (UI standard rule 13, SC-1433): until then
 * the whole form sat open in every card of the queue.
 */

/** `YYYY-MM-DD` in the reader's own zone, which is the zone the field edits. */
function isoDate(at: Date): string {
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  return `${at.getFullYear()}-${month}-${day}`;
}

export function useBalanceGapAnswer(gap: BalanceGap, onAnswered: () => void) {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [date, setDate] = useState(() => isoDate(new Date(gap.to)));
  const [destination, setDestination] = useState<ManualOutflowDestination | null>(null);
  const [holdingDestination, setHoldingDestination] = useState<TransferDestination | null>(null);
  const [fee, setFee] = useState('');
  const [crossCurrency, setCrossCurrency] = useState(false);
  const [arrivalId, setArrivalId] = useState('');
  const [receivedQuantity, setReceivedQuantity] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  // Money that left for several places at once (SC-1665). A gap has no
  // deposit to pair with, so the `paired` row is not offered.
  const [split, setSplit] = useState(false);
  const [splitRows, setSplitRows] = useState<SplitDraftRow[]>(() =>
    emptySplitRows(null).filter((row) => row.decision !== 'paired')
  );
  const splitSubject: SplitSubject = {
    transactionId: gap.observationId,
    quantity: new Decimal(gap.drift).abs().toString(),
    tokenSymbol: gap.tokenSymbol,
  };

  const withdrawal = answer === 'flow' && new Decimal(gap.drift).lt(0);
  const divided = withdrawal && split;
  const arrivals = trpc.balanceGaps.crossCurrencyDestinations.useQuery(
    { holdingId: gap.holdingId },
    { enabled: crossCurrency && destination === 'internal' }
  );
  const destinations = trpc.transferReview.listDestinationsForHolding.useQuery(
    { holdingId: gap.holdingId },
    { enabled: withdrawal && (destination === 'internal' || split) }
  );
  const arrival = arrivals.data?.find((row) => row.holdingId === arrivalId);
  const target = crossCurrency ? arrival : holdingDestination;
  const receivedValid = (() => {
    try {
      const amount = new Decimal(receivedQuantity);
      return amount.isFinite() && amount.gt(0);
    } catch {
      return false;
    }
  })();
  const validFee =
    fee.trim() === '' || feeFitsMovement(fee, new Decimal(gap.drift).abs().toString());
  // `balanceGapOccurredAt` owns the rule and carries why it exists: a date
  // that was never asked for must not be sent, because the untouched default
  // is a local-midnight instant that can sit hours outside the interval.
  const occurredAt = answer ? balanceGapOccurredAt(answer, gap, date) : null;

  const blockers: string[] = [];
  if (!answer) blockers.push(t('v3.review.balances.blocker.answer'));
  if (answer === 'flow' && gap.datePrompted && !occurredAt)
    blockers.push(t('v3.review.balances.blocker.date'));
  if (divided) blockers.push(...splitBlockers(t, splitRows, splitSubject));
  if (withdrawal && !divided && !destination)
    blockers.push(t('v3.review.balances.blocker.destination'));
  if (withdrawal && !divided && destination === 'internal') {
    if (!target) blockers.push(t('v3.review.balances.blocker.destination'));
    if (crossCurrency && !receivedValid) blockers.push(t('v3.review.balances.blocker.received'));
    if (!validFee) blockers.push(t('v3.holdings.fee.tooLarge'));
  }

  const mutation = trpc.balanceGaps.answer.useMutation({
    onSuccess: onAnswered,
    // `userFacingMessage` passes a deliberately-written server message through
    // and returns null for anything else, so an internal string cannot reach
    // the reader (SC-311, SC-551). The fallback is ours.
    onError: (error) =>
      setFailure(userFacingMessage(error) ?? t('v3.review.balances.answerFailedBody')),
  });

  const submit = () => {
    if (!answer || blockers.length > 0) return;
    setFailure(null);
    mutation.mutate({
      observationId: gap.observationId,
      answer,
      ...(divided ? { parts: toSplitPortions(splitRows) } : {}),
      ...(withdrawal && !divided && destination
        ? {
            editOutflow: {
              decision: destination,
              ...(destination === 'internal' && target
                ? {
                    destination: { accountId: target.accountId, holdingId: target.holdingId },
                    ...(fee.trim() ? { feeQuantity: fee } : {}),
                  }
                : {}),
            },
          }
        : {}),
      ...(withdrawal && !divided && destination === 'internal' && crossCurrency
        ? { receivedQuantity }
        : {}),
      ...(occurredAt ? { occurredAt } : {}),
    });
  };

  return {
    gap,
    answer,
    setAnswer,
    date,
    setDate,
    withdrawal,
    destination,
    setDestination,
    holdingDestination,
    setHoldingDestination,
    fee,
    setFee,
    crossCurrency,
    setCrossCurrency,
    arrivalId,
    setArrivalId,
    arrival,
    arrivals: arrivals.data ?? [],
    destinations: destinations.data ?? [],
    destinationsLoading: destinations.isLoading,
    receivedQuantity,
    setReceivedQuantity,
    split,
    setSplit,
    splitRows,
    setSplitRows,
    splitSubject,
    blockers,
    failure,
    pending: mutation.isPending,
    submit,
  };
}

export type BalanceGapAnswerForm = ReturnType<typeof useBalanceGapAnswer>;

export function BalanceGapAnswerFields({ form }: { form: BalanceGapAnswerForm }) {
  const { t } = useTranslation();
  const { gap, answer } = form;
  const id = gap.observationId;

  return (
    <>
      <Field
        label={t('v3.review.balances.answerLabel')}
        hint={
          answer
            ? // A short interval is answered `flow` without ever being asked for
              // a date, so the ordinary copy — "on the date you give" — would
              // describe a field that is not on screen.
              t(
                answer === 'flow' && !gap.datePrompted
                  ? 'v3.review.balances.explain.flowNoDate'
                  : `v3.review.balances.explain.${answer}`
              )
            : undefined
        }
      >
        {/* A COLUMN, and not because four is one too many for this width
            (SC-576). These four labels are sentences, they are translated, and
            a row divides the width by the option count — so at 393px the
            control rendered `Money movFigure was wrongIt grew  I don't know`,
            one unreadable run. A horizontal fit tuned to English would be one
            translation away from the same defect, so the axis changes rather
            than the numbers. See the note on `Segmented`. */}
        <Segmented
          orientation="vertical"
          value={answer ?? ''}
          onValueChange={(next) => form.setAnswer(next as Answer)}
          aria-label={t('v3.review.balances.answerLabel')}
        >
          {BALANCE_GAP_ANSWERS.map((option) => (
            <SegmentedItem key={option} value={option}>
              {t(`v3.review.balances.option.${option}`)}
            </SegmentedItem>
          ))}
        </Segmented>
      </Field>

      {answer === 'flow' && gap.datePrompted ? (
        <Field label={t('v3.review.balances.dateLabel')} htmlFor={`balance-gap-date-${id}`}>
          <DateField id={`balance-gap-date-${id}`} value={form.date} onChange={form.setDate} />
        </Field>
      ) : null}

      {form.withdrawal ? (
        <FormSection title={t('v3.holdings.editCause.destinationLabel')}>
          <div className="flex items-center gap-2">
            <Checkbox
              id={`gap-split-${id}`}
              checked={form.split}
              onCheckedChange={(checked) => form.setSplit(checked === true)}
            />
            <Label htmlFor={`gap-split-${id}`}>{t('v3.review.transfer.split.trigger')}</Label>
          </div>
          {form.split ? (
            <TransferSplitEditor
              item={form.splitSubject}
              rows={form.splitRows}
              onChange={form.setSplitRows}
              hasMatch={false}
              destinations={form.destinations}
              destinationsLoading={form.destinationsLoading}
              subject="change"
            />
          ) : null}
          {form.split ? null : (
            <Segmented
              orientation="vertical"
              value={form.destination ?? ''}
              onValueChange={(value) => form.setDestination(value as ManualOutflowDestination)}
              aria-label={t('v3.holdings.editCause.destinationLabel')}
            >
              {MANUAL_OUTFLOW_DESTINATIONS.map((option) => (
                <SegmentedItem key={option} value={option}>
                  {t(`v3.holdings.editCause.destination.${option}`)}
                </SegmentedItem>
              ))}
            </Segmented>
          )}
          {!form.split && form.destination === 'internal' ? (
            <>
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`gap-cross-${id}`}
                  checked={form.crossCurrency}
                  onCheckedChange={(checked) => form.setCrossCurrency(checked === true)}
                />
                <Label htmlFor={`gap-cross-${id}`}>{t('v3.review.balances.crossCurrency')}</Label>
              </div>
              {form.crossCurrency ? (
                <>
                  <Field
                    label={t('v3.holdings.editCause.destinationLabel')}
                    htmlFor={`gap-arrival-${id}`}
                  >
                    <ChoiceSelect
                      id={`gap-arrival-${id}`}
                      label={t('v3.holdings.editCause.destinationLabel')}
                      placeholder={t('v3.review.balances.chooseArrival')}
                      value={form.arrivalId}
                      onValueChange={form.setArrivalId}
                      options={form.arrivals.map((row) => ({
                        value: row.holdingId,
                        label: `${row.accountName} · ${row.tokenSymbol}`,
                      }))}
                    />
                  </Field>
                  <Field label={t('v3.review.balances.received')} htmlFor={`gap-received-${id}`}>
                    <AmountInput
                      id={`gap-received-${id}`}
                      value={form.receivedQuantity}
                      onValueChange={form.setReceivedQuantity}
                      suffix={form.arrival ? ` ${form.arrival.tokenSymbol}` : undefined}
                    />
                  </Field>
                </>
              ) : (
                <TransferDestinationPicker
                  destinations={form.destinations}
                  tokenSymbol={gap.tokenSymbol}
                  groupName={`gap-${id}`}
                  selected={form.holdingDestination}
                  onSelect={form.setHoldingDestination}
                  isLoading={form.destinationsLoading}
                />
              )}
              <Field label={t('v3.holdings.fee.label')} htmlFor={`gap-fee-${id}`}>
                <AmountInput
                  id={`gap-fee-${id}`}
                  value={form.fee}
                  onValueChange={form.setFee}
                  suffix={` ${gap.tokenSymbol}`}
                />
              </Field>
            </>
          ) : null}
        </FormSection>
      ) : null}
    </>
  );
}
