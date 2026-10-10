import { useDocumentTitle } from '@scani/ui/hooks/useDocumentTitle';
import { Input } from '@scani/ui/ui/input';
import { Segmented, SegmentedItem } from '@scani/ui/ui/segmented';
import { AmountInput } from '@scani/ui/v3/components/AmountInput';
import { Block } from '@scani/ui/v3/components/Block';
import { PageLayout } from '@scani/ui/v3/components/PageLayout';
import { describeQueryError } from '@scani/ui/v3/lib/errors';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { trpc } from '@/lib/trpc';
import { CaptureHeader } from '../components/capture/CaptureHeader';
import { CaptureSubmit } from '../components/capture/CaptureSubmit';
import { DateField, todayIso } from '../components/form/DateField';
import { FiatCurrencyField } from '../components/form/FiatCurrencyField';
import { Field, FieldRow, FieldSet } from '../components/form/Field';
import { currencyIdForSymbol, currencySymbolForId } from '../lib/custom-tokens';
import { V3_ROUTES } from '../lib/routes';
import { V3_BASE } from '../lib/ui-version';
import {
  buildValuedAssetCreate,
  emptyValuedAssetDraft,
  serverDay,
  type ValuedAssetDraft,
  type ValuedAssetKind,
} from '../lib/valued-assets';

/**
 * Add a property or vehicle (SC-1643): what it is, when it was bought and for
 * how much, and optionally what it is worth today. The same frame as every
 * capture page — a header with the way out, a `Block` per section, and a
 * submit that names what is missing.
 */
export function ValuedAssetPage() {
  const { t } = useTranslation();
  useDocumentTitle(t('v3.valuedAssets.title'));
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const baseCurrency = trpc.users.getBaseCurrency.useQuery();
  const currencies = trpc.users.getSupportedCurrencies.useQuery();
  const list = currencies.data ?? [];

  const [draft, setDraft] = useState<ValuedAssetDraft>(emptyValuedAssetDraft(''));
  const [currencyId, setCurrencyId] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const set =
    <K extends keyof ValuedAssetDraft>(key: K) =>
    (value: ValuedAssetDraft[K]) =>
      setDraft((current) => ({ ...current, [key]: value }));

  const defaultCurrencyId = baseCurrency.data?.id ?? currencyIdForSymbol(list, 'USD');
  useEffect(() => {
    if (!currencyId && defaultCurrencyId) setCurrencyId(defaultCurrencyId);
  }, [currencyId, defaultCurrencyId]);

  const currencyCode = currencySymbolForId(list, currencyId) ?? '';
  const { payload, blockers } = buildValuedAssetCreate({ ...draft, currencyCode }, t);

  const create = trpc.valuedAssets.create.useMutation({
    onSuccess: async () => {
      await utils.holdings.getWithDetails.invalidate();
      navigate(V3_ROUTES.holdings, { replace: true });
    },
    onError: (error) => {
      const copy = describeQueryError(error, t('v3.valuedAssets.subject'), 'create');
      setFailure(`${copy.title}. ${copy.detail}`);
    },
  });

  const submit = () => {
    if (!payload) return;
    setFailure(null);
    create.mutate({
      asset: { ...payload, purchaseDate: serverDay(payload.purchaseDate, todayIso()) },
    });
  };

  const text = (key: keyof ValuedAssetDraft, id: string, label: string, inputMode?: 'numeric') => (
    <Field label={label} htmlFor={id}>
      <Input
        id={id}
        value={draft[key]}
        inputMode={inputMode}
        onChange={(event) => set(key)(event.target.value as never)}
        disabled={create.isPending}
      />
    </Field>
  );

  return (
    <PageLayout>
      <CaptureHeader
        title={t('v3.valuedAssets.title')}
        description={t('v3.valuedAssets.description')}
      />

      <Block>
        <FieldSet title={t('v3.valuedAssets.whatFieldset')}>
          <Field label={t('v3.valuedAssets.kind.label')}>
            <Segmented
              value={draft.kind}
              onValueChange={(next) => set('kind')(next as ValuedAssetKind)}
              aria-label={t('v3.valuedAssets.kind.label')}
            >
              <SegmentedItem value="property">{t('v3.valuedAssets.kind.property')}</SegmentedItem>
              <SegmentedItem value="vehicle">{t('v3.valuedAssets.kind.vehicle')}</SegmentedItem>
            </Segmented>
          </Field>
          {text('name', 'valued-asset-name', t('v3.valuedAssets.nameLabel'))}
          {draft.kind === 'property' ? (
            <FieldRow>
              {text('address', 'valued-asset-address', t('v3.valuedAssets.addressLabel'))}
              {text('areaSqm', 'valued-asset-area', t('v3.valuedAssets.areaLabel'), 'numeric')}
            </FieldRow>
          ) : (
            <>
              <FieldRow>
                {text('make', 'valued-asset-make', t('v3.valuedAssets.makeLabel'))}
                {text('model', 'valued-asset-model', t('v3.valuedAssets.modelLabel'))}
              </FieldRow>
              <FieldRow>
                {text('year', 'valued-asset-year', t('v3.valuedAssets.yearLabel'), 'numeric')}
                {text(
                  'mileageKm',
                  'valued-asset-mileage',
                  t('v3.valuedAssets.mileageLabel'),
                  'numeric'
                )}
              </FieldRow>
            </>
          )}
        </FieldSet>
      </Block>

      <Block>
        <FieldSet title={t('v3.valuedAssets.valueFieldset')}>
          <Field label={t('v3.form.fiatCurrency.label')} htmlFor="valued-asset-currency">
            <FiatCurrencyField
              id="valued-asset-currency"
              value={currencyId}
              onChange={setCurrencyId}
              compact
            />
          </Field>
          <FieldRow>
            <Field label={t('v3.valuedAssets.purchaseDateLabel')} htmlFor="valued-asset-bought">
              <DateField
                id="valued-asset-bought"
                value={draft.purchaseDate}
                onChange={set('purchaseDate')}
              />
            </Field>
            <Field
              label={t('v3.valuedAssets.purchasePriceLabel', { currency: currencyCode })}
              htmlFor="valued-asset-price"
            >
              <AmountInput
                id="valued-asset-price"
                value={draft.purchasePrice}
                onValueChange={set('purchasePrice')}
                decimalScale={2}
                className="text-body"
                disabled={create.isPending}
              />
            </Field>
          </FieldRow>
          <Field
            label={t('v3.valuedAssets.currentValueLabel', { currency: currencyCode })}
            hint={t('v3.valuedAssets.currentValueHint')}
            htmlFor="valued-asset-current"
          >
            <AmountInput
              id="valued-asset-current"
              value={draft.currentValue}
              onValueChange={set('currentValue')}
              decimalScale={2}
              className="text-body"
              disabled={create.isPending}
            />
          </Field>
        </FieldSet>
      </Block>

      <CaptureSubmit
        label={t('v3.valuedAssets.save')}
        blockers={blockers}
        onSubmit={submit}
        stage={create.isPending ? 'enqueue' : null}
        busyLabel={t('v3.valuedAssets.saving')}
        cancelTo={V3_BASE}
        error={failure}
      />
    </PageLayout>
  );
}
