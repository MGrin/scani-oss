import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { Field } from '../form/Field';
import { EditAction, FormActions, FormSheet } from '../form/FormSheet';
import { PaymentGroupsPicker } from './PaymentGroupsPicker';

/**
 * One occurrence's expected amount and groups — an Edit action in its peek
 * that opens a `FormSheet` (UI standard rule 13). It was an unlabelled inline
 * block with no Cancel until SC-1436.
 */
export function OccurrenceEditor({
  occurrenceId,
  expectedAmount,
}: {
  occurrenceId: string;
  paymentId: string;
  expectedAmount: string | null;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <EditAction onClick={() => setOpen(true)} />
      {/* Mounted only while open, so each opening seeds from the record. */}
      {open ? (
        <EditOccurrenceSheet
          occurrenceId={occurrenceId}
          expectedAmount={expectedAmount}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}

function EditOccurrenceSheet({
  occurrenceId,
  expectedAmount,
  onOpenChange,
}: {
  occurrenceId: string;
  expectedAmount: string | null;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [amount, setAmount] = useState(expectedAmount ?? '');
  const [groups, setGroups] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const assignments = trpc.payments.groupAssignments.useQuery();
  const seeded = useRef(false);
  useEffect(() => {
    if (assignments.data && !seeded.current) {
      setGroups(assignments.data.occurrences[occurrenceId] ?? []);
      seeded.current = true;
    }
  }, [assignments.data, occurrenceId]);

  const edit = trpc.payments.editOccurrence.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.payments.upcoming.invalidate(),
        utils.payments.get.invalidate(),
        utils.payments.groupAssignments.invalidate(),
      ]);
      onOpenChange(false);
    },
    onError: (error) => {
      const copy = describeQueryError(error, t('v3.money.thisPayment'), 'save');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
  });

  // The groups are seeded from the assignments; saving before they arrive
  // would clear every group this occurrence is in.
  const blockers = assignments.data ? [] : [t('v3.money.occurrence.blockerGroups')];

  return (
    <FormSheet
      open
      onOpenChange={onOpenChange}
      title={t('v3.money.occurrence.title')}
      description={t('v3.money.occurrence.description')}
      footer={
        <FormActions
          submitLabel={t('v3.form.saveChanges')}
          pendingLabel={t('v3.form.saving')}
          onSubmit={() =>
            edit.mutate({ occurrenceId, expectedAmount: amount.trim() || null, groupIds: groups })
          }
          onCancel={() => onOpenChange(false)}
          blockers={blockers}
          pending={edit.isPending}
          error={failure}
        />
      }
    >
      <Field label={t('v3.money.paymentForm.amount')} htmlFor={`occurrence-amount-${occurrenceId}`}>
        <AmountInput
          id={`occurrence-amount-${occurrenceId}`}
          value={amount}
          onValueChange={setAmount}
          disabled={edit.isPending}
        />
      </Field>
      <PaymentGroupsPicker value={groups} onChange={setGroups} disabled={edit.isPending} />
    </FormSheet>
  );
}
