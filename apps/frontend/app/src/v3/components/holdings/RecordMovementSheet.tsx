import {
  HOLDING_MOVEMENT_DIRECTIONS,
  type HoldingMovementDirection,
  OUTFLOW_DESTINATIONS,
  type OutflowDestination,
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAccountTarget } from '../../hooks/useAccountTarget';
import { buildEnsureAccountInput } from '../../lib/manual-entry';
import { AccountTargetFields } from '../capture/AccountTargetFields';
import { DateField } from '../form/DateField';

/**
 * "I withdrew 2000" — the movement, recorded as itself (SC-607).
 *
 * ## One component, two ways in
 *
 * Mounted from the holding's own peek sheet with that holding fixed, and from
 * the global *record a movement* action with a holding to pick. Those are two
 * entry points into one flow rather than two flows, which is why the holding
 * is a PROP and not a mode: everything below the first field is identical, and
 * the version of this that had a second form for the global case would drift
 * on the first change to either.
 *
 * ## Why the outflow question is not the prompt this removes
 *
 * An outflow has to say where it went, or the row sits in the transfer-review
 * queue and the count this ticket measures is one instead of zero. Asked here
 * it is part of RECORDING; asked afterwards it is an interrogation to recover
 * a fact the owner already held, which is the defect. Same fact, same person,
 * one submit.
 *
 * The third option is not a fourth kind of movement — it *is* the transfer,
 * reached from the question a person actually asks themselves ("where did that
 * money go?") rather than from the vocabulary. Choosing it moves the control
 * above, so there is one piece of state and the two routes cannot disagree.
 *
 * ## The date, and why it is not always midnight
 *
 * Pre-filled with today, editable, because the owner knows when they moved the
 * money and Scani never will. But an unchanged date is sent as the actual
 * INSTANT, not as the chosen day's local midnight — and that is load-bearing
 * rather than pedantic. In a UTC+12 timezone local midnight is the previous
 * day in UTC, which lands BEFORE an observation recorded earlier the same day;
 * a flow dated before the interval it explains leaves that interval
 * unexplained, and this feature would manufacture exactly the review prompt it
 * exists to remove. Measured by SC-606 on this repo: three prompts with a
 * same-day prior observation against two with a 72-hour-old one. Only a
 * deliberately chosen other day becomes that day's midnight.
 */

export interface MovementHolding {
  id: string;
  amount: string;
  token: { symbol: string };
  account: { name: string };
  label?: string | null;
}

interface RecordMovementSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Fixed when opened from a holding's own sheet. `null` opens the picker —
   * the global action, where choosing the account is the first step.
   */
  holding: MovementHolding | null;
  /** Everything pickable, ignored entirely when `holding` is set. */
  holdings: readonly MovementHolding[];
  isSaving: boolean;
  onSubmit: (movement: MovementSubmission) => void;
}

export interface MovementSubmission {
  holdingId: string;
  direction: HoldingMovementDirection;
  amount: string;
  occurredAt: string;
  note?: string;
  destination?: OutflowDestination;
  /** Resolved by the caller through `ensureAccount`; null when incomplete. */
  ensureAccount?: ReturnType<typeof buildEnsureAccountInput>;
}

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** See the note on the date above: today means now, another day means midnight. */
export function movementInstant(date: string): string {
  return date === todayIso()
    ? new Date().toISOString()
    : new Date(`${date}T00:00:00`).toISOString();
}

function holdingName(holding: MovementHolding): string {
  return `${holding.account.name} · ${holding.label || holding.token.symbol}`;
}

