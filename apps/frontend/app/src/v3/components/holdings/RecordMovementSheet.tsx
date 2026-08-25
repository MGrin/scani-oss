import { Button } from '@scani/ui/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@scani/ui/ui/dialog';
import { useTranslation } from 'react-i18next';
import { useMovementForm } from '../../hooks/useMovementForm';
import type { MovementHolding, MovementSubmission } from '../../lib/movement-form';
import { MovementWhatFields, MovementWhereFields } from './MovementFields';

/**
 * "I withdrew 2000" — the movement, recorded as itself (SC-607), from the
 * holding's own peek sheet.
 *
 * ## One flow, two chromes
 *
 * This is the surface for a holding you are already inside: the record is on
 * screen, the drawer is open over it, and leaving the drawer to arrive on a
 * page would lose the place it was opened from. The global action is a page —
 * `RecordMovementPage` — because *that* one is reached from the capture sheet
 * beside every other way data gets in, and every one of those is a page
 * (SC-619). It was this dialog mounted inside an otherwise empty page, which is
 * a modal over nothing and the only capture route that behaved that way.
 *
 * Both render `MovementWhatFields` / `MovementWhereFields` over
 * `useMovementForm`, so there is one set of fields and one set of rules. What
 * differs is the frame and the way out, which is all that ever differed.
 *
 * ## Why the outflow question is not the prompt this removes
 *
 * An outflow has to say where it went, or the row sits in the transfer-review
 * queue and the count SC-607 measures is one instead of zero. Asked here it is
 * part of RECORDING; asked afterwards it is an interrogation to recover a fact
 * the owner already held, which is the defect. Same fact, same person, one
 * submit.
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
 *
 * The rule itself is `dateFieldInstant`, shared with `HoldingEditCauseDialog`
 * since SC-612 — which is the same defect on the other surface, found after
 * this one was fixed here. Two forms asking for a date must not date the same
 * movement differently.
 */

interface RecordMovementSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The holding this sheet was opened from — always set on this surface. */
  holding: MovementHolding;
  isSaving: boolean;
  onSubmit: (movement: MovementSubmission) => void;
}

export function RecordMovementSheet({
  open,
  onOpenChange,
  holding,
  isSaving,
  onSubmit,
}: RecordMovementSheetProps) {
  const { t } = useTranslation();
  const form = useMovementForm(t, holding, []);

  const submit = () => {
    const movement = form.build();
    if (movement) onSubmit(movement);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('v3.holdings.movement.title')}</DialogTitle>
          <DialogDescription>{t('v3.holdings.movement.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <MovementWhatFields form={form} holding={holding} holdings={[]} disabled={isSaving} />
          {form.asksWhere ? <MovementWhereFields form={form} disabled={isSaving} /> : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isSaving}>
            {t('v3.holdings.movement.cancel')}
          </Button>
          <Button onClick={submit} disabled={form.blockers.length > 0 || isSaving}>
            {isSaving ? t('v3.holdings.movement.saving') : t('v3.holdings.movement.save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
