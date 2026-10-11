import { getFormatLocale } from '@scani/shared';
import { Badge } from '@scani/ui/ui/badge';
import { Button } from '@scani/ui/ui/button';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { Numeric } from '@scani/ui/v3/components/Numeric';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { trpc } from '@/lib/trpc';
import { parsePositivePrice } from '../../lib/custom-tokens';
import {
  formatArea,
  formatDistance,
  newestFirst,
  serverDay,
  type ValuationRow,
} from '../../lib/valued-assets';
import { DateField, todayIso } from '../form/DateField';
import { Field } from '../form/Field';
import { FormActions, FormSheet } from '../form/FormSheet';

export interface ValuedAssetHistoryView {
  name: string;
  details:
    | { kind: 'property'; address?: string; areaSqm?: number }
    | { kind: 'vehicle'; make?: string; model?: string; year?: number; mileageKm?: number };
  purchase: { on: string; price: string };
  valuations: ValuationRow[];
  current: string;
  gain: string;
  currencyCode: string;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-end">{children}</span>
    </div>
  );
}

/**
 * A property's or vehicle's details and its valuations (SC-1643), newest
 * first. A row a later same-day one corrected stays in the list, marked, so
 * the history says what was entered and what replaced it.
 */
export function ValuedAssetDetailsView({
  history,
  locale,
}: {
  history: ValuedAssetHistoryView;
  locale: string;
}) {
  const { t } = useTranslation();
  const { details, currencyCode: currency } = history;
  return (
    <div className="flex flex-col gap-4">
      <section aria-label={t('v3.valuedAssets.details.title')}>
        <h3 className="text-label text-muted-foreground">{t('v3.valuedAssets.details.title')}</h3>
        {details.kind === 'property' ? (
          <>
            {details.address ? (
              <Fact label={t('v3.valuedAssets.addressLabel')}>{details.address}</Fact>
            ) : null}
            {details.areaSqm !== undefined ? (
              <Fact label={t('v3.valuedAssets.details.area')}>
                {formatArea(details.areaSqm, locale)}
              </Fact>
            ) : null}
          </>
        ) : (
          <>
            {details.make || details.model ? (
              <Fact label={t('v3.valuedAssets.details.vehicle')}>
                {[details.make, details.model].filter(Boolean).join(' ')}
              </Fact>
            ) : null}
            {details.year !== undefined ? (
              <Fact label={t('v3.valuedAssets.yearLabel')}>{details.year}</Fact>
            ) : null}
            {details.mileageKm !== undefined ? (
              <Fact label={t('v3.valuedAssets.details.mileage')}>
                {formatDistance(details.mileageKm, locale)}
              </Fact>
            ) : null}
          </>
        )}
        <Fact label={t('v3.valuedAssets.details.purchase', { date: history.purchase.on })}>
          <Numeric value={history.purchase.price} currency={currency} />
        </Fact>
        <Fact label={t('v3.valuedAssets.details.gain')}>
          <Numeric value={history.gain} currency={currency} delta />
        </Fact>
      </section>

      <section aria-label={t('v3.valuedAssets.history.title')}>
        <h3 className="text-label text-muted-foreground">{t('v3.valuedAssets.history.title')}</h3>
        <ul className="flex flex-col">
          {newestFirst(history.valuations).map((row) => (
            <li
              key={row.recordedAt}
              className={`flex items-baseline justify-between gap-4 py-1.5 ${row.replaced ? 'text-muted-foreground' : ''}`}
            >
              <span>
                {row.on}
                {row.replaced ? (
                  <Badge variant="outline" className="ms-2">
                    {t('v3.valuedAssets.history.corrected')}
                  </Badge>
                ) : null}
              </span>
              <Numeric value={row.value} currency={currency} />
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** The live panel in a valued asset's peek: its history, and a valuation to add. */
export function ValuedAssetDetails({ holdingId }: { holdingId: string }) {
  const { t } = useTranslation();
  const utils = trpc.useUtils();
  const history = trpc.valuedAssets.history.useQuery({ holdingId });
  const [adding, setAdding] = useState(false);
  const add = trpc.valuedAssets.addValuation.useMutation({
    onSuccess: async () => {
      setAdding(false);
      await Promise.all([
        utils.valuedAssets.history.invalidate({ holdingId }),
        utils.holdings.getWithDetails.invalidate(),
      ]);
    },
  });

  if (!history.data) return null;
  const currency = history.data.currencyCode;
  return (
    <div className="flex flex-col gap-4">
      <ValuedAssetDetailsView history={history.data} locale={getFormatLocale().numberLocale} />
      <Button variant="outline" onClick={() => setAdding(true)}>
        {t('v3.valuedAssets.addValuation.action')}
      </Button>
      {adding ? (
        <AddValuationSheet
          currency={currency}
          isSaving={add.isPending}
          error={add.error?.message ?? null}
          onOpenChange={setAdding}
          onSubmit={(draft) =>
            add.mutate({
              valuation: {
                holdingId,
                occurredOn: serverDay(draft.date, todayIso()),
                value: draft.value,
              },
            })
          }
        />
      ) : null}
    </div>
  );
}

function AddValuationSheet({
  currency,
  isSaving,
  error,
  onOpenChange,
  onSubmit,
}: {
  currency: string;
  isSaving: boolean;
  error: string | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: { value: string; date: string }) => void;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState('');
  const [date, setDate] = useState(todayIso());
  const blockers = [
    ...(parsePositivePrice(value) === null
      ? [t('v3.valuedAssets.addValuation.blocker.value')]
      : []),
    ...(date === '' ? [t('v3.valuedAssets.addValuation.blocker.date')] : []),
  ];
  return (
    <FormSheet
      open
      onOpenChange={onOpenChange}
      title={t('v3.valuedAssets.addValuation.title')}
      description={t('v3.valuedAssets.addValuation.description')}
      footer={
        <FormActions
          submitLabel={t('v3.valuedAssets.addValuation.save')}
          pendingLabel={t('v3.valuedAssets.addValuation.saving')}
          onSubmit={() => {
            if (blockers.length === 0) onSubmit({ value, date });
          }}
          onCancel={() => onOpenChange(false)}
          blockers={blockers}
          pending={isSaving}
          error={error}
        />
      }
    >
      <div className="flex flex-col gap-4">
        <Field
          label={t('v3.valuedAssets.addValuation.valueLabel', { currency })}
          htmlFor="valued-asset-value"
        >
          <AmountInput
            id="valued-asset-value"
            value={value}
            onValueChange={setValue}
            decimalScale={2}
            className="text-body"
            disabled={isSaving}
            autoFocus
          />
        </Field>
        <Field label={t('v3.valuedAssets.addValuation.dateLabel')} htmlFor="valued-asset-date">
          <DateField id="valued-asset-date" value={date} onChange={setDate} />
        </Field>
      </div>
    </FormSheet>
  );
}
