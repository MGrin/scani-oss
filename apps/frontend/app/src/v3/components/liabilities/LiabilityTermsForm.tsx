import type { LiabilityProjectionDto, SetLiabilityTermsDto } from '@scani/shared';
import { Input } from '@scani/ui/ui/input';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { ChoiceSelect } from '../form/ChoiceSelect';
import { DateField } from '../form/DateField';
import { Field, FieldRow } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';

type Kind = LiabilityProjectionDto['kind'];

/** The fields each kind's form shows; nothing hidden is sent. */
const FIELDS_BY_KIND: Record<Kind, readonly (keyof SetLiabilityTermsDto)[]> = {
  loan: ['annualRatePct', 'termMonths', 'startDate', 'originalPrincipal', 'contractedPayment'],
  credit_card: ['annualRatePct', 'creditLimit', 'minimumPayment', 'annualFee'],
  other: [],
};

/**
 * What the form saves: the chosen kind and only the fields its form shows.
 * Switching kind keeps the other kind's typing in state, so the payload
 * filters by kind rather than by what was typed. Blanks are left out.
 */
export function termsToSave(
  kind: Kind,
  values: Record<string, string | undefined>
): SetLiabilityTermsDto {
  const terms: Record<string, string | number> = {};
  for (const key of FIELDS_BY_KIND[kind]) {
    const value = values[key]?.trim();
    if (value) terms[key] = key === 'termMonths' ? Number(value) : value;
  }
  return { kind, ...terms };
}

interface StoredTerms {
  kind: Kind;
  annualRatePct: string | null;
  termMonths: number | null;
  startDate: string | null;
  originalPrincipal: string | null;
  contractedPayment: string | null;
  creditLimit: string | null;
  minimumPayment: string | null;
  annualFee: string | null;
}

const MONEY_FIELDS = ['originalPrincipal', 'contractedPayment'] as const;
const CARD_FIELDS = ['creditLimit', 'minimumPayment', 'annualFee'] as const;

/** SC-1640. Every term is optional; a blank field is saved as "not known". */
export function LiabilityTermsForm({
  open,
  accountId,
  kind: initialKind,
  initial,
  onDone,
}: {
  open: boolean;
  accountId: string;
  kind: Kind;
  initial: StoredTerms | null;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const [kind, setKind] = useState<Kind>(initial?.kind ?? initialKind);
  const [values, setValues] = useState<Record<string, string>>(() => ({
    annualRatePct: initial?.annualRatePct ?? '',
    termMonths: initial?.termMonths?.toString() ?? '',
    startDate: initial?.startDate ?? '',
    originalPrincipal: initial?.originalPrincipal ?? '',
    contractedPayment: initial?.contractedPayment ?? '',
    creditLimit: initial?.creditLimit ?? '',
    minimumPayment: initial?.minimumPayment ?? '',
    annualFee: initial?.annualFee ?? '',
  }));
  const save = trpc.liabilities.setTerms.useMutation({
    onSuccess: async () => {
      await Promise.all([
        utils.liabilities.getProjection.invalidate({ accountId }),
        utils.liabilities.getTerms.invalidate({ accountId }),
      ]);
      onDone();
    },
  });

  const set = (key: string) => (value: string) => setValues((v) => ({ ...v, [key]: value }));

  const submit = () => save.mutate({ accountId, ...termsToSave(kind, values) });

  const labels: Record<string, string> = {
    originalPrincipal: t('v3.liabilities.principal'),
    contractedPayment: t('v3.liabilities.contractedPayment'),
    creditLimit: t('v3.liabilities.creditLimit'),
    minimumPayment: t('v3.liabilities.minimumPayment'),
    annualFee: t('v3.liabilities.annualFee'),
  };
  const moneyField = (key: string) => (
    <Field key={key} label={labels[key] ?? key} htmlFor={`liability-${key}`}>
      <Input
        id={`liability-${key}`}
        inputMode="decimal"
        value={values[key] ?? ''}
        onChange={(e) => set(key)(e.target.value)}
      />
    </Field>
  );

  return (
    <FormSheet
      open={open}
      onOpenChange={(next) => {
        if (!next && !save.isPending) onDone();
      }}
      title={t('v3.liabilities.formTitle')}
      description={t('v3.liabilities.formDescription')}
      footer={
        <FormActions
          submitLabel={t('v3.liabilities.save')}
          pendingLabel={t('v3.liabilities.saving')}
          onSubmit={submit}
          onCancel={onDone}
          blockers={[]}
          pending={save.isPending}
          error={
            save.error
              ? describeQueryError(save.error, t('v3.liabilities.subject'), 'save').detail
              : null
          }
        />
      }
    >
      <Field label={t('v3.liabilities.kind')} htmlFor="liability-kind">
        <ChoiceSelect
          id="liability-kind"
          label={t('v3.liabilities.kind')}
          value={kind}
          onValueChange={(v) => setKind(v as Kind)}
          options={[
            { value: 'loan', label: t('v3.liabilities.kindLoan') },
            { value: 'credit_card', label: t('v3.liabilities.kindCard') },
            { value: 'other', label: t('v3.liabilities.kindOther') },
          ]}
        />
      </Field>
      {kind !== 'other' ? (
        <Field label={t('v3.liabilities.rate')} htmlFor="liability-rate">
          <Input
            id="liability-rate"
            inputMode="decimal"
            value={values.annualRatePct}
            onChange={(e) => set('annualRatePct')(e.target.value)}
          />
        </Field>
      ) : null}
      {kind === 'loan' ? (
        <>
          <FieldRow>
            <Field label={t('v3.liabilities.termMonths')} htmlFor="liability-term">
              <Input
                id="liability-term"
                inputMode="numeric"
                value={values.termMonths}
                onChange={(e) => set('termMonths')(e.target.value)}
              />
            </Field>
            <Field label={t('v3.liabilities.startDate')} htmlFor="liability-start">
              <DateField
                id="liability-start"
                value={values.startDate ?? ''}
                onChange={set('startDate')}
              />
            </Field>
          </FieldRow>
          {MONEY_FIELDS.map(moneyField)}
        </>
      ) : null}
      {kind === 'credit_card' ? CARD_FIELDS.map(moneyField) : null}
    </FormSheet>
  );
}
