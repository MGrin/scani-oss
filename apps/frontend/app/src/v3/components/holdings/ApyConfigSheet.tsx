import { type HoldingWithDetails, monthName, weekdayName } from '@scani/shared';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@scani/ui/ui/select';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { invalidatePortfolioQueries } from '@/hooks/invalidatePortfolioQueries';
import { trpc } from '@/lib/trpc';
import {
  type ApyDraft,
  apyBlockers,
  apyConfigInput,
  apyDayNote,
  apyDraftFromConfig,
  apyPreviewSentence,
  frequencyLabelKey,
  needsDayOfMonth,
  needsDayOfWeek,
  needsMonth,
  PAYOUT_FREQUENCIES,
} from '../../lib/apy';
import { Field, FieldRow } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';

/**
 * Interest on a holding — the last of v2's six borrowed dialogs (SC-320).
 *
 * The rewrite earns itself on one line, and it is not the shell. v2's form
 * takes an annual percentage and a frequency and then says nothing further:
 * the reader agrees to "4.5%, daily" without the form ever naming the quantity
 * that will land in the balance, and the two numbers it *does* show — the rate
 * and the day — are both altered by the job before anything is paid. So the
 * summary line under the fields is the point of the file. It states the
 * schedule the way the peek will state it back, and the size of the next
 * payout, computed by `nextPayoutAmount` over the same `PAYOUTS_PER_YEAR` the
 * job divides by.
 *
 * **The form state is initialised once, from the holding this was opened for.**
 * There is no reset effect, because there is nothing to reset: `HoldingsPage`
 * mounts this only while a holding is targeted and keys it by that holding's
 * id, so a second holding gets a second component rather than the first one's
 * state. That is the shape SC-320's slice 3 arrived at the hard way — v2's
 * `AssignGroupsDialog` stayed mounted, kept the previous selection's checked
 * set, and wrote it onto the new one.
 */

interface ApyConfigSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  holding: HoldingWithDetails;
}

export function ApyConfigSheet({ open, onOpenChange, holding }: ApyConfigSheetProps) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const existing = holding.apyConfig;
  const isEdit = Boolean(existing);

  const [draft, setDraft] = useState<ApyDraft>(() => apyDraftFromConfig(existing));
  const [failure, setFailure] = useState<string | null>(null);

  const patch = (fields: Partial<ApyDraft>) => setDraft((current) => ({ ...current, ...fields }));

  const upsert = trpc.holdings.upsertApyConfig.useMutation({
    onSuccess: () => {
      void invalidatePortfolioQueries(utils);
      onOpenChange(false);
    },
    onError: (error) => {
      const copy = describeQueryError(error, t('v3.holdings.apy.subject'), 'save');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
  });

  const blockers = apyBlockers(t, draft);

  const handleSubmit = () => {
    const input = apyConfigInput(draft);
    if (input === null) return;
    setFailure(null);
    upsert.mutate({ holdingId: holding.id, ...input });
  };

  // Every year the reader could mean, answered for the one they are in: the
  // clamp is a property of the calendar rather than of the config, so a leap
  // year moves the answer and the note has to move with it.
  const year = new Date().getUTCFullYear();
  const dayNote = apyDayNote(t, draft, year);
  const preview = apyPreviewSentence(
    t,
    draft,
    { amount: holding.amount, symbol: holding.token.symbol },
    year
  );

  return (
    <FormSheet
      open={open}
      onOpenChange={onOpenChange}
      title={isEdit ? t('v3.holdings.apy.editTitle') : t('v3.holdings.apy.createTitle')}
      description={t('v3.holdings.apy.description')}
    >
      <div className="flex flex-col gap-4">
        <FieldRow>
          <Field label={t('v3.holdings.apy.rate')} htmlFor="v3-apy-rate">
            <AmountInput
              id="v3-apy-rate"
              value={draft.rate}
              onValueChange={(rateValue) => patch({ rate: rateValue })}
              decimalScale={4}
              placeholder={t('v3.holdings.apy.ratePlaceholder')}
            />
          </Field>
          <Field label={t('v3.holdings.apy.frequencyLabel')} htmlFor="v3-apy-frequency">
            <Select
              value={draft.frequency}
              onValueChange={(value) => patch({ frequency: value as ApyDraft['frequency'] })}
            >
              <SelectTrigger id="v3-apy-frequency" className="h-11 text-body">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYOUT_FREQUENCIES.map((code) => (
                  <SelectItem key={code} value={code} className="text-body">
                    {t(frequencyLabelKey(code))}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FieldRow>

        {needsDayOfWeek(draft.frequency) ? (
          <Field label={t('v3.holdings.apy.dayOfWeek')} htmlFor="v3-apy-day-of-week">
            <Select
              value={String(draft.dayOfWeek)}
              onValueChange={(value) => patch({ dayOfWeek: Number(value) })}
            >
              <SelectTrigger id="v3-apy-day-of-week" className="h-11 text-body">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[0, 1, 2, 3, 4, 5, 6].map((day) => (
                  <SelectItem key={day} value={String(day)} className="text-body">
                    {weekdayName(day)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        ) : null}

        {needsDayOfMonth(draft.frequency) ? (
          // Day first, month second — the order `APP_LOCALE`'s en-GB writes a
          // date in, and the order that keeps the day field in the same grid
          // cell when the frequency changes. Month-first reads as the DTO's
          // field order and slides the day box across the sheet in response to
          // a change made in a field above it.
          <FieldRow>
            <Field
              label={t('v3.holdings.apy.dayOfMonth')}
              htmlFor="v3-apy-day-of-month"
              hint={dayNote}
            >
              <AmountInput
                id="v3-apy-day-of-month"
                value={draft.dayOfMonth}
                onValueChange={(value) => patch({ dayOfMonth: value })}
                decimalScale={0}
                placeholder={t('v3.holdings.apy.dayOfMonthPlaceholder')}
              />
            </Field>
            {needsMonth(draft.frequency) ? (
              <Field label={t('v3.holdings.apy.month')} htmlFor="v3-apy-month">
                <Select
                  value={String(draft.month)}
                  onValueChange={(value) => patch({ month: Number(value) })}
                >
                  <SelectTrigger id="v3-apy-month" className="h-11 text-body">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((month) => (
                      <SelectItem key={month} value={String(month)} className="text-body">
                        {monthName(month)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            ) : null}
          </FieldRow>
        ) : null}

        {preview ? <ApyPreview text={preview} /> : null}

        {isEdit ? (
          <p className="text-caption text-muted-foreground">{t('v3.holdings.apy.editRestarts')}</p>
        ) : null}

        <FormActions
          submitLabel={isEdit ? t('v3.holdings.apy.saveEdit') : t('v3.holdings.apy.saveCreate')}
          pendingLabel={t('v3.holdings.apy.saving')}
          onSubmit={handleSubmit}
          onCancel={() => onOpenChange(false)}
          blockers={blockers}
          pending={upsert.isPending}
          error={failure}
        />
      </div>
    </FormSheet>
  );
}

/**
 * The one sentence this form exists to add, as a component of its own so a test
 * can reach it — Radix renders nothing at all under `renderToStaticMarkup`, so
 * an assertion against the whole sheet would pass over an empty string. Same
 * split `PriceEditHistory` makes.
 *
 * `role="status"`: it changes under the reader as they change the rate or the
 * frequency, and a figure that silently rewrites itself is the one a screen
 * reader never announces.
 */
export function ApyPreview({ text }: { text: string }) {
  return (
    <p role="status" className="rounded-md border border-border px-3 py-2 text-caption">
      {text}
    </p>
  );
}
