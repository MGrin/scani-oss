import { MANUAL_EDIT_CAUSES, type ManualEditCause } from '@scani/shared';
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
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DateField } from '../form/DateField';

/**
 * "What did that change mean?" — asked once, per edit, on the holdings whose
 * balance is the only channel their performance can arrive through (SC-510).
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
 * ## The date
 *
 * Pre-filled with today and editable. The user knows when they moved the
 * money and we never will, so it is cheap when today is right and correct when
 * it is not. Dating every flow at the edit instant was rejected: it
 * concentrates months of movement onto one day and distorts time-weighted
 * return around it, which is the failure `e1fa63e5` removed.
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
  /** The last answer given for this holding, pre-selected. */
  defaultCause?: ManualEditCause | null;
  onConfirm: (cause: ManualEditCause, occurredAt: string | undefined) => void;
}

function todayIso(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

export function HoldingEditCauseDialog({
  open,
  onOpenChange,
  holdingLabel,
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
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('v3.holdings.editCause.cancel')}
          </Button>
          <Button
            onClick={() =>
              onConfirm(
                cause,
                // Local midnight of the chosen day, sent as an instant. Only a
                // flow carries one; the server dates the other two itself.
                cause === 'flow' ? new Date(`${date}T00:00:00`).toISOString() : undefined
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
