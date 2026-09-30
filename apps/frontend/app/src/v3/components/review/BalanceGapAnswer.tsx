import type { BalanceGap } from '@scani/shared';
import { Button } from '@scani/ui/ui/button';
import { MessageSquareText } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FormActions, FormSheet } from '../form/FormSheet';
import { BalanceGapAnswerFields, useBalanceGapAnswer } from './BalanceGapAnswerFields';

/**
 * The balance queue's one action: explain the change (SC-501, SC-1433).
 *
 * The first of the gap's peek `actions`, and the answer is a `FormSheet` like
 * every other edit (UI standard rules 4 and 13) — Cancel, then Record, with
 * whatever is still missing said above them.
 */
export function ExplainGapAction({ gap, onAnswered }: { gap: BalanceGap; onAnswered: () => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <MessageSquareText className="me-2 size-4" aria-hidden="true" />
        {t('v3.review.balances.explainAction')}
      </Button>
      {/* Mounted only while open, so each opening starts from no answer —
          nothing is pre-selected (see `BalanceGapAnswerFields`). */}
      {open ? (
        <BalanceGapAnswerSheet
          gap={gap}
          onOpenChange={setOpen}
          onAnswered={() => {
            setOpen(false);
            onAnswered();
          }}
        />
      ) : null}
    </>
  );
}

function BalanceGapAnswerSheet({
  gap,
  onOpenChange,
  onAnswered,
}: {
  gap: BalanceGap;
  onOpenChange: (open: boolean) => void;
  onAnswered: () => void;
}) {
  const { t } = useTranslation();
  const form = useBalanceGapAnswer(gap, onAnswered);
  return (
    <FormSheet
      open
      onOpenChange={onOpenChange}
      title={t('v3.review.balances.answerTitle')}
      description={t('v3.review.balances.answerDescription')}
      footer={
        <FormActions
          submitLabel={t('v3.review.balances.record')}
          pendingLabel={t('v3.form.saving')}
          onSubmit={form.submit}
          onCancel={() => onOpenChange(false)}
          blockers={form.blockers}
          pending={form.pending}
          error={form.failure}
        />
      }
    >
      <BalanceGapAnswerFields form={form} />
    </FormSheet>
  );
}