export function RecordMovementSheet({
  open,
  onOpenChange,
  holding,
  holdings,
  isSaving,
  onSubmit,
}: RecordMovementSheetProps) {
  const { t } = useTranslation();
  const accountTarget = useAccountTarget();

  const [holdingId, setHoldingId] = useState(holding?.id ?? '');
  const [direction, setDirection] = useState<HoldingMovementDirection>('outflow');
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(todayIso);
  const [note, setNote] = useState('');
  /**
   * Nothing pre-selected, and that is the same refusal
   * `TransferDestinationPicker` makes: this answer decides whether a disposal
   * is realized, so a default wearing a checkmark the reader did not put there
   * would book a taxable event on their behalf.
   */
  const [destination, setDestination] = useState<OutflowDestination | 'transfer' | null>(null);

  const selected = holding ?? holdings.find((row) => row.id === holdingId) ?? null;
  const ensure = buildEnsureAccountInput(accountTarget.draft);

  const amountIsPositive = /^\d+(\.\d+)?$/.test(amount.trim()) && Number.parseFloat(amount) > 0;
  const outflowAnswered = direction !== 'outflow' || destination !== null;
  const transferTargeted = direction !== 'transfer' || ensure !== null;
  const canSubmit =
    Boolean(selected) && amountIsPositive && outflowAnswered && transferTargeted && !isSaving;

  /**
   * Choosing "it went to another account I hold" IS choosing the transfer, so
   * it moves the control above rather than adding a parallel one. One piece of
   * state, so the segmented control and the question can never disagree about
   * what is being recorded.
   */
  const chooseDestination = (next: OutflowDestination | 'transfer') => {
    setDestination(next);
    setDirection(next === 'transfer' ? 'transfer' : 'outflow');
  };

  const submit = () => {
    if (!selected) return;
    onSubmit({
      holdingId: selected.id,
      direction,
      amount: amount.trim(),
      occurredAt: movementInstant(date),
      note: note.trim() || undefined,
      destination:
        direction === 'outflow' && destination !== null && destination !== 'transfer'
          ? destination
          : undefined,
      ensureAccount: direction === 'transfer' ? ensure : undefined,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('v3.holdings.movement.title')}</DialogTitle>
          <DialogDescription>{t('v3.holdings.movement.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {holding ? null : (
            <div className="flex flex-col gap-2">
              <Label htmlFor="movement-holding">{t('v3.holdings.movement.holdingLabel')}</Label>
              <Select value={holdingId} onValueChange={setHoldingId}>
                <SelectTrigger id="movement-holding">
                  <SelectValue placeholder={t('v3.holdings.movement.holdingPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  {holdings.map((row) => (
                    <SelectItem key={row.id} value={row.id}>
                      {holdingName(row)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <Segmented
            value={direction}
            onValueChange={(next) => {
              const chosen = next as HoldingMovementDirection;
              setDirection(chosen);
              // Leaving the outflow question behind when the answer no longer
              // applies. Keeping `untracked` on a row now being recorded as an
              // inflow would submit an answer to a question nobody asked.
              setDestination(chosen === 'transfer' ? 'transfer' : null);
            }}
            aria-label={t('v3.holdings.movement.title')}
          >
            {HOLDING_MOVEMENT_DIRECTIONS.map((option) => (
              <SegmentedItem key={option} value={option}>
                {t(`v3.holdings.movement.direction.${option}`)}
              </SegmentedItem>
            ))}
          </Segmented>

          <div className="flex flex-col gap-2">
            <Label htmlFor="movement-amount">
              {t('v3.holdings.movement.amountLabel', { symbol: selected?.token.symbol ?? '' })}
            </Label>
            <AmountInput
              id="movement-amount"
              value={amount}
              onValueChange={setAmount}
              className="text-body"
              autoFocus
            />
            {selected ? (
              <p className="text-label text-muted-foreground">
                {t('v3.holdings.movement.currentBalance', {
                  amount: selected.amount,
                  symbol: selected.token.symbol,
                })}
              </p>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="movement-date">{t('v3.holdings.movement.dateLabel')}</Label>
            <DateField id="movement-date" value={date} onChange={setDate} />
          </div>

          {direction === 'outflow' || direction === 'transfer' ? (
            <fieldset className="flex flex-col gap-2">
              <legend className="pb-2 text-label text-muted-foreground">
                {t('v3.holdings.movement.whereLabel')}
              </legend>
              {[...OUTFLOW_DESTINATIONS, 'transfer' as const].map((option) => (
                <label
                  key={option}
                  className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 ${
                    destination === option
                      ? 'border-primary bg-primary/5'
                      : 'border-border bg-surface-1 hover:bg-surface-hover'
                  }`}
                >
                  <input
                    type="radio"
                    name="movement-destination"
                    className="mt-1"
                    checked={destination === option}
                    onChange={() => chooseDestination(option)}
                  />
                  <span className="flex flex-col gap-0.5">
                    <span className="text-body">
                      {t(`v3.holdings.movement.where.${option}.title`)}
                    </span>
                    <span className="text-caption text-muted-foreground">
                      {t(`v3.holdings.movement.where.${option}.detail`)}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}

          {direction === 'transfer' ? (
            <AccountTargetFields
              target={accountTarget}
              disabled={isSaving}
              title={t('v3.holdings.movement.destinationTitle')}
            />
          ) : null}

          <div className="flex flex-col gap-2">
            <Label htmlFor="movement-note">{t('v3.holdings.movement.noteLabel')}</Label>
            <input
              id="movement-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              maxLength={500}
              className="h-9 rounded-md border border-border bg-surface-1 px-3 text-body"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('v3.holdings.movement.cancel')}
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {isSaving ? t('v3.holdings.movement.saving') : t('v3.holdings.movement.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
